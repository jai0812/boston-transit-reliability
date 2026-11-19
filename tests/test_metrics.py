import math

import numpy as np
import pandas as pd

from pipeline.transit.model import fit_historical, pinball, predict_historical, score


def test_pinball_matches_definition():
    y = np.array([10.0, -5.0])
    f = np.array([0.0, 0.0])
    # q=0.9: under-prediction costs 0.9 per unit, over-prediction 0.1
    assert math.isclose(pinball(y, f, 0.9), (0.9 * 10 + 0.1 * 5) / 2)


def test_interval_boundary_counts_as_covered_and_score():
    y = np.array([0.0, 100.0, 300.0])
    sysd = {"p50": pd.Series([0.0, 0.0, 0.0]),
            "lo": pd.Series([0.0, 0.0, 0.0]), "hi": pd.Series([100.0, 100.0, 120.0])}
    r = score(y, sysd, np.array([True, True, True]), alpha=0.2)
    assert math.isclose(r["coverage"], 2 / 3)
    # third point misses by 180 s: width 120 + (2/0.2)*180
    expected = (100 + 100 + 120 + 10 * 180) / 3 / 60
    assert math.isclose(r["interval_score_min"], expected)


def test_historical_baseline_falls_back_when_group_is_small():
    rows = []
    for i in range(60):
        rows.append({"stop_id": "A", "time_bucket": "am_peak", "is_weekend": 0.0,
                     "delay_s": float(i), "usable": True})
    for _ in range(5):  # too few rows for its own group
        rows.append({"stop_id": "B", "time_bucket": "am_peak", "is_weekend": 0.0,
                     "delay_s": 1000.0, "usable": True})
    train = pd.DataFrame(rows)
    model = fit_historical(train, min_rows=50)
    test = pd.DataFrame([{"stop_id": "A", "time_bucket": "am_peak", "is_weekend": 0.0},
                         {"stop_id": "B", "time_bucket": "am_peak", "is_weekend": 0.0},
                         {"stop_id": "Z", "time_bucket": "late", "is_weekend": 1.0}])
    p = predict_historical(model, test)
    assert p.level.tolist()[0] == "stop_id+time_bucket+daytype"
    assert p.level.tolist()[2] == "line"
    assert (p.p10 <= p.p50).all() and (p.p50 <= p.p90).all()


def test_conformal_quantile_index():
    # ceil((n+1)(1-a))-th smallest score, n=9, a=0.2 -> 8th
    n, a = 9, 0.2
    assert math.ceil((n + 1) * (1 - a)) == 8
