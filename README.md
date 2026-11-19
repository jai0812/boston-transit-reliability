# Boston Transit Reliability Explorer: Subway Replay

Replay a historical commute on the **Blue, Red or Green Line**. Pick a line, a station, a direction and
a day. A station sign with an amber countdown board, a network schematic, a strip map and a system map
show every train moving in replay time. A timeline compares the published schedule, a
**day-ahead forecast with an 80% range**, and, once the replay clock reaches it, the arrival MBTA
actually recorded.

Live: **https://mbta.sharmajai.com** · Unofficial, not affiliated with the MBTA.

## Research question

Can a small tabular model beat platform-level historical delay estimates on later weeks, while giving
ranges that are both honest (about 80% coverage) and useful (not absurdly wide)? Each line gets its own
answer.

## Results (test weeks Jun 8 – Jul 5 2026, scored once per line)

| Line | System | MAE (min) | Coverage | Mean width (min) | Verdict |
| --- | --- | ---: | ---: | ---: | --- |
| Blue | Historical baseline | 9.03 | 72.1% | 21.4 |  |
| Blue | LightGBM, calibrated | 8.97 | 75.2% | 21.6 | passes; MAE gain within noise |
| Red | Historical baseline | 5.52 | 78.4% | 16.8 |  |
| Red | LightGBM, calibrated | 5.42 | 81.8% | 16.6 | passes; MAE gain clear (95% CI below 0) |
| Green | Historical baseline | 4.56 | 75.3% | 14.4 |  |
| Green | LightGBM, calibrated | 4.82 | 79.9% | 16.1 | **fails** MAE criterion; historical featured |

**How to read this.** MAE is the average distance between the median forecast and the recorded
arrival. Coverage is how often the 80% range held the arrival. Width is the range's average size. The
historical baseline is the bar to beat. The full per-line benchmark, branch and station breakdowns,
and day-level data quality are on the Results page.

Ranges are wide because delay against a *specific scheduled trip* has a heavy tail on lines run to
headways. When a train starts late or another train takes over a trip's ID, the delay against that trip
can reach tens of minutes even though riders still see frequent trains. See the Method page.

## How it works

```
LAMP daily Parquet ─┐                 ┌─ planned_events ─┐
                    ├─ fetch (sha256) ─┤                  ├─ joined_events → features ─┬─ Blue  ─┐
GTFS archive zips ──┘                 └─ observations ───┘                             ├─ Red   ─┼─ LightGBM q10/q50/q90
                                                                                       └─ Green ─┘  → conformal calibration
                                                                                                    → test evaluation
                                   static release (JSON per line and date) ← export
                                                     │
                       React + MapLibre site (mbta.sharmajai.com) · FastAPI (optional)
```

* **Lines**: configured in `configs/data.yaml`. Blue is one trunk. Red has Ashmont and Braintree
  branches. Green has the B, C, D and E routes. Branches are detected from the schedule's trip patterns.
* **Forecast origin**: 8 PM Boston time the day before. No same-day observations are used.
* **Target**: recorded arrival minus scheduled arrival, in seconds (negative = early).
* **Splits**: train Jul 7 2025 – Mar 22 2026 · validation Mar 30 – Apr 26 · calibration May 4 – 31 ·
  test Jun 8 – Jul 5, with one-week embargoes between blocks.
* **Interval**: split conformalized quantile regression (Romano, Patterson & Candès 2019), calibrated per
  line and reported empirically by station, branch and week.

## The interface

* **Line switcher**: the whole UI recolors to the active line (an animated CSS `@property`).
* **Station sign**: the name rises letter by letter as a train-shaped light passes the sign. An amber LED
  countdown shows each train as a *range* ("4–28 min"), with Green branch letters.
* **Network schematic** (Red, Green): branches fork and merge, and every recorded train glides along.
* **Strip map**: the branch you choose, with recorded trains (solid, doors blink while dwelling) and
  forecast "ghost" trains (dashed).
* **System map**: all three lines. Trains leave fading trails, the camera flies to the station you pick,
  and recorded arrivals pulse at the platform.
* Keyboard: Space plays and pauses, ← → move a minute. Reduced-motion preferences are respected.

## Run it

```bash
make bootstrap          # uv + npm
make fetch              # ~1.4 GB: 370 LAMP days + 122 schedule versions (idempotent)
make build-data train calibrate evaluate export
make dev                # http://localhost:5173
make serve              # FastAPI + built site on http://localhost:8000
make verify             # pytest, ruff, tsc
```

API (same contract as the static JSON): `GET /v1/release`, `/v1/lines`, `/v1/stations?line=Red`,
`/v1/replay?line=Green&station_id=place-kencl&direction_id=0&service_date=2026-06-19`,
`/v1/metrics?line=Blue`, `/healthz`.

Deployment: see [docs/DEPLOY.md](docs/DEPLOY.md).

## Repository

```
app/api/          FastAPI read-only service
app/web/          React + TypeScript + Vite + MapLibre site; public/api/v1 = the bundled release
pipeline/sql/     roster and join SQL (DuckDB)
pipeline/transit/ fetch, build, model (train/calibrate/evaluate per line), export
configs/          lines, date splits, LightGBM settings, release criteria
tests/            DST / 25:00 times / join / metric / API contract tests
```

## Sources

* MBTA LAMP subway performance data: https://performancedata.mbta.com/
* MBTA GTFS archive: https://cdn.mbta.com/archive/archived_feeds.txt
* Romano, Patterson, Candès (2019), *Conformalized Quantile Regression*, NeurIPS.
* Gibbs, Candès (2021), *Adaptive Conformal Inference Under Distribution Shift*, NeurIPS.
* Probabilistic transit travel-time research, Transportation Research Part C (2026).
* Basemap © OpenStreetMap contributors via OpenFreeMap.
