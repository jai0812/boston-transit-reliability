"""Export an immutable, static replay release.

Writes data/release/<release_id>/v1/{release,stations,metrics}.json and
v1/replay/<date>.json for every test-window service date, then copies the release into
app/web/public/api so the static site serves it on the same origin.

Replay files are columnar. Times are seconds since the service day's GTFS base
(local noon minus 12 h); `base_epoch` turns them back into UTC.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import shutil
import subprocess

import duckdb
import numpy as np
import pandas as pd

from .config import data_config, model_config
from .model import KEY, PRED
from .paths import CURATED, MODELS, RAW, RAW_GTFS, RELEASE, ROOT

STATUS = ["observed", "unobserved", "missing_timestamp", "conflict_schedule",
          "conflict_direction", "suspicious", "source_gap"]
WEB_PUBLIC = ROOT / "app" / "web" / "public" / "api"


def _j(path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, separators=(",", ":"), default=str))


def _stations(con, feed_key: str) -> dict:
    g = RAW_GTFS / feed_key
    stops = pd.read_csv(g / "stops.txt", dtype=str)
    st = pd.read_csv(g / "stop_times.txt", dtype=str)
    trips = pd.read_csv(g / "trips.txt", dtype=str)
    shapes = pd.read_csv(g / "shapes.txt", dtype={"shape_id": str})
    # Station order from the longest eastbound (direction 1) trip.
    t1 = trips[trips.direction_id == "1"]
    lens = st[st.trip_id.isin(t1.trip_id)].groupby("trip_id").size()
    trip = lens.idxmax()
    seq = st[st.trip_id == trip].assign(s=lambda d: d.stop_sequence.astype(int)).sort_values("s")
    plat = stops.set_index("stop_id")
    order = [plat.loc[s, "parent_station"] for s in seq.stop_id]
    parents = stops.set_index("stop_id")
    platforms = pd.DataFrame(con.execute("""SELECT DISTINCT parent_station, direction_id, stop_id
        FROM planned_events""").fetchall(), columns=["parent", "dir", "stop_id"])
    out = []
    for i, pid in enumerate(order):
        p = parents.loc[pid]
        pl = platforms[platforms.parent == pid]
        out.append({
            "id": pid, "name": p.stop_name, "order": i,
            "lat": float(p.stop_lat), "lon": float(p.stop_lon),
            "platforms": {str(int(r.dir)): r.stop_id for r in pl.itertuples()},
            "directions": sorted(int(d) for d in pl.dir.unique()),
        })
    shape_id = t1[t1.trip_id == trip].shape_id.iloc[0]
    sh = shapes[shapes.shape_id == shape_id].sort_values("shape_pt_sequence")
    line = {"type": "Feature", "properties": {"route_id": "Blue", "shape_id": shape_id},
            "geometry": {"type": "LineString",
                         "coordinates": [[round(x, 6), round(y, 6)] for x, y in
                                         zip(sh.shape_pt_lon, sh.shape_pt_lat, strict=True)]}}
    return {"stations": out, "line": line,
            "directions": {"0": "Westbound to Bowdoin", "1": "Eastbound to Wonderland"}}


def export() -> None:
    cfg, mcfg = data_config(), model_config()
    metrics = json.loads((MODELS / "metrics.json").read_text())
    calib = json.loads((MODELS / "calibration.json").read_text())
    train = json.loads((MODELS / "train_report.json").read_text())
    manifest = json.loads((RAW / "manifest.json").read_text())

    con = duckdb.connect(str(CURATED / "transit.duckdb"), read_only=True)
    feat = con.execute(f"""SELECT {', '.join(KEY)}, direction_id, parent_station, trip_headsign,
        scheduled_epoch, scheduled_offset_s, observed_epoch, observation_status, delay_s,
        vehicle_label, time_bucket, split, forecast_origin, feed_key FROM features
        WHERE split = 'test' ORDER BY service_date, scheduled_epoch""").df()
    p = pd.read_parquet(PRED)
    p = p[p.split == "test"]
    feat = feat.merge(p, on=KEY + ["split"], how="left", validate="one_to_one")
    dq = con.execute("SELECT * FROM data_quality ORDER BY service_date, direction_id").df()
    date_feed = con.execute("SELECT * FROM date_feed").df()
    test_feed = date_feed[pd.to_datetime(date_feed.service_date).dt.date == cfg["splits"]["test"][0]]
    stations = _stations(con, test_feed.feed_key.iloc[0])
    con.close()

    try:
        commit = subprocess.check_output(["git", "rev-parse", "--short", "HEAD"],
                                         text=True, cwd=ROOT).strip()
    except Exception:
        commit = "uncommitted"
    input_hash = hashlib.sha256(json.dumps(
        {"lamp": {d: v["sha256"] for d, v in manifest["lamp"].items()},
         "gtfs": {k: v["zip_sha256"] for k, v in manifest["gtfs"].items()}},
        sort_keys=True).encode()).hexdigest()
    release_id = f"blue-{cfg['splits']['test'][0]}-{input_hash[:8]}"
    out = RELEASE / release_id / "v1"
    if out.parent.exists():
        shutil.rmtree(out.parent)

    featured = metrics["decision"]["featured_system"]
    feat["base_epoch"] = feat.scheduled_epoch - feat.scheduled_offset_s

    def rel(epoch_col: pd.Series, base: pd.Series):
        v = (epoch_col - base).round()
        return [None if pd.isna(x) else int(x) for x in v]

    dates = []
    presets_rows = []
    for d, g in feat.groupby("service_date"):
        d = str(pd.Timestamp(d).date())
        trips = g.drop_duplicates("trip_id")[["trip_id", "direction_id", "trip_headsign"]]
        tix = {t: i for i, t in enumerate(trips.trip_id)}
        base = g.base_epoch
        sched = g.scheduled_epoch
        rec = {
            "service_date": d, "release_id": release_id, "timezone": cfg["timezone"],
            "base_epoch": int(base.iloc[0]),
            "forecast_origin_at": pd.Timestamp(g.forecast_origin.iloc[0]).isoformat(),
            "nominal_coverage": mcfg["nominal_coverage"],
            "trips": {"id": trips.trip_id.tolist(), "dir": trips.direction_id.astype(int).tolist(),
                      "headsign": trips.trip_headsign.tolist()},
            "events": {
                "trip": [tix[t] for t in g.trip_id],
                "stop": g.stop_id.tolist(),
                "sched": rel(sched, base),
                "obs": rel(g.observed_epoch, base),
                "status": [STATUS.index(s) for s in g.observation_status],
                # model offsets are delays in seconds, added to sched client-side
                "m_p50": rel(g.lgbm_schedule_q50, 0 * base),
                "m_lo": rel(g.lgbm_schedule_cal_lo, 0 * base),
                "m_hi": rel(g.lgbm_schedule_cal_hi, 0 * base),
                "h_p50": rel(g.hist_p50, 0 * base),
                "h_lo": rel(g.hist_p10, 0 * base),
                "h_hi": rel(g.hist_p90, 0 * base),
            },
            "status_codes": STATUS,
        }
        _j(out / "replay" / f"{d}.json", rec)
        ok = g[g.observation_status == "observed"]
        dates.append({"service_date": d, "events": len(g), "observed": len(ok),
                      "source_gap": bool((g.observation_status == "source_gap").all()),
                      "weekday": pd.Timestamp(d).day_name()})
        for (st, di, bk), s in ok[ok.time_bucket.isin(["am_peak", "pm_peak"])].groupby(
                ["parent_station", "direction_id", "time_bucket"]):
            if len(s) < 20:
                continue
            y = s.delay_s.values
            cov = float(np.mean((y >= s.lgbm_schedule_cal_lo) & (y <= s.lgbm_schedule_cal_hi)))
            mae = float(np.mean(np.abs(y - s.lgbm_schedule_q50)) / 60)
            presets_rows.append({"service_date": d, "station_id": st, "direction_id": int(di),
                                 "bucket": bk, "n": len(s),
                                 "coverage": cov, "mae_min": mae,
                                 "median_delay_min": float(np.median(y) / 60),
                                 "start_offset": int(s.scheduled_offset_s.min())})
    pr = pd.DataFrame(presets_rows)
    # Rush-hour presets only make sense on weekdays with a full rush of trains.
    pr = pr[(pd.to_datetime(pr.service_date).dt.dayofweek < 5) & (pr.n >= 30)].reset_index(drop=True)
    good = pr[(pr.coverage >= 0.9)].sort_values(["mae_min"]).head(1)
    bad = pr.sort_values(["coverage", "median_delay_min"], ascending=[True, False]).head(1)
    typical = pr.iloc[(pr.coverage - 0.8).abs().argsort()].head(1)
    names = {s["id"]: s["name"] for s in stations["stations"]}

    def preset(df, kind, blurb):
        r = df.iloc[0].to_dict()
        return {**r, "kind": kind, "station_name": names[r["station_id"]], "blurb": blurb}

    presets = [
        preset(good, "handled_well", "The range held: nearly every arrival landed inside it."),
        preset(typical, "typical", "A typical rush hour, close to the 80% target."),
        preset(bad, "missed", "A bad day: trains ran far outside the forecast range."),
    ]

    release = {
        "release_id": release_id, "route_id": "Blue", "code_commit": commit,
        "generated_at": dt.datetime.now(dt.UTC).isoformat(timespec="seconds"),
        "timezone": cfg["timezone"], "forecast_origin_rule": "20:00 America/New_York, day before",
        "featured_system": featured, "displayed_model": "lgbm_schedule_cal",
        "nominal_coverage": mcfg["nominal_coverage"],
        "splits": cfg["splits"], "replay_dates": dates, "presets": presets,
        "input_sha256": input_hash,
        "inputs": {"lamp_files": len(manifest["lamp"]), "gtfs_feeds": len(manifest["gtfs"]),
                   "lamp_index": manifest["indexes"].get("lamp_index"),
                   "gtfs_archive_index": manifest["indexes"].get("gtfs_archive_index")},
        "snapshot_status": "retrospective",
        "retrospective_notes": [
            "Every archived schedule version was published after its day-ahead forecast "
            "origin, so the schedule used for a date is a retrospective reconstruction.",
            "LAMP daily files were regenerated on 2026-10-22; their earlier contents cannot "
            "be verified, so history features are a retrospective sensitivity analysis.",
        ],
        "sources": [
            {"name": "MBTA LAMP subway performance data",
             "url": "https://performancedata.mbta.com/"},
            {"name": "MBTA GTFS archive", "url": "https://cdn.mbta.com/archive/archived_feeds.txt"},
            {"name": "Map data © OpenStreetMap contributors",
             "url": "https://www.openstreetmap.org/copyright"},
        ],
        "disclaimer": "Unofficial project. Not affiliated with or endorsed by the MBTA.",
    }
    dq_out = dq.assign(service_date=dq.service_date.astype(str))
    dq_out["split"] = [next((n for n, (a, b) in cfg["splits"].items()
                             if str(a) <= s <= str(b)), None) for s in dq_out.service_date]
    met = {**metrics, "calibration": calib,
           "training": {fs: {k: v for k, v in r.items() if k != "trials"} | {
               "trials": [{"params": t["params"], "mean_val_pinball": t["mean_val_pinball"]}
                          for t in r["trials"]]}
               for fs, r in train["feature_sets"].items()},
           "training_manifest": train["training_manifest"],
           "data_quality": json.loads(dq_out.to_json(orient="records"))}
    _j(out / "release.json", release)
    _j(out / "stations.json", stations)
    _j(out / "metrics.json", met)

    if WEB_PUBLIC.exists():
        shutil.rmtree(WEB_PUBLIC)
    shutil.copytree(out, WEB_PUBLIC / "v1")
    size = sum(f.stat().st_size for f in out.rglob("*.json"))
    print(f"release {release_id}: {len(dates)} dates, {size / 1e6:.1f} MB -> {WEB_PUBLIC}")
    for pz in presets:
        print(pz)


if __name__ == "__main__":
    export()
