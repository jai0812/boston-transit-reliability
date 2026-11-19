"""Baselines, LightGBM quantile models, conformal calibration and evaluation.

Stages (each reads the previous stage's artifacts from data/models/):
  train      fit schedule + historical baselines and search LightGBM on validation
  calibrate  fit the conformal widening on the calibration window (choices are frozen)
  evaluate   score every system once on the test window, write metrics.json
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import platform
import subprocess
import time

import duckdb
import lightgbm as lgb
import numpy as np
import pandas as pd

from .config import data_config, model_config
from .paths import CURATED, MODELS

DB = CURATED / "transit.duckdb"
PRED = MODELS / "predictions.parquet"
KEY = ["service_date", "trip_id", "stop_id", "stop_sequence"]


# ---------------------------------------------------------------- data

def load_features() -> pd.DataFrame:
    con = duckdb.connect(str(DB), read_only=True)
    df = con.execute("SELECT * FROM features ORDER BY service_date, scheduled_epoch").df()
    con.close()
    for c in ("is_weekend", "hist_missing", "schedule_after_origin"):
        df[c] = df[c].astype("float32")
    # DuckDB returns nullable pandas integers; models and metrics need plain floats with NaN.
    for c in df.columns:
        if pd.api.types.is_extension_array_dtype(df[c]) and pd.api.types.is_numeric_dtype(df[c]):
            df[c] = df[c].astype("float64")
    df["usable"] = df["observation_status"].eq("observed")
    return df


def matrix(df: pd.DataFrame, cols: list[str], vocab: dict[str, list[str]]) -> pd.DataFrame:
    X = df[cols].copy()
    for c, cats in vocab.items():
        if c in X:
            # Unknown categories become NaN, which LightGBM routes as missing.
            X[c] = pd.Categorical(X[c].astype(str), categories=cats)
    for c in X.columns:
        if c not in vocab:
            X[c] = X[c].astype("float32")
    return X


def pinball(y: np.ndarray, f: np.ndarray, q: float) -> float:
    d = y - f
    return float(np.mean(np.maximum(q * d, (q - 1) * d)))


# ---------------------------------------------------------------- historical baseline

def fit_historical(train: pd.DataFrame, min_rows: int) -> dict:
    t = train[train.usable].assign(daytype=lambda d: np.where(d.is_weekend > 0, "we", "wd"))
    levels = [["stop_id", "time_bucket", "daytype"], ["stop_id"], []]
    tables = []
    for cols in levels:
        g = (t.groupby(cols)["delay_s"] if cols else t.assign(_k=0).groupby("_k")["delay_s"])
        stats = g.quantile([0.1, 0.5, 0.9]).unstack()
        stats.columns = ["p10", "p50", "p90"]
        stats["n"] = g.size()
        stats = stats[stats.n >= min_rows] if cols else stats
        tables.append((cols, stats.reset_index()))
    return {"levels": tables}


def predict_historical(model: dict, df: pd.DataFrame) -> pd.DataFrame:
    d = df.assign(daytype=np.where(df.is_weekend > 0, "we", "wd"))
    out = pd.DataFrame(index=df.index, columns=["p10", "p50", "p90"], dtype=float)
    level = pd.Series("", index=df.index)
    for cols, stats in model["levels"]:
        todo = out.p50.isna()
        if not todo.any():
            break
        if cols:
            m = d.loc[todo, cols].merge(stats, on=cols, how="left")
            m.index = d.index[todo]
        else:
            m = pd.DataFrame({c: stats[c].iloc[0] for c in ("p10", "p50", "p90")},
                             index=d.index[todo])
        hit = m.p50.notna()
        out.loc[hit[hit].index, ["p10", "p50", "p90"]] = m.loc[hit, ["p10", "p50", "p90"]].values
        level.loc[hit[hit].index] = "+".join(cols) or "line"
    out["level"] = level
    return out


# ---------------------------------------------------------------- train

def train() -> None:
    mcfg = model_config()
    t0 = time.time()
    df = load_features()
    tr = df[(df.split == "train")]
    va = df[(df.split == "validation")]
    qs = mcfg["quantiles"]

    hist = fit_historical(tr, mcfg["historical_baseline"]["min_rows"])
    hp = predict_historical(hist, df)
    preds = df[KEY + ["split"]].copy()
    preds["schedule_p50"] = 0.0
    preds[["hist_p10", "hist_p50", "hist_p90"]] = hp[["p10", "p50", "p90"]].values
    preds["hist_level"] = hp["level"].values

    vocab = {c: sorted(tr[c].astype(str).unique()) for c in mcfg["categorical"]}
    trU, vaU = tr[tr.usable], va[va.usable]
    report = {"feature_sets": {}, "vocab": vocab}

    for fs_name, cols in mcfg["feature_sets"].items():
        Xtr, Xva = matrix(trU, cols, vocab), matrix(vaU, cols, vocab)
        ytr, yva = trU.delay_s.values, vaU.delay_s.values
        best = None
        trials = []
        for cand in mcfg["search"]:
            params = {**mcfg["base_params"], **cand}
            models, losses, iters = {}, {}, {}
            for q in qs:
                m = lgb.LGBMRegressor(alpha=q, **params)
                m.fit(Xtr, ytr, eval_set=[(Xva, yva)], eval_metric="quantile",
                      callbacks=[lgb.early_stopping(mcfg["early_stopping_rounds"], verbose=False)])
                f = m.predict(Xva, num_iteration=m.best_iteration_)
                models[q], losses[q], iters[q] = m, pinball(yva, f, q), int(m.best_iteration_)
            mean_loss = float(np.mean(list(losses.values())))
            trials.append({"params": cand, "val_pinball": losses, "mean_val_pinball": mean_loss,
                           "best_iteration": iters})
            print(f"{fs_name} {cand} mean pinball {mean_loss:.2f}s iters {iters}")
            if best is None or mean_loss < best[0]:
                best = (mean_loss, cand, models, iters)
        _, cand, models, iters = best
        Xall = matrix(df, cols, vocab)
        raw = np.column_stack([models[q].predict(Xall, num_iteration=models[q].best_iteration_)
                               for q in qs])
        val_mask = (df.split == "validation") & df.usable
        crossing = float(np.mean((np.diff(raw[val_mask.values], axis=1) < 0).any(axis=1)))
        srt = np.sort(raw, axis=1)
        mid_change = float(np.mean(np.abs(srt[val_mask.values, 1] - raw[val_mask.values, 1])))
        for i, q in enumerate(qs):
            tag = f"lgbm_{fs_name}_q{int(q * 100):02d}"
            preds[f"{tag}_raw"] = raw[:, i]
            preds[tag] = srt[:, i]
            d = MODELS / f"lgbm_{fs_name}"
            d.mkdir(parents=True, exist_ok=True)
            models[q].booster_.save_model(str(d / f"q{int(q * 100):02d}.txt"),
                                          num_iteration=models[q].best_iteration_)
        report["feature_sets"][fs_name] = {
            "columns": cols, "selected_params": {**mcfg["base_params"], **cand},
            "best_iteration": iters, "trials": trials,
            "validation_crossing_rate": crossing,
            "validation_median_shift_after_sort_s": mid_change,
        }

    preds.to_parquet(PRED, index=False)
    report["training_manifest"] = _manifest(t0)
    (MODELS / "train_report.json").write_text(json.dumps(report, indent=2, default=str))
    print(f"train done in {time.time() - t0:.0f}s")


def _manifest(t0: float) -> dict:
    try:
        commit = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
    except Exception:
        commit = None
    return {
        "code_commit": commit,
        "lightgbm": lgb.__version__, "numpy": np.__version__, "pandas": pd.__version__,
        "duckdb": duckdb.__version__, "python": platform.python_version(),
        "machine": platform.machine(), "threads": model_config()["base_params"]["n_jobs"],
        "seed": model_config()["base_params"]["random_state"],
        "duration_s": round(time.time() - t0, 1),
        "generated_at": dt.datetime.now(dt.UTC).isoformat(timespec="seconds"),
    }


# ---------------------------------------------------------------- calibrate

def calibrate() -> None:
    mcfg = model_config()
    a = 1 - mcfg["nominal_coverage"]
    df = load_features()
    p = pd.read_parquet(PRED)
    cal = (p.split == "calibration").values & df.usable.values
    y = df.delay_s.values[cal]
    out = {}
    for fs in mcfg["feature_sets"]:
        lo, hi = p[f"lgbm_{fs}_q10"].values, p[f"lgbm_{fs}_q90"].values
        scores = np.maximum(lo[cal] - y, y - hi[cal])
        n = len(scores)
        k = math.ceil((n + 1) * (1 - a))
        if n < 100 or k > n:
            raise SystemExit(f"calibration sample too small for {fs}: n={n}")
        qhat = float(np.sort(scores)[k - 1])
        adj = max(0.0, qhat)
        p[f"lgbm_{fs}_cal_lo"] = lo - adj
        p[f"lgbm_{fs}_cal_hi"] = hi + adj
        out[fs] = {"method": "split conformalized quantile regression (Romano et al. 2019)",
                   "policy": "sort quantiles, then widen both sides by max(0, q_hat)",
                   "nominal_miscoverage": a, "n_calibration": n, "k": k,
                   "score_quantile_s": qhat, "adjustment_s": adj,
                   "calibration_dates": data_config()["splits"]["calibration"],
                   "calibration_coverage_before": float(np.mean((y >= lo[cal]) & (y <= hi[cal])))}
        print(fs, out[fs])
    p.to_parquet(PRED, index=False)
    (MODELS / "calibration.json").write_text(json.dumps(out, indent=2, default=str))


# ---------------------------------------------------------------- evaluate

def _systems(p: pd.DataFrame) -> dict[str, dict]:
    s = {
        "schedule": {"label": "Scheduled arrival", "p50": p.schedule_p50},
        "historical": {"label": "Historical baseline", "p10": p.hist_p10, "p50": p.hist_p50,
                       "p90": p.hist_p90, "lo": p.hist_p10, "hi": p.hist_p90},
    }
    for fs in model_config()["feature_sets"]:
        nice = "LightGBM" if fs == "schedule" else "LightGBM + history"
        base = {"p10": p[f"lgbm_{fs}_q10"], "p50": p[f"lgbm_{fs}_q50"],
                "p90": p[f"lgbm_{fs}_q90"]}
        s[f"lgbm_{fs}_raw"] = {"label": f"{nice} uncalibrated", **base,
                               "lo": base["p10"], "hi": base["p90"]}
        s[f"lgbm_{fs}_cal"] = {"label": f"{nice} calibrated", **base,
                               "lo": p[f"lgbm_{fs}_cal_lo"], "hi": p[f"lgbm_{fs}_cal_hi"]}
    return s


def score(y: np.ndarray, sysd: dict, mask: np.ndarray, alpha: float) -> dict:
    yy = y[mask]
    r = {"n": int(mask.sum())}
    if r["n"] == 0:
        return r
    f = sysd["p50"].values[mask]
    r["mae_min"] = float(np.mean(np.abs(yy - f)) / 60)
    r["bias_min"] = float(np.mean(f - yy) / 60)
    if "p10" in sysd:
        r["pinball_s"] = {str(q): pinball(yy, sysd[k].values[mask], q)
                          for q, k in ((0.1, "p10"), (0.5, "p50"), (0.9, "p90"))}
    if "lo" in sysd:
        lo, hi = sysd["lo"].values[mask], sysd["hi"].values[mask]
        inside = (yy >= lo) & (yy <= hi)
        w = hi - lo
        iscore = w + (2 / alpha) * np.maximum(lo - yy, 0) + (2 / alpha) * np.maximum(yy - hi, 0)
        r.update(coverage=float(inside.mean()), width_min=float(w.mean() / 60),
                 interval_score_min=float(iscore.mean() / 60),
                 late_miss_rate=float((yy > hi).mean()), early_miss_rate=float((yy < lo).mean()))
    return r


def evaluate() -> None:
    mcfg, cfg = model_config(), data_config()
    alpha = 1 - mcfg["nominal_coverage"]
    df = load_features()
    p = pd.read_parquet(PRED)
    systems = _systems(p)
    y = df.delay_s.fillna(0).values
    test = (df.split == "test").values
    usable = df.usable.values
    eligible = test & ~df.observation_status.eq("source_gap").values
    peak = df.time_bucket.isin(cfg["peak_buckets"]).values
    week = pd.to_datetime(df.service_date).dt.to_period("W-SUN").dt.start_time.dt.date.astype(str)

    segs: dict[str, np.ndarray] = {"all": test & usable,
                                   "peak": test & usable & peak,
                                   "off_peak": test & usable & ~peak}
    for d in (0, 1):
        segs[f"direction_{d}"] = test & usable & (df.direction_id.values == d)
    for b in cfg["time_buckets"]:
        segs[f"bucket_{b}"] = test & usable & (df.time_bucket.values == b)
    for st in sorted(df.parent_station.unique()):
        segs[f"station_{st}"] = test & usable & (df.parent_station.values == st)
    for w in sorted(week[test].unique()):
        segs[f"week_{w}"] = test & usable & (week.values == w)

    results = {name: {seg: score(y, sd, m, alpha) for seg, m in segs.items()}
               for name, sd in systems.items()}

    # Uncertainty in the MAE difference: resample whole service days.
    rng = np.random.default_rng(42)
    tmask = segs["all"]
    days = df.service_date.values[tmask]
    ud = np.unique(days)
    err = {k: np.abs(y[tmask] - systems[k]["p50"].values[tmask]) for k in systems}
    by_day = {k: pd.Series(v).groupby(days).agg(["sum", "count"]) for k, v in err.items()}
    boot = {}
    for k in systems:
        if k == "historical":
            continue
        diffs = []
        for _ in range(1000):
            pick = rng.choice(ud, size=len(ud), replace=True)
            a_ = by_day[k].loc[pick].sum()
            b_ = by_day["historical"].loc[pick].sum()
            diffs.append((a_["sum"] / a_["count"] - b_["sum"] / b_["count"]) / 60)
        boot[k] = {"mae_diff_vs_historical_min": float(np.mean(diffs)),
                   "ci95": [float(np.percentile(diffs, 2.5)), float(np.percentile(diffs, 97.5))]}

    counts = {
        "test_days": int(df.service_date[test].nunique()),
        "source_gap_days": sorted(df.service_date[test & df.observation_status.eq(
            "source_gap").values].astype(str).unique().tolist()),
        "eligible_events": int(eligible.sum()),
        "usable_events": int((test & usable).sum()),
        "observation_coverage": float((test & usable).sum() / max(eligible.sum(), 1)),
        "status_counts": df[test].observation_status.value_counts().to_dict(),
    }
    crit = mcfg["release_criteria"]
    primary = "lgbm_schedule_cal"
    a_ = results[primary]["all"]
    h = results["historical"]["all"]
    decision = {
        "criteria": crit,
        "beats_historical_mae": a_["mae_min"] < h["mae_min"],
        "coverage_in_band": crit["coverage_band"][0] <= a_["coverage"] <= crit["coverage_band"][1],
        "interval_score_better_than_historical": a_["interval_score_min"] < h["interval_score_min"],
    }
    decision["promote_lightgbm"] = decision["beats_historical_mae"] and decision["coverage_in_band"]
    decision["featured_system"] = primary if decision["promote_lightgbm"] else "historical"

    out = {"systems": {k: v["label"] for k, v in systems.items()}, "segments": list(segs),
           "results": results, "bootstrap": boot, "counts": counts, "decision": decision,
           "nominal_coverage": mcfg["nominal_coverage"],
           "small_group_threshold": 200}
    (MODELS / "metrics.json").write_text(json.dumps(out, indent=2, default=str))
    print(pd.DataFrame({k: {m: v["all"].get(m) for m in
                            ("n", "mae_min", "coverage", "width_min", "interval_score_min")}
                        for k, v in results.items()}).T.round(3))
    print(json.dumps(counts, indent=1, default=str))
    print(json.dumps(decision, indent=1))
    print(json.dumps(boot, indent=1))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("stage", choices=["train", "calibrate", "evaluate"])
    {"train": train, "calibrate": calibrate, "evaluate": evaluate}[ap.parse_args().stage]()
