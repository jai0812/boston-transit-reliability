"""Scheduled roster + join SQL on a tiny generated GTFS fixture."""

import datetime as dt

import duckdb
import pytest

from pipeline.transit.paths import SQL


def _con(dates):
    con = duckdb.connect()
    con.execute("SET TimeZone='UTC'")
    con.execute("CREATE TABLE date_feed(service_date DATE, feed_key VARCHAR)")
    con.executemany("INSERT INTO date_feed VALUES (?, 'f1')", [(d,) for d in dates]).fetchall()
    con.execute("""CREATE TEMP TABLE g_calendar AS SELECT * FROM (VALUES
        ('f1','WK','1','1','1','1','1','1','1','20250101','20271231')) t(feed_key, service_id,
        monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date)""")
    con.execute("""CREATE TEMP TABLE g_calendar_dates AS SELECT * FROM (VALUES
        ('f1','WK','20260704','2')) t(feed_key, service_id, date, exception_type)""")
    con.execute("""CREATE TEMP TABLE g_trips AS SELECT * FROM (VALUES
        ('f1','Blue','WK','T1','1','Wonderland'),
        ('f1','Red','WK','R1','0','Ashmont')) t(feed_key, route_id, service_id, trip_id,
        direction_id, trip_headsign)""")
    con.execute("""CREATE TEMP TABLE g_stop_times AS SELECT * FROM (VALUES
        ('f1','T1','70038','1','07:58:00'),
        ('f1','T1','70040','2','08:00:00'),
        ('f1','T1','70042','3','25:10:00'),
        ('f1','R1','70061','2','08:00:00')) t(feed_key, trip_id, stop_id, stop_sequence,
        arrival_time)""")
    con.execute("""CREATE TEMP TABLE g_stops AS SELECT * FROM (VALUES
        ('f1','70040','place-gover'), ('f1','70042','place-state'),
        ('f1','70038','place-bomnl')) t(feed_key, stop_id, parent_station)""")
    con.execute("CREATE TABLE line_routes AS SELECT 'Blue' AS route_id, 'Blue' AS line_id")
    con.execute((SQL / "planned_events.sql").read_text())
    return con


def _utc(con, d, stop):
    ep = con.execute("SELECT scheduled_epoch FROM planned_events WHERE service_date=? "
                     "AND stop_id=?", [d, stop]).fetchall()[0][0]
    return dt.datetime.fromtimestamp(ep, dt.UTC)


@pytest.mark.parametrize("day,expected", [
    (dt.date(2026, 3, 8), dt.datetime(2026, 3, 8, 12, 0, tzinfo=dt.UTC)),    # spring forward: 8:00 EDT
    (dt.date(2025, 11, 2), dt.datetime(2025, 11, 2, 13, 0, tzinfo=dt.UTC)),  # fall back: 8:00 EST
    (dt.date(2026, 6, 9), dt.datetime(2026, 6, 9, 12, 0, tzinfo=dt.UTC)),
])
def test_dst_days_use_noon_minus_12h(day, expected):
    con = _con([day])
    assert _utc(con, day, "70040") == expected


def test_after_midnight_time_lands_next_calendar_day():
    d = dt.date(2026, 6, 9)
    con = _con([d])
    # 25:10:00 on June 9 is 01:10 EDT on June 10 = 05:10 UTC
    assert _utc(con, d, "70042") == dt.datetime(2026, 6, 10, 5, 10, tzinfo=dt.UTC)
    off = con.execute("SELECT scheduled_offset_s FROM planned_events WHERE stop_id='70042'").fetchall()
    assert off == [(25 * 3600 + 600,)]


def test_origin_terminal_and_other_routes_are_excluded():
    con = _con([dt.date(2026, 6, 9)])
    stops = {r[0] for r in con.execute("SELECT stop_id FROM planned_events").fetchall()}
    assert stops == {"70040", "70042"}


def test_calendar_removal_drops_service():
    con = _con([dt.date(2026, 7, 4)])
    assert con.execute("SELECT count(*) FROM planned_events").fetchall() == [(0,)]


def _join(con, lamp_rows, empty_days=()):
    con.execute("""CREATE OR REPLACE TEMP TABLE lamp_raw(service_date INT, route_id VARCHAR,
        trip_id VARCHAR, stop_id VARCHAR, stop_sequence SMALLINT, direction_id BOOLEAN,
        parent_station VARCHAR, stop_timestamp BIGINT, scheduled_arrival_time BIGINT,
        vehicle_label VARCHAR, branch_route_id VARCHAR)""")
    if lamp_rows:
        con.executemany("INSERT INTO lamp_raw VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                        [r + (None,) for r in lamp_rows]).fetchall()
    con.execute("CREATE OR REPLACE TEMP TABLE lamp_empty_days(service_date DATE)")
    for d in empty_days:
        con.execute("INSERT INTO lamp_empty_days VALUES (?)", [d])
    con.execute((SQL / "joined_events.sql").read_text())
    return {r[0]: (r[1], r[2]) for r in con.execute(
        "SELECT stop_id, observation_status, delay_s FROM joined_events").fetchall()}


def test_left_join_keeps_unobserved_and_signs_delay():
    d = dt.date(2026, 6, 9)
    con = _con([d])
    sched = int(dt.datetime(2026, 6, 9, 12, 0, tzinfo=dt.UTC).timestamp())
    out = _join(con, [
        (20260609, "Blue", "T1", "70040", 2, True, "place-gover", sched - 45, 8 * 3600, "0700"),
        # duplicate row for the same key keeps the earliest timestamp
        (20260609, "Blue", "T1", "70040", 2, True, "place-gover", sched + 300, 8 * 3600, "0700"),
        (20260609, "Blue", "ADDED-1", "70040", 2, True, "place-gover", sched, None, "0701"),
    ])
    assert out["70040"] == ("observed", -45)          # early arrival -> negative delay
    assert out["70042"] == ("unobserved", None)       # no telemetry stays visible
    assert con.execute("SELECT count(*) FROM joined_events").fetchall() == [(2,)]
    assert con.execute("SELECT count(*) FROM observation_dupes").fetchall() == [(1,)]


def test_milliseconds_are_normalised_and_conflicts_quarantined():
    d = dt.date(2026, 6, 9)
    con = _con([d])
    sched = int(dt.datetime(2026, 6, 9, 12, 0, tzinfo=dt.UTC).timestamp())
    out = _join(con, [
        (20260609, "Blue", "T1", "70040", 2, True, "place-gover", (sched + 60) * 1000, 8 * 3600, "x"),
        (20260609, "Blue", "T1", "70042", 3, True, "place-state", sched, 9 * 3600, "x"),
    ])
    assert out["70040"] == ("observed", 60)
    assert out["70042"][0] == "conflict_schedule"


def test_empty_source_day_is_a_gap_not_a_miss():
    d = dt.date(2026, 6, 9)
    con = _con([d])
    out = _join(con, [], empty_days=[d])
    assert {v[0] for v in out.values()} == {"source_gap"}
