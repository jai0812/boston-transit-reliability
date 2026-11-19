"""Download LAMP daily subway files and archived GTFS schedules.

Idempotent: every file is written to a temporary name and renamed after it validates.
A manifest (data/raw/manifest.json) records URL, SHA-256, size, the source's last_modified
and when we fetched it. A retry skips any partition whose last_modified is unchanged.
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import hashlib
import io
import json
import time
import zipfile
from pathlib import Path

import httpx
import pyarrow.parquet as pq

from .paths import RAW, RAW_GTFS, RAW_LAMP

LAMP_INDEX = "https://performancedata.mbta.com/lamp/subway-on-time-performance-v1/index.csv"
GTFS_ARCHIVE_INDEX = "https://cdn.mbta.com/archive/archived_feeds.txt"
MANIFEST = RAW / "manifest.json"
UA = {"User-Agent": "boston-transit-reliability/0.1 (research replay)"}


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def load_manifest() -> dict:
    if MANIFEST.exists():
        return json.loads(MANIFEST.read_text())
    return {"lamp": {}, "gtfs": {}, "indexes": {}}


def save_manifest(m: dict) -> None:
    tmp = MANIFEST.with_suffix(".tmp")
    tmp.write_text(json.dumps(m, indent=2, sort_keys=True))
    tmp.replace(MANIFEST)


def _now() -> str:
    return dt.datetime.now(dt.UTC).isoformat(timespec="seconds")


def fetch_text(client: httpx.Client, url: str, name: str, manifest: dict) -> str:
    r = client.get(url)
    r.raise_for_status()
    path = RAW / f"{name}.csv"
    path.write_bytes(r.content)
    manifest["indexes"][name] = {"url": url, "sha256": _sha256(path), "fetched_at": _now()}
    return r.text


def _download(client: httpx.Client, url: str, dest: Path, attempts: int = 4) -> Path:
    """Stream to dest.part with retries; the caller promotes it after validation."""
    tmp = dest.with_suffix(dest.suffix + ".part")
    for i in range(attempts):
        try:
            with client.stream("GET", url) as r:
                r.raise_for_status()
                with tmp.open("wb") as f:
                    for chunk in r.iter_bytes(1 << 16):
                        f.write(chunk)
            return tmp
        except (httpx.TransportError, httpx.HTTPStatusError) as e:
            tmp.unlink(missing_ok=True)
            if i == attempts - 1:
                raise
            wait = 5 * 2 ** i
            print(f"retry {url} in {wait}s ({type(e).__name__})")
            time.sleep(wait)
    raise AssertionError("unreachable")


def fetch_lamp(start: dt.date, end: dt.date, client: httpx.Client, manifest: dict) -> list[Path]:
    rows = list(csv.DictReader(io.StringIO(fetch_text(client, LAMP_INDEX, "lamp_index", manifest))))
    out = []
    for row in rows:
        d = dt.date.fromisoformat(row["service_date"])
        if not (start <= d <= end):
            continue
        dest = RAW_LAMP / f"{d.isoformat()}.parquet"
        prev = manifest["lamp"].get(d.isoformat())
        if dest.exists() and prev and prev["last_modified"] == row["last_modified"]:
            out.append(dest)
            continue
        tmp = _download(client, row["file_url"], dest)
        pq.read_metadata(tmp)  # validates parquet footer before we promote the file
        tmp.replace(dest)
        entry = {
            "url": row["file_url"],
            "last_modified": row["last_modified"],
            "size_bytes": dest.stat().st_size,
            "sha256": _sha256(dest),
            "fetched_at": _now(),
        }
        if prev and prev["sha256"] != entry["sha256"]:
            entry["revised_from"] = prev["sha256"]
        manifest["lamp"][d.isoformat()] = entry
        out.append(dest)
        print(f"lamp {d} {entry['size_bytes']:,} bytes")
    return out


GTFS_TABLES = ("feed_info", "trips", "stop_times", "stops", "calendar", "calendar_dates",
               "routes", "shapes")


def fetch_gtfs(start: dt.date, end: dt.date, client: httpx.Client, manifest: dict) -> list[Path]:
    """Fetch every archived feed whose validity window overlaps [start, end].

    Only the tables we need are extracted, and stop_times/trips/shapes are filtered to
    the Blue Line on extraction to keep the cache small.
    """
    text = fetch_text(client, GTFS_ARCHIVE_INDEX, "gtfs_archive_index", manifest)
    out = []
    for row in csv.DictReader(io.StringIO(text)):
        fs = dt.datetime.strptime(row["feed_start_date"], "%Y%m%d").date()
        fe = dt.datetime.strptime(row["feed_end_date"], "%Y%m%d").date()
        if fe < start or fs > end:
            continue
        key = row["feed_start_date"]
        dest = RAW_GTFS / key
        if (dest / "_SUCCESS").exists() and key in manifest["gtfs"]:
            out.append(dest)
            continue
        dest.mkdir(parents=True, exist_ok=True)
        zpath = RAW_GTFS / f"{key}.zip"
        try:
            tmp = _download(client, row["archive_url"], zpath)
        except (httpx.TransportError, httpx.HTTPStatusError) as e:
            print(f"FAILED gtfs {key}: {type(e).__name__}; rerun fetch to retry")
            continue
        tmp.replace(zpath)
        sha = _sha256(zpath)
        _extract_blue(zpath, dest)
        zpath.unlink()
        (dest / "_SUCCESS").write_text(sha)
        manifest["gtfs"][key] = {
            "url": row["archive_url"],
            "feed_start_date": fs.isoformat(),
            "feed_end_date": fe.isoformat(),
            "feed_version": row["feed_version"],
            "zip_sha256": sha,
            "fetched_at": _now(),
        }
        print(f"gtfs {key} {row['feed_version']}")
        out.append(dest)
    return out


def _extract_blue(zpath: Path, dest: Path) -> None:
    with zipfile.ZipFile(zpath) as z:
        names = set(z.namelist())
        trips_txt = z.read("trips.txt").decode("utf-8-sig")
        trips = list(csv.DictReader(io.StringIO(trips_txt)))
        blue = {t["trip_id"] for t in trips if t["route_id"] == "Blue"}
        shapes = {t["shape_id"] for t in trips if t["route_id"] == "Blue"}
        for table in GTFS_TABLES:
            fn = f"{table}.txt"
            if fn not in names:
                continue
            raw = z.read(fn).decode("utf-8-sig")
            if table not in ("trips", "stop_times", "shapes"):
                (dest / fn).write_text(raw)
                continue
            reader = csv.DictReader(io.StringIO(raw))
            buf = io.StringIO()
            w = csv.DictWriter(buf, fieldnames=reader.fieldnames, lineterminator="\n")
            w.writeheader()
            for r in reader:
                if table == "trips" and r["route_id"] == "Blue":
                    w.writerow(r)
                elif table == "stop_times" and r["trip_id"] in blue:
                    w.writerow(r)
                elif table == "shapes" and r["shape_id"] in shapes:
                    w.writerow(r)
            (dest / fn).write_text(buf.getvalue())


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", required=True, type=dt.date.fromisoformat)
    ap.add_argument("--end", required=True, type=dt.date.fromisoformat)
    ap.add_argument("--only", choices=["lamp", "gtfs"])
    a = ap.parse_args()
    m = load_manifest()
    with httpx.Client(headers=UA, timeout=120, follow_redirects=True) as c:
        try:
            if a.only != "gtfs":
                fetch_lamp(a.start, a.end, c, m)
            if a.only != "lamp":
                fetch_gtfs(a.start, a.end, c, m)
        finally:
            save_manifest(m)


if __name__ == "__main__":
    main()
