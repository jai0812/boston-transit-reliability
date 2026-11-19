# Repositories to reuse or extend this project

Checked on GitHub on 2026-11-18 (stars and last push at that time). Each entry says what it would add
here, not just what it is. Effort: **S** = an afternoon, **M** = a few days, **L** = a project of its own.

## Pick these first

| Repo | Stars | What it adds here | Effort |
| --- | ---: | --- | :-: |
| [scikit-learn-contrib/MAPIE](https://github.com/scikit-learn-contrib/MAPIE) | 1.7k | Replaces our hand-written conformal step with tested CQR, and adds **adaptive conformal inference** for time series (Gibbs & Candès / Zaffran et al.). Adaptive calibration is the fix for the coverage drop in the last test week. | S |
| [evidentlyai/evidently](https://github.com/evidentlyai/evidently) | 8.1k | Weekly drift and coverage reports when new LAMP days arrive. Answers "is the model still calibrated?" with an HTML report per line. | S |
| [visgl/deck.gl](https://github.com/visgl/deck.gl) | 14.8k | `TripsLayer` renders thousands of trains with GPU trails. It's the natural upgrade from our MapLibre GeoJSON trains once we add Orange, Mattapan and buses. Works on top of MapLibre. | M |
| [transitmatters/t-performance-dash](https://github.com/transitmatters/t-performance-dash) | 56 | Boston's community MBTA performance dashboard (MIT). Good to cross-check our headways and travel times, and a likely audience for a "forecast uncertainty" contribution. | S |

## Forecasting and ML

| Repo | Stars | What it adds here | Effort |
| --- | ---: | --- | :-: |
| [Nixtla/statsforecast](https://github.com/Nixtla/statsforecast) | 5.0k | Fast seasonal baselines (MSTL, ETS) per platform. A stronger "historical" bar than grouped percentiles. | S |
| [Nixtla/neuralforecast](https://github.com/Nixtla/neuralforecast) | 4.3k | NHITS, TFT and DeepAR with quantile losses, if the project grows to multi-line, multi-feature forecasting. | M |
| [amazon-science/chronos-forecasting](https://github.com/amazon-science/chronos-forecasting) | 6.3k | A pretrained time-series model. Zero-shot day-ahead forecasts of platform-level delay series, compared against LightGBM on the same test weeks. | M |
| [google-research/timesfm](https://github.com/google-research/timesfm) | 35.6k | Same experiment with Google's foundation model; gives a second zero-shot reference. | M |
| [benedekrozemberczki/pytorch_geometric_temporal](https://github.com/benedekrozemberczki/pytorch_geometric_temporal) | 3.0k | Spatiotemporal graph networks, with stations as nodes and track as edges. This is the "neural spatiotemporal model" extension the project guide says to try only once multiple lines exist, and now they do. | L |
| [valeman/awesome-conformal-prediction](https://github.com/valeman/awesome-conformal-prediction) | 1.3k | Reading list of papers and libraries for the uncertainty side of the write-up. | — |

## Transit data and routing

| Repo | Stars | What it adds here | Effort |
| --- | ---: | --- | :-: |
| [mbta/lamp](https://github.com/mbta/lamp) | 16 | Our data source. Read its dictionary before trusting `stop_timestamp` fallbacks. | — |
| [mbta/api](https://github.com/mbta/api) (V3 API) | — | Live predictions and vehicle positions. Turns the replay into a **live mode**: our range next to MBTA's own ETA, scored as the day unfolds. | M |
| [MobilityData/gtfs-validator](https://github.com/MobilityData/gtfs-validator) | 435 | Validate every archived schedule before it enters the roster; add its report to `data_quality`. | S |
| [r5py/r5py](https://github.com/r5py/r5py) | 195 | Door-to-door travel-time and accessibility maps. "How much of Boston can you reach in 30 minutes, **with 80% confidence**?" combines our ranges with routing. | L |
| [opentripplanner/OpenTripPlanner](https://github.com/opentripplanner/OpenTripPlanner) | 2.8k | A full trip planner; pairs with our ranges for "leave by" advice that accounts for reliability. | L |
| [transitmatters/new-train-tracker](https://github.com/transitmatters/new-train-tracker) | 41 | Live map of new Orange, Red and Green cars. Reference UI for a live mode. | — |

## Finance and economics

| Repo | Stars | What it adds here | Effort |
| --- | ---: | --- | :-: |
| [mortada/fredapi](https://github.com/mortada/fredapi) | 1.7k | Pull Boston-area wages from FRED to put a **dollar value on unreliability**: riders' buffer time × the value of time. A "cost of uncertainty" panel per line is a strong portfolio angle. Needs a free FRED key. | S |
| [duckdb/duckdb-wasm](https://github.com/duckdb/duckdb-wasm) | 2.2k | Run SQL on the release Parquet in the browser, so visitors can ask their own questions without a server. | M |

## AI features

| Repo | Stars | What it adds here | Effort |
| --- | ---: | --- | :-: |
| [anthropics/anthropic-sdk-python](https://github.com/anthropics/anthropic-sdk-python) | 4.1k | "Explain this day": a short plain-English summary of why a replay missed (bunching, a long gap, a late start), generated offline at export time from the metrics, so the static site needs no API key. | S |
| [Nixtla/nixtla](https://github.com/Nixtla/nixtla) (TimeGPT) | 4.0k | Hosted forecasting and anomaly detection. Useful for flagging disruption days automatically; needs an API key and sends data to a third party. | S |

## Suggested order

1. **MAPIE adaptive conformal**: directly addresses the weakest result (late-June coverage drop).
2. **Cost of unreliability (FRED)**: one new home-page section that non-technical readers will remember.
3. **Live mode (MBTA V3 API)**: turns a replay into a tool people come back to.
4. **Foundation-model benchmark (Chronos / TimesFM)**: an "AI vs. gradient boosting" row in the results table.
5. **deck.gl TripsLayer**: once more lines or buses are added.
