"""Build curated tables in data/curated/transit.duckdb.

Tables: date_feed, planned_events, observations, joined_events, data_quality, features.
Fails loudly on missing columns, duplicate final keys or a many-to-many join.
"""

from __future__ import annotations

import csv
import datetime as dt
import json
import re

import duckdb
import pyarrow.parquet as pq

from .config import bucket_case_sql, data_config
from .db import df, q
from .paths import CURATED, RAW, RAW_GTFS, RAW_LAMP, SQL

DB = CURATED / "transit.duckdb"
REQUIRED_LAMP = {"service_date", "route_id", "trip_id", "stop_id", "stop_sequence",
                 "direction_id", "stop_timestamp", "scheduled_arrival_time", "parent_station"}
_PUB = re.compile(r"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2})")


def _feeds() -> list[dict]:
    manifest = json.loads((RAW / "manifest.json").read_text())
    have = set(manifest["gtfs"])
    feeds = []
    with (RAW / "gtfs_archive_index.csv").open() as f:
        for r in csv.DictReader(f):
            if r["feed_start_date"] not in have:
                continue
            m = _PUB.search(r["feed_version"])
            feeds.append({
                "feed_key": r["feed_start_date"],
                "start": dt.datetime.strptime(r["feed_start_date"], "%Y%m%d").date(),
                "end": dt.datetime.strptime(r["feed_end_date"], "%Y%m%d").date(),
                "published_at": m.group(1) if m else None,
                "feed_version": r["feed_version"],
            })
    return feeds


def _date_feed(dates: list[dt.date], feeds: list[dict]) -> list[tuple]:
    """For each service date pick the most recent archived feed whose window covers it."""
    rows = []
    for d in dates:
        cands = [f for f in feeds if f["start"] <= d <= f["end"]]
        if not cands:
            rows.append((d, None, None, None))
            continue
        f = max(cands, key=lambda f: (f["start"], f["published_at"] or ""))
        rows.append((d, f["feed_key"], f["published_at"], f["feed_version"]))
    return rows


def _load_gtfs(con: duckdb.DuckDBPyConnection, keys: list[str]) -> None:
    for table in ("calendar", "calendar_dates", "trips", "stop_times", "stops"):
        parts = []
        for k in keys:
            p = RAW_GTFS / k / f"{table}.txt"
            if p.exists() and p.stat().st_size > 0:
                parts.append(f"SELECT '{k}' AS feed_key, * FROM read_csv('{p}', all_varchar=true,"
                             " header=true, union_by_name=true)")
        q(con, f"CREATE OR REPLACE TEMP TABLE g_{table} AS "
                    + " UNION ALL BY NAME ".join(parts))
    # calendar_dates may be absent in a feed; make sure the table exists with columns we use
    cols = {r[0] for r in q(con, "DESCRIBE g_calendar_dates")}
    assert {"service_id", "date", "exception_type"} <= cols, cols


def build() -> None:
    cfg = data_config()
    lo = cfg["history_start"]
    hi = cfg["splits"]["test"][1]
    files = sorted(p for p in RAW_LAMP.glob("*.parquet")
                   if lo <= dt.date.fromisoformat(p.stem) <= hi)
    dates = [dt.date.fromisoformat(p.stem) for p in files]
    feeds = _feeds()
    df_rows = _date_feed(dates, feeds)
    missing = [d for d, k, *_ in df_rows if k is None]
    if missing:
        print(f"warning: {len(missing)} dates have no archived feed, e.g. {missing[:3]}")

    DB.unlink(missing_ok=True)
    con = duckdb.connect(str(DB))
    q(con, "SET TimeZone='UTC'")
    q(con, """CREATE TABLE date_feed(service_date DATE, feed_key VARCHAR,
                   schedule_published_at TIMESTAMPTZ, feed_version VARCHAR)""")
    con.executemany("INSERT INTO date_feed VALUES (?, ?, ?, ?)",
                    [r for r in df_rows if r[1] is not None]).fetchall()
    q(con, """ALTER TABLE date_feed ADD COLUMN forecast_origin TIMESTAMPTZ;
        UPDATE date_feed SET forecast_origin =
          timezone('America/New_York', (service_date - INTERVAL 1 DAY)::TIMESTAMP
                   + INTERVAL 20 HOUR);
        ALTER TABLE date_feed ADD COLUMN schedule_after_origin BOOLEAN;
        UPDATE date_feed SET schedule_after_origin = schedule_published_at > forecast_origin;""")

    _load_gtfs(con, sorted({r[1] for r in df_rows if r[1]}))

    lamp_glob = [str(p) for p in files]
    q(con, f"CREATE TEMP TABLE lamp_raw AS SELECT * FROM read_parquet({lamp_glob}, "
                "union_by_name=true) WHERE route_id = 'Blue'")
    cols = {r[0] for r in q(con, "DESCRIBE lamp_raw")}
    if REQUIRED_LAMP - cols:
        raise SystemExit(f"LAMP files missing columns: {REQUIRED_LAMP - cols}")

    q(con, (SQL / "planned_events.sql").read_text())
    dup = q(con, """SELECT count(*) FROM (SELECT service_date, trip_id, stop_id,
        stop_sequence FROM planned_events GROUP BY ALL HAVING count(*) > 1)""")[0][0]
    if dup:
        raise SystemExit(f"{dup} duplicate planned event keys")

    empty = [(dt.date.fromisoformat(p.stem),) for p in files
             if pq.read_metadata(p).num_rows == 0]
    q(con, "CREATE TEMP TABLE lamp_empty_days(service_date DATE)")
    if empty:
        con.executemany("INSERT INTO lamp_empty_days VALUES (?)", empty).fetchall()
        print(f"{len(empty)} LAMP files are empty (source gaps): {[d for (d,) in empty][:10]}")
    q(con, (SQL / "joined_events.sql").read_text())
    n_planned = q(con, "SELECT count(*) FROM planned_events")[0][0]
    n_joined = q(con, "SELECT count(*) FROM joined_events")[0][0]
    if n_planned != n_joined:
        raise SystemExit(f"many-to-many join: {n_planned} planned vs {n_joined} joined")

    _features(con, cfg)
    _summary(con)
    con.close()


