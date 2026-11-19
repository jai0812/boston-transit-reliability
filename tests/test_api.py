"""API contract checks against a tiny generated release."""

import importlib
import json

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client(tmp_path, monkeypatch):
    v1 = tmp_path / "v1"
    (v1 / "replay").mkdir(parents=True)
    (v1 / "release.json").write_text(json.dumps({
        "release_id": "r1", "displayed_model": "lgbm_schedule_cal", "nominal_coverage": 0.8,
        "timezone": "America/New_York",
        "replay_dates": [{"service_date": "2026-06-09"}]}))
    (v1 / "stations.json").write_text(json.dumps({"stations": [
        {"id": "place-aqucl", "platforms": {"0": "70043", "1": "70044"}},
        {"id": "place-wondl", "platforms": {"1": "70060"}}]}))
    (v1 / "metrics.json").write_text(json.dumps({
        "results": {"lgbm_schedule_cal": {"all": {"n": 1}}},
        "systems": {"lgbm_schedule_cal": "LightGBM calibrated"}, "counts": {}, "decision": {}}))
    (v1 / "replay" / "2026-06-09.json").write_text(json.dumps({
        "base_epoch": 1780977600, "forecast_origin_at": "2026-06-09T00:00:00+00:00",
        "trips": {"id": ["T1", "T2"], "dir": [0, 0], "headsign": ["Bowdoin", "Bowdoin"]},
        "status_codes": ["observed", "unobserved"],
        "events": {"trip": [1, 0], "stop": ["70043", "70043"], "sched": [30000, 28800],
                   "obs": [None, 28920], "status": [1, 0],
                   "m_p50": [None, 60], "m_lo": [None, -30], "m_hi": [None, 240],
                   "h_p50": [0, 0], "h_lo": [0, 0], "h_hi": [0, 0]}}))
    monkeypatch.setenv("RELEASE_DIR", str(v1))
    import app.api.main as m
    importlib.reload(m)
    m._read.cache_clear()
    return TestClient(m.app)


def test_health_and_release(client):
    assert client.get("/healthz").json() == {"status": "ok", "release_id": "r1"}
    assert client.get("/v1/release").headers["etag"] == '"r1"'


def test_replay_is_chronological_with_utc_and_distinct_missing_states(client):
    r = client.get("/v1/replay", params={"station_id": "place-aqucl", "direction_id": 0,
                                         "service_date": "2026-06-09"})
    assert r.status_code == 200
    body = r.json()
    assert body["count"] == 2 and body["model_id"] == "lgbm_schedule_cal"
    first, second = body["items"]
    assert first["scheduled_at"] < second["scheduled_at"]
    assert first["observed_at"].endswith("Z") or first["observed_at"].endswith("+00:00")
    assert first["estimate_status"] == "available"
    assert second["observed_at"] is None and second["estimate_status"] == "missing"
    assert second["observation_status"] == "unobserved"


def test_bad_filters(client):
    assert client.get("/v1/replay", params={"station_id": "place-aqucl", "direction_id": 3,
                                            "service_date": "2026-06-09"}).status_code == 422
    assert client.get("/v1/replay", params={"station_id": "Bad Id!", "direction_id": 0,
                                            "service_date": "2026-06-09"}).status_code == 422
    assert client.get("/v1/replay", params={"station_id": "place-nope", "direction_id": 0,
                                            "service_date": "2026-06-09"}).status_code == 404
    assert client.get("/v1/replay", params={"station_id": "place-aqucl", "direction_id": 0,
                                            "service_date": "2020-01-01"}).status_code == 404


def test_terminal_wrong_direction_is_empty_with_note(client):
    r = client.get("/v1/replay", params={"station_id": "place-wondl", "direction_id": 0,
                                         "service_date": "2026-06-09"}).json()
    assert r["count"] == 0 and r["note"]
