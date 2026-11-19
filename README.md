# Boston Transit Reliability Explorer: Blue Line Replay

Replay a historical Blue Line commute. Pick a station, direction and day. A countdown sign, a strip
map with moving trains, and a timeline show the published schedule, a **day-ahead forecast with an
80% range**, and, once the replay clock reaches it, the arrival MBTA actually recorded.

Live: **https://mbta.sharmajai.com** · Unofficial, not affiliated with the MBTA.

## Research question

Can a small tabular model beat station-level historical delay estimates on later weeks, while
giving ranges that are both honest (about 80% coverage) and useful (not absurdly wide)?

## Results (test weeks Jun 8 – Jul 5 2026, scored once)

| System | MAE (min) | Coverage | Mean width (min) | Interval score |
| --- | ---: | ---: | ---: | ---: |
| Scheduled arrival | 9.36 | — | — | — |
| Historical baseline | 9.00 | 72.9% | 21.4 | 57.9 |
| LightGBM uncalibrated | 8.96 | 73.0% | 20.9 | 58.1 |
| **LightGBM calibrated** | **8.96** | **75.4%** | 21.5 | 57.9 |
| LightGBM + history, calibrated* | 9.02 | 75.4% | 20.8 | 57.0 |

75,092 recorded arrivals out of 104,685 eligible scheduled arrivals (71.7%). Three test days are
empty in MBTA's source files.

**What this says.** Calibrated LightGBM met both criteria set before scoring (lower MAE than the
historical baseline, coverage within 75–85%). Its MAE advantage is within noise, though: the
day-resampled 95% interval for the difference is −0.10 to +0.03 min. Both systems beat the raw
schedule. Calibration moved coverage from 73% to 75% by widening each side of the range by 19
seconds. Coverage drops sharply in the last test week, when service ran far behind schedule.

The ranges are wide because delay against a *specific scheduled trip* has a heavy tail on a
headway-run line. In the test weeks 10% of arrivals were 24+ minutes behind their trip's
schedule, and the spread already exists at the first stop. See the Method page.

\* History features are a retrospective sensitivity check. MBTA regenerated its LAMP archive on
2026-10-22, so the as-of contents cannot be verified.

## How it works

```
LAMP daily Parquet ─┐                ┌─ planned_events ─┐
                    ├─ fetch (sha256) ┤                  ├─ joined_events → features → LightGBM q10/q50/q90
GTFS archive zips ──┘                └─ observations ───┘                          → conformal calibration
                                                                                   → test evaluation
                                                         static release (JSON) ← export
                                                                 │
                                         React + MapLibre site (mbta.sharmajai.com) · FastAPI (optional)
```

* **Forecast origin**: 8 PM Boston time the day before. No same-day observations are used.
* **Target**: recorded arrival minus scheduled arrival, in seconds (negative = early).
* **Splits**: train Jul 7 2025 – Mar 22 2026 · validation Mar 30 – Apr 26 · calibration May 4 – 31 ·
  test Jun 8 – Jul 5, with one-week embargoes between blocks.
* **Interval**: split conformalized quantile regression (Romano, Patterson & Candès 2019),
  reported empirically by station and week.

## Run it

```bash
make bootstrap          # uv + npm
make fetch              # ~1.2 GB: 370 LAMP days + 122 schedule versions (idempotent)
make build-data train calibrate evaluate export
make dev                # http://localhost:5173
make serve              # FastAPI + built site on http://localhost:8000
make verify             # pytest, ruff, tsc
```

API (same contract as the static JSON): `GET /v1/release`, `/v1/stations`,
`/v1/replay?station_id=place-aqucl&direction_id=0&service_date=2026-06-19`, `/v1/metrics`, `/healthz`.

Deployment: see [docs/DEPLOY.md](docs/DEPLOY.md).

## Repository

```
app/api/          FastAPI read-only service
app/web/          React + TypeScript + Vite + MapLibre site; public/api/v1 = the bundled release
pipeline/sql/     roster and join SQL (DuckDB)
pipeline/transit/ fetch, build, model (train/calibrate/evaluate), export
configs/          date splits, LightGBM settings, release criteria
tests/            DST / 25:00 times / join / metric / API contract tests
```

## Sources

* MBTA LAMP subway performance data: https://performancedata.mbta.com/
* MBTA GTFS archive: https://cdn.mbta.com/archive/archived_feeds.txt
* Romano, Patterson, Candès (2019), *Conformalized Quantile Regression*, NeurIPS.
* Gibbs, Candès (2021), *Adaptive Conformal Inference Under Distribution Shift*, NeurIPS.
* Probabilistic transit travel-time research, Transportation Research Part C (2026).
* Basemap © OpenStreetMap contributors via OpenFreeMap.