def _features(con: duckdb.DuckDBPyConnection, cfg: dict) -> None:
    lag = cfg["history_lag_days"]
    hour = "(scheduled_offset_s / 3600.0)"
    splits = " ".join(f"WHEN service_date BETWEEN DATE '{a}' AND DATE '{b}' THEN '{n}'"
                      for n, (a, b) in cfg["splits"].items())
    q(con, f"""
    CREATE OR REPLACE TABLE base AS
    SELECT j.*,
        CASE {splits} END AS split,
        df.forecast_origin, df.schedule_published_at, df.schedule_after_origin,
        dayofweek(j.service_date) AS weekday,
        dayofweek(j.service_date) IN (0, 6) AS is_weekend,
        {hour} AS sched_hour,
        sin(2 * pi() * {hour} / 24) AS tod_sin,
        cos(2 * pi() * {hour} / 24) AS tod_cos,
        {bucket_case_sql(hour)} AS time_bucket,
        scheduled_epoch - lag(scheduled_epoch) OVER (
            PARTITION BY j.service_date, j.stop_id ORDER BY scheduled_epoch, trip_id)
            AS sched_gap_s,
        count(DISTINCT trip_id) OVER (PARTITION BY j.service_date, j.direction_id)
            AS day_planned_trips
    FROM joined_events j JOIN date_feed df USING (service_date)
    """)
    # History: same platform, direction and time bucket; dates up to D-lag only.
    q(con, f"""
    CREATE OR REPLACE TABLE history AS
    WITH keys AS (SELECT DISTINCT service_date, stop_id, time_bucket FROM base),
    obs AS (SELECT service_date, stop_id, time_bucket, delay_s FROM base
            WHERE observation_status = 'observed')
    SELECT k.service_date, k.stop_id, k.time_bucket,
        median(o.delay_s) FILTER (WHERE o.service_date >= k.service_date - {lag + 6})
            AS hist7_median_s,
        median(o.delay_s) AS hist28_median_s,
        quantile_cont(o.delay_s, 0.9) AS hist28_p90_s,
        count(o.delay_s) AS hist28_count,
        max(o.service_date) AS hist_latest_date
    FROM keys k
    LEFT JOIN obs o ON o.stop_id = k.stop_id AND o.time_bucket = k.time_bucket
        AND o.service_date BETWEEN k.service_date - {lag + 27} AND k.service_date - {lag}
    GROUP BY ALL
    """)
    q(con, """
    CREATE OR REPLACE TABLE features AS
    SELECT b.*, h.hist7_median_s, h.hist28_median_s, h.hist28_p90_s,
           coalesce(h.hist28_count, 0) AS hist28_count,
           coalesce(h.hist28_count, 0) < 20 AS hist_missing,
           h.hist_latest_date
    FROM base b LEFT JOIN history h USING (service_date, stop_id, time_bucket)
    """)
    # Availability assertion: every history input precedes the forecast origin date.
    bad = q(con, """SELECT count(*) FROM features
        WHERE hist_latest_date IS NOT NULL AND hist_latest_date >= service_date - 1""")[0][0]
    if bad:
        raise SystemExit(f"{bad} rows use history on or after D-1")


def _summary(con: duckdb.DuckDBPyConnection) -> None:
    print(df(con, """SELECT split, count(*) events,
        round(avg((observation_status = 'observed')::INT), 3) match_rate,
        count(DISTINCT service_date) n_days,
        round(median(delay_s) FILTER (WHERE observation_status='observed') / 60, 2) med_delay_min
        FROM features GROUP BY ALL ORDER BY min(service_date)"""))
    print(df(con, """SELECT observation_status, count(*) FROM joined_events GROUP BY ALL
        ORDER BY 2 DESC"""))
    print(df(con, """SELECT round(avg(schedule_after_origin::INT), 3) AS share_schedule_after_origin
        FROM date_feed"""))


if __name__ == "__main__":
    build()
