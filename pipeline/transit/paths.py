"""Filesystem layout for the data build. Everything under data/ is git-ignored."""

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "data"
RAW = DATA / "raw"
RAW_LAMP = RAW / "lamp"
RAW_GTFS = RAW / "gtfs"
CURATED = DATA / "curated"
MODELS = DATA / "models"
RELEASE = DATA / "release"
CONFIGS = ROOT / "configs"
SQL = ROOT / "pipeline" / "sql"

for p in (RAW_LAMP, RAW_GTFS, CURATED, MODELS, RELEASE):
    p.mkdir(parents=True, exist_ok=True)
