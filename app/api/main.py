"""Read-only API over a replay release (same contract as the static site's JSON).

    uvicorn app.api.main:app --reload            # serves /v1/* and the built frontend

The release directory comes from RELEASE_DIR (default: app/web/public/api/v1).
"""

from __future__ import annotations

import datetime as dt
import json
import os
from functools import lru_cache
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, HTTPException, Query, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

ROOT = Path(__file__).resolve().parents[2]
RELEASE_DIR = Path(os.environ.get("RELEASE_DIR", ROOT / "app" / "web" / "public" / "api" / "v1"))
WEB_DIST = ROOT / "app" / "web" / "dist"

app = FastAPI(title="Boston Transit Reliability Explorer", version="1.0",
              description="Historical subway replay (Blue, Red, Green): schedule, "
                          "day-ahead forecast and recorded arrival.")


@lru_cache
def _read(name: str) -> dict:
    p = RELEASE_DIR / name
    if not p.exists():
        raise HTTPException(503, f"release file {name} is not available")
    return json.loads(p.read_text())


def _release() -> dict:
    return _read("release.json")


class ReplayItem(BaseModel):
    event_id: str
    trip_id: str
    stop_id: str
    headsign: str
    scheduled_at: dt.datetime
    forecast_origin_at: dt.datetime
    predicted_p50_at: dt.datetime | None
    interval_lower_at: dt.datetime | None
    interval_upper_at: dt.datetime | None
    observed_at: dt.datetime | None
    observation_status: str
    estimate_status: Literal["available", "missing"]


class ReplayResponse(BaseModel):
    release_id: str
    model_id: str
    nominal_coverage: float
    timezone: str
    line: str
    service_date: dt.date
    station_id: str
    direction_id: int
    count: int
    note: str | None = None
    items: list[ReplayItem]


@app.get("/healthz")
def healthz():
    r = _release()
    return {"status": "ok", "release_id": r["release_id"]}


@app.get("/v1/release")
def release(response: Response):
    r = _release()
    response.headers["ETag"] = f'"{r["release_id"]}"'
    return r


LineId = Query("Blue", pattern=r"^[A-Za-z]+$", max_length=20)


def _line(line: str) -> dict:
    meta = next((x for x in _release()["lines"] if x["id"] == line), None)
    if meta is None:
        raise HTTPException(404, f"line {line} is not in this release")
    return meta


@app.get("/v1/lines")
def lines():
    return [{k: v for k, v in x.items() if k not in ("replay_dates", "presets")}
            for x in _release()["lines"]]


@app.get("/v1/stations")
def stations(line: str = LineId):
    _line(line)
    return _read(f"lines/{line}/stations.json")


@app.get("/v1/metrics")
def metrics(line: str = LineId, model: str = Query("lgbm_schedule_cal"),
            segment: str = Query("all")):
    _line(line)
    m = _read(f"lines/{line}/metrics.json")
    if model not in m["results"]:
        raise HTTPException(404, f"unknown model {model}; choose from {sorted(m['results'])}")
    if segment not in m["results"][model]:
        raise HTTPException(404, f"unknown segment {segment}")
    return {"line": line, "model": model, "label": m["systems"][model], "segment": segment,
            "result": m["results"][model][segment], "counts": m["counts"],
            "decision": m["decision"]}


def _ts(base: int, off: int | None) -> dt.datetime | None:
    return None if off is None else dt.datetime.fromtimestamp(base + off, dt.UTC)


@app.get("/v1/replay", response_model=ReplayResponse)
def replay(response: Response,
           line: str = LineId,
           station_id: str = Query(..., min_length=3, max_length=40, pattern=r"^[a-z0-9-]+$"),
           direction_id: int = Query(..., ge=0, le=1),
           service_date: dt.date = Query(...)):
    rel = _release()
    meta = _line(line)
    st = next((s for s in _read(f"lines/{line}/stations.json")["stations"]
               if s["id"] == station_id), None)
    if st is None:
        raise HTTPException(404, f"station {station_id} is not on the {line} line")
    dates = {d["service_date"]: d for d in meta["replay_dates"]}
    if service_date.isoformat() not in dates:
        raise HTTPException(404, f"{service_date} is outside this release")
    wanted = {p["stop_id"] for p in st["platforms"] if p["dir"] == direction_id}
    r = _read(f"lines/{line}/replay/{service_date.isoformat()}.json")
    e, trips, base = r["events"], r["trips"], r["base_epoch"]
    plats = r["platforms"]["stop_id"]
    origin = dt.datetime.fromisoformat(r["forecast_origin_at"])
    items = []
    for i, pi in enumerate(e["plat"]):
        stop = plats[pi]
        if stop not in wanted:
            continue
        s = e["sched"][i]
        def rel_(d, s=s):
            return None if d is None else s + d

        p50 = rel_(e["m_p50"][i])
        items.append(ReplayItem(
            event_id=f"{service_date}:{trips['id'][e['trip'][i]]}:{stop}",
            trip_id=trips["id"][e["trip"][i]], stop_id=stop,
            headsign=trips["headsign"][e["trip"][i]],
            scheduled_at=_ts(base, s), forecast_origin_at=origin,
            predicted_p50_at=_ts(base, p50),
            interval_lower_at=_ts(base, rel_(e["m_lo"][i])),
            interval_upper_at=_ts(base, rel_(e["m_hi"][i])),
            observed_at=_ts(base, e["obs"][i]),
            observation_status=r["status_codes"][e["status"][i]],
            estimate_status="available" if p50 is not None else "missing",
        ))
    items.sort(key=lambda x: x.scheduled_at)
    response.headers["Cache-Control"] = "public, max-age=86400, immutable"
    response.headers["ETag"] = f'"{rel["release_id"]}:{line}:{station_id}:{direction_id}:{service_date}"'
    return ReplayResponse(
        release_id=rel["release_id"], model_id=rel["displayed_model"],
        nominal_coverage=rel["nominal_coverage"], timezone=rel["timezone"],
        line=line, service_date=service_date, station_id=station_id,
        direction_id=direction_id,
        count=len(items),
        note=None if items else "No scheduled arrivals for this station and direction "
                                "(a terminal has arrivals in one direction only).",
        items=items[:1000],
    )


# Serve the static release and the built site on the same origin when they exist.
if RELEASE_DIR.exists():
    app.mount("/api/v1", StaticFiles(directory=RELEASE_DIR), name="release")
if WEB_DIST.exists():
    app.mount("/", StaticFiles(directory=WEB_DIST, html=True), name="web")
