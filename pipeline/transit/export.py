"""Export an immutable, static replay release for every configured line.

Layout (served under /api/v1 by the static site and the FastAPI app):
  release.json                       lines, dates, presets, provenance
  metrics.json                       per-line benchmark summary
  lines/<line>/stations.json         stations, platforms, branches with geometry
  lines/<line>/metrics.json          full per-line evaluation
  lines/<line>/replay/<date>.json    columnar events for one service date

Replay times are seconds since the service day's GTFS base (local noon minus 12 h);
`base_epoch` turns them back into UTC. Model columns are delays added to `sched`.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import shutil
import subprocess
from collections import Counter

import duckdb
import numpy as np
import pandas as pd

from .config import data_config, model_config
from .model import KEY, line_dir, pred_path
from .paths import CURATED, RAW, RAW_GTFS, RELEASE, ROOT

STATUS = ["observed", "unobserved", "missing_timestamp", "conflict_schedule",
          "conflict_direction", "suspicious", "source_gap"]
WEB_PUBLIC = ROOT / "app" / "web" / "public" / "api"


def _j(path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, separators=(",", ":"), default=str))


def _ints(v: pd.Series) -> list:
    return [None if pd.isna(x) else int(round(x)) for x in v]


# ---------------------------------------------------------------- geometry and branches

def _branches(line_id: str, cfg: dict, feed_key: str) -> dict:
    """Canonical branch patterns, oriented the way the strip map reads left to right."""
    g = RAW_GTFS / feed_key
    stops = pd.read_csv(g / "stops.txt", dtype=str).set_index("stop_id")
    trips = pd.read_csv(g / "trips.txt", dtype=str)
    st = pd.read_csv(g / "stop_times.txt", dtype=str)
    shapes = pd.read_csv(g / "shapes.txt", dtype={"shape_id": str})
    line = cfg["lines"][line_id]
    orient = int(line.get("order_direction", 0))
    trips = trips[trips.route_id.isin(line["routes"])]
    st = st[st.trip_id.isin(trips.trip_id)].assign(seq=lambda d: d.stop_sequence.astype(int))
    st = st.sort_values(["trip_id", "seq"])
    parent = stops.parent_station.fillna("")

    def pid(s):
        p = parent.get(s, "")
        return p if isinstance(p, str) and p else s

    seqs = st.groupby("trip_id").stop_id.apply(lambda s: tuple(dict.fromkeys(pid(x) for x in s)))
    tinfo = trips.set_index("trip_id")
    branches = []
    for route in line["routes"]:
        rt = tinfo[tinfo.route_id == route]
        pats: Counter = Counter()
        shape_of: dict = {}
        for tid, row in rt.iterrows():
            if tid not in seqs.index:
                continue
            s = seqs[tid]
            if int(row.direction_id) != orient:
                s = tuple(reversed(s))
            pats[s] += 1
            shape_of.setdefault(s, Counter())[(row.shape_id, int(row.direction_id))] += 1
        kept: list[tuple] = []
        for s, n in sorted(pats.items(), key=lambda kv: (-len(kv[0]), -kv[1])):
            # One branch per terminal: a shorter pattern ending at the same place is a variant.
            if n < 3 or any(set(s) <= set(k) or s[-1] == k[-1] for k in kept):
                continue
            kept.append(s)
        for s in kept:
            (shape_id, sdir), _ = shape_of[s].most_common(1)[0]
            sh = shapes[shapes.shape_id == shape_id].sort_values("shape_pt_sequence")
            coords = [[round(x, 6), round(y, 6)] for x, y in
                      zip(sh.shape_pt_lon, sh.shape_pt_lat, strict=True)]
            if sdir != orient:
                coords.reverse()
            end = stops.loc[s[-1], "stop_name"] if orient == 0 else stops.loc[s[0], "stop_name"]
            letter = route.split("-")[1] if route.startswith("Green-") else None
            name = f"{letter} · {end}" if letter else (end if len(kept) > 1 or route != line_id
                                                       else line["name"])
            branches.append({"id": f"{route}:{len(branches)}", "route_id": route, "name": name,
                             "letter": letter, "stations": list(s), "shape": coords})
    names = {sid: stops.loc[sid, "stop_name"] for b in branches for sid in b["stations"]}
    coords = {sid: (float(stops.loc[sid, "stop_lon"]), float(stops.loc[sid, "stop_lat"]))
              for sid in names}
    return {"branches": branches, "names": names, "coords": coords}


def _assign_branch(stations: list[str], route: str, branches: list[dict]) -> int:
    best, score = 0, -1
    ss = set(stations)
    for i, b in enumerate(branches):
        if b["route_id"] != route:
            continue
        ov = len(ss & set(b["stations"]))
        full = ss <= set(b["stations"])
        sc = ov + (10_000 if full else 0)
        if sc > score:
            best, score = i, sc
    return best


# ---------------------------------------------------------------- export

def export() -> None:
    cfg, mcfg = data_config(), model_config()
    manifest = json.loads((RAW / "manifest.json").read_text())
    try:
        commit = subprocess.check_output(["git", "rev-parse", "--short", "HEAD"],
                                         text=True, cwd=ROOT, stderr=subprocess.DEVNULL).strip()
    except (subprocess.CalledProcessError, FileNotFoundError):
        commit = "uncommitted"
    input_hash = hashlib.sha256(json.dumps(
        {"lamp": {d: v["sha256"] for d, v in manifest["lamp"].items()},
         "gtfs": {k: v["zip_sha256"] for k, v in manifest["gtfs"].items()},
         "lines": cfg["lines"]}, sort_keys=True, default=str).encode()).hexdigest()
    release_id = f"subway-{cfg['splits']['test'][0]}-{input_hash[:8]}"
    out = RELEASE / release_id / "v1"
    if out.parent.exists():
        shutil.rmtree(out.parent)

    con = duckdb.connect(str(CURATED / "transit.duckdb"), read_only=True)
    date_feed = con.execute("SELECT * FROM date_feed").df()
    test0 = cfg["splits"]["test"][0]
    feed_key = date_feed[pd.to_datetime(date_feed.service_date).dt.date == test0].feed_key.iloc[0]
    dq = con.execute("SELECT * FROM data_quality ORDER BY service_date, line_id, direction_id").df()

    lines_out, summary, all_dates = [], {}, {}
    for line_id, line in cfg["lines"].items():
        metrics = json.loads((line_dir(line_id) / "metrics.json").read_text())
        calib = json.loads((line_dir(line_id) / "calibration.json").read_text())
        train = json.loads((line_dir(line_id) / "train_report.json").read_text())
        geo = _branches(line_id, cfg, feed_key)
        branches = geo["branches"]

        feat = con.execute(f"""SELECT {', '.join(KEY)}, route_id, direction_id, parent_station,
            trip_headsign, scheduled_epoch, scheduled_offset_s, observed_epoch,
            observation_status, delay_s, time_bucket, split, forecast_origin
            FROM features WHERE split = 'test' AND line_id = ?
            ORDER BY service_date, scheduled_epoch""", [line_id]).df()
        p = pd.read_parquet(pred_path(line_id))
        p = p[p.split == "test"]
        feat = feat.merge(p, on=KEY + ["split"], how="left", validate="one_to_one")
        feat["base_epoch"] = feat.scheduled_epoch - feat.scheduled_offset_s

        # Stations and platforms seen in the test window.
        plat = feat[["parent_station", "stop_id", "direction_id", "route_id"]].drop_duplicates()
        station_ids = list(dict.fromkeys(s for b in branches for s in b["stations"]))
        extra = [s for s in plat.parent_station.unique() if s not in station_ids]
        stations = []
        for sid in station_ids + extra:
            pl = plat[plat.parent_station == sid]
            if pl.empty and sid not in geo["names"]:
                continue
            lon, lat = geo["coords"].get(sid, (None, None))
            stations.append({
                "id": sid, "name": geo["names"].get(sid, sid), "lon": lon, "lat": lat,
                "directions": sorted(int(d) for d in pl.direction_id.unique()),
                "routes": sorted(pl.route_id.unique().tolist()),
                "platforms": [{"stop_id": r.stop_id, "dir": int(r.direction_id),
                               "route_id": r.route_id} for r in pl.itertuples()],
            })
        stations = [s for s in stations if s["lon"] is not None and s["directions"]]
        _j(out / "lines" / line_id / "stations.json", {
            "line_id": line_id, "name": line["name"], "color": line["color"],
            "directions": {str(k): v for k, v in line["directions"].items()},
            "order_direction": int(line.get("order_direction", 0)),
            "stations": stations, "branches": branches})

        dates, presets_rows = [], []
        for d, g in feat.groupby("service_date"):
            d = str(pd.Timestamp(d).date())
            trips = g.drop_duplicates("trip_id")[["trip_id", "direction_id", "trip_headsign",
                                                  "route_id"]]
            seq = g.sort_values("scheduled_epoch").groupby("trip_id").parent_station.apply(list)
            tix = {t: i for i, t in enumerate(trips.trip_id)}
            plats = sorted(g.stop_id.unique())
            pix = {s: i for i, s in enumerate(plats)}
            st_of = dict(zip(plat.stop_id, plat.parent_station, strict=False))
            sched = g.scheduled_offset_s
            rec = {
                "line_id": line_id, "service_date": d, "release_id": release_id,
                "timezone": cfg["timezone"], "base_epoch": int(g.base_epoch.iloc[0]),
                "forecast_origin_at": pd.Timestamp(g.forecast_origin.iloc[0]).isoformat(),
                "nominal_coverage": mcfg["nominal_coverage"],
                "platforms": {"stop_id": plats, "station": [st_of[s] for s in plats]},
                "trips": {"id": trips.trip_id.tolist(),
                          "dir": trips.direction_id.astype(int).tolist(),
                          "headsign": trips.trip_headsign.tolist(),
                          "route": trips.route_id.tolist(),
                          "branch": [_assign_branch(seq[t], r, branches)
                                     for t, r in zip(trips.trip_id, trips.route_id, strict=True)]},
                "events": {
                    "trip": [tix[t] for t in g.trip_id],
                    "plat": [pix[s] for s in g.stop_id],
                    "sched": _ints(sched),
                    "obs": _ints(g.observed_epoch - g.base_epoch),
                    "status": [STATUS.index(s) for s in g.observation_status],
                    "m_p50": _ints(g.lgbm_schedule_q50),
                    "m_lo": _ints(g.lgbm_schedule_cal_lo),
                    "m_hi": _ints(g.lgbm_schedule_cal_hi),
                    "h_p50": _ints(g.hist_p50),
                    "h_lo": _ints(g.hist_p10),
                    "h_hi": _ints(g.hist_p90),
                },
                "status_codes": STATUS,
            }
            _j(out / "lines" / line_id / "replay" / f"{d}.json", rec)
            ok = g[g.observation_status == "observed"]
            gap = bool((g.observation_status == "source_gap").all())
            dates.append({"service_date": d, "events": len(g), "observed": len(ok),
                          "source_gap": gap, "weekday": pd.Timestamp(d).day_name()})
            all_dates.setdefault(d, {"service_date": d, "weekday": pd.Timestamp(d).day_name(),
                                     "source_gap": gap})
            for (stn, di, bk), s in ok[ok.time_bucket.isin(["am_peak", "pm_peak"])].groupby(
                    ["parent_station", "direction_id", "time_bucket"]):
                y = s.delay_s.values
                presets_rows.append({
                    "service_date": d, "station_id": stn, "direction_id": int(di), "bucket": bk,
                    "n": len(s),
                    "coverage": float(np.mean((y >= s.lgbm_schedule_cal_lo)
                                              & (y <= s.lgbm_schedule_cal_hi))),
                    "mae_min": float(np.mean(np.abs(y - s.lgbm_schedule_q50)) / 60),
                    "median_delay_min": float(np.median(y) / 60),
                    "start_offset": int(s.scheduled_offset_s.min())})
        pr = pd.DataFrame(presets_rows)
        pr = pr[(pd.to_datetime(pr.service_date).dt.dayofweek < 5) & (pr.n >= 30)
                & pr.station_id.isin([s["id"] for s in stations])].reset_index(drop=True)
        names = {s["id"]: s["name"] for s in stations}

        def preset(df, kind, blurb, line_id=line_id, names=names):
            r = df.iloc[0].to_dict()
            return {**r, "line_id": line_id, "kind": kind,
                    "station_name": names[r["station_id"]], "blurb": blurb}

        presets = [
            preset(pr[pr.coverage >= 0.9].sort_values("mae_min").head(1), "handled_well",
                   "The range held: nearly every arrival landed inside it."),
            preset(pr.iloc[(pr.coverage - 0.8).abs().argsort()].head(1), "typical",
                   "A typical rush hour, close to the 80% target."),
            preset(pr.sort_values(["coverage", "median_delay_min"],
                                  ascending=[True, False]).head(1), "missed",
                   "A bad day: trains ran far outside the forecast range."),
        ]
        dql = dq[dq.line_id == line_id].assign(service_date=lambda x: x.service_date.astype(str))
        dql["split"] = [next((n for n, (a, b) in cfg["splits"].items()
                              if str(a) <= s <= str(b)), None) for s in dql.service_date]
        met = {**metrics, "line_id": line_id, "calibration": calib,
               "training": {fs: {k: v for k, v in r.items() if k not in ("trials", "vocab")} | {
                   "trials": [{"params": t["params"], "mean_val_pinball": t["mean_val_pinball"]}
                              for t in r["trials"]]}
                   for fs, r in train["feature_sets"].items()},
               "training_manifest": train["training_manifest"],
               "data_quality": json.loads(dql.drop(columns=["line_id"]).to_json(orient="records"))}
        _j(out / "lines" / line_id / "metrics.json", met)
        summary[line_id] = {
            "systems": metrics["systems"],
            "all": {k: v["all"] for k, v in metrics["results"].items()},
            "bootstrap": metrics["bootstrap"], "counts": metrics["counts"],
            "decision": metrics["decision"]}
        lines_out.append({
            "id": line_id, "name": line["name"], "color": line["color"], "routes": line["routes"],
            "directions": {str(k): v for k, v in line["directions"].items()},
            "featured_system": metrics["decision"]["featured_system"],
            "replay_dates": dates, "presets": presets,
            "branches": [{"id": b["id"], "name": b["name"], "letter": b["letter"]}
                         for b in branches],
            "headline": {k: metrics["results"]["lgbm_schedule_cal"]["all"].get(k)
                         for k in ("mae_min", "coverage", "width_min", "n")}})
        print(f"{line_id}: {len(stations)} stations, {len(branches)} branches "
              f"({', '.join(b['name'] for b in branches)}), {len(dates)} dates")
    con.close()

    release = {
        "release_id": release_id, "code_commit": commit,
        "generated_at": dt.datetime.now(dt.UTC).isoformat(timespec="seconds"),
        "timezone": cfg["timezone"], "forecast_origin_rule": "20:00 America/New_York, day before",
        "displayed_model": "lgbm_schedule_cal", "nominal_coverage": mcfg["nominal_coverage"],
        "splits": cfg["splits"], "lines": lines_out,
        "replay_dates": sorted(all_dates.values(), key=lambda x: x["service_date"]),
        "input_sha256": input_hash,
        "inputs": {"lamp_files": len(manifest["lamp"]), "gtfs_feeds": len(manifest["gtfs"])},
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
    _j(out / "release.json", release)
    _j(out / "metrics.json", {"lines": summary})

    if WEB_PUBLIC.exists():
        shutil.rmtree(WEB_PUBLIC)
    shutil.copytree(out, WEB_PUBLIC / "v1")
    size = sum(f.stat().st_size for f in out.rglob("*.json"))
    print(f"release {release_id}: {size / 1e6:.1f} MB -> {WEB_PUBLIC}")


if __name__ == "__main__":
    export()
