from __future__ import annotations

import datetime as dt
from functools import cache

import yaml

from .paths import CONFIGS


@cache
def data_config() -> dict:
    return yaml.safe_load((CONFIGS / "data.yaml").read_text())


@cache
def model_config() -> dict:
    return yaml.safe_load((CONFIGS / "lightgbm.yaml").read_text())


def split_of(d: dt.date) -> str | None:
    for name, (a, b) in data_config()["splits"].items():
        if a <= d <= b:
            return name
    return None


def bucket_case_sql(hour_expr: str) -> str:
    parts = [f"WHEN {hour_expr} >= {lo} AND {hour_expr} < {hi} THEN '{name}'"
             for name, (lo, hi) in data_config()["time_buckets"].items()]
    return "CASE " + " ".join(parts) + " END"
