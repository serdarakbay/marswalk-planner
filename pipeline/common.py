"""Shared helpers: paths, reading area.json and config/mission.json, writing JSON.

No coordinates or thresholds are hard-coded here; they always come from area.json and mission.json.
"""
from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WEB_DATA = ROOT / "web" / "data"
CACHE = ROOT / "data" / "cache"
AREA_JSON = WEB_DATA / "area.json"
MISSION_JSON = ROOT / "config" / "mission.json"


def load_area(path: Path | None = None) -> dict:
    """area.json (Utku): {bbox{west,south,east,north}, habitat[lon,lat], crs}."""
    path = path or AREA_JSON
    if not path.exists():
        raise FileNotFoundError(
            f"{path.relative_to(ROOT)} not found. area.json is written by Utku (branch `bilim`); pull main."
        )
    area = json.loads(path.read_text(encoding="utf-8"))
    bbox = area.get("bbox") or {}
    missing = [k for k in ("west", "south", "east", "north") if k not in bbox]
    if missing:
        raise ValueError(f"area.json bbox is missing fields: {missing}")
    return area


def load_mission(path: Path | None = None) -> dict:
    """config/mission.json (Utku): all thresholds and constants."""
    path = path or MISSION_JSON
    if not path.exists():
        raise FileNotFoundError(
            f"{path.relative_to(ROOT)} not found. mission.json is written by Utku (branch `bilim`); pull main."
        )
    return json.loads(path.read_text(encoding="utf-8"))


def bbox_covers(outer: dict, inner: dict) -> bool:
    """True if outer fully covers inner. Both are {west,south,east,north}."""
    return (outer["west"] <= inner["west"] and outer["east"] >= inner["east"]
            and outer["south"] <= inner["south"] and outer["north"] >= inner["north"])


def write_json(path: Path, data, indent: int | None = 1) -> None:
    """Write UTF-8 JSON, creating the folder if needed."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=indent) + "\n", encoding="utf-8")
    print(f"wrote: {path.relative_to(ROOT)}")
