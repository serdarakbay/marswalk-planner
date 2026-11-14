"""Curiosity (MSL) traverse + raw images for the study area.

Owner: Egemen (branch `veri`)

Run:   python -m pipeline.fetch.curiosity [--refresh] [--per-site 3]
Input: web/data/area.json (bbox)
Out:   web/data/traverse.geojson   Curiosity's path inside the bbox
       web/data/images.json        [{url, sol, camera, utc, site, drive, credit}]
                                   camera = instrument code (MAST_LEFT, MAHLI, ...)
                                   camera_name = display name (extra field)

Sources (no API key needed):
  - MSL traverse / waypoints : mars.nasa.gov MMGIS layers (GeoJSON)
  - Raw images               : mars.nasa.gov/api/v1/raw_image_items
The raw image API returns site/drive = null, so we fill them from the
waypoint table (last waypoint whose sol <= image sol).

Only the Python standard library is used (no extra requirements).
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CACHE = ROOT / "data" / "cache" / "curiosity"
OUT_DIR = ROOT / "web" / "data"
AREA_JSON = OUT_DIR / "area.json"

WAYPOINTS_URL = "https://mars.nasa.gov/mmgis-maps/MSL/Layers/json/MSL_waypoints.json"
TRAVERSE_URL = "https://mars.nasa.gov/mmgis-maps/MSL/Layers/json/MSL_traverse.json"
RAW_API = "https://mars.nasa.gov/api/v1/raw_image_items/"

# Cameras we show on stop cards, in preference order.
CAMERAS = {
    "MAST_LEFT": "Mastcam",
    "MAST_RIGHT": "Mastcam",
    "NAV_LEFT_B": "Navcam",
    "NAV_RIGHT_B": "Navcam",
    "MAHLI": "MAHLI",
    "CHEMCAM_RMI": "ChemCam RMI",
    "FHAZ_LEFT_B": "Front Hazcam",
}
# One image per instrument per rover site, in this order (landscape first, then close-up, then context).
QUERY_INSTRUMENTS = ["MAST_LEFT", "MAHLI", "NAV_LEFT_B", "CHEMCAM_RMI"]
# MSSS-operated cameras need the MSSS credit (project photo rule).
MSSS_CAMERAS = {"Mastcam", "MAHLI", "MARDI"}

COORD_DECIMALS = 6  # ~0.06 m on Mars, keeps the file small
USER_AGENT = "martian-map-pipeline/1.0"


# ---------------------------------------------------------------- helpers
def log(msg: str) -> None:
    print(f"[curiosity] {msg}", flush=True)


def fetch_json(url: str, cache_name: str | None = None, refresh: bool = False, retries: int = 3):
    """GET a JSON url; optionally cache the raw response under data/cache/."""
    cache_file = CACHE / cache_name if cache_name else None
    if cache_file and cache_file.exists() and not refresh:
        return json.loads(cache_file.read_text())
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    last_err = None
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                raw = r.read()
            data = json.loads(raw)
            if cache_file:
                cache_file.parent.mkdir(parents=True, exist_ok=True)
                cache_file.write_bytes(raw)
            return data
        except Exception as e:  # network hiccup: retry with backoff
            last_err = e
            time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"GET failed after {retries} tries: {url} ({last_err})")


def load_bbox(area_path: Path | None = None) -> dict:
    """bbox {west,south,east,north} from area.json (Utku). No hard-coded coords."""
    if area_path is None:
        try:
            from pipeline.common import load_area  # type: ignore  # Ege's helper, once it exists
            return load_area()["bbox"]
        except Exception:
            pass
    path = area_path or AREA_JSON
    if not path.exists():
        sys.exit(f"[curiosity] ERROR: {path} not found. "
                 "area.json is written by Utku (branch `bilim`); merge main or pass --area.")
    return json.loads(path.read_text())["bbox"]


def in_bbox(lon: float, lat: float, b: dict) -> bool:
    return b["west"] <= lon <= b["east"] and b["south"] <= lat <= b["north"]


def rnd(x: float) -> float:
    return round(float(x), COORD_DECIMALS)


# ---------------------------------------------------------------- traverse
def build_traverse(traverse_fc: dict, waypoints: list[dict], b: dict) -> dict:
    """Clip MSL traverse to bbox -> single GeoJSON Feature (LineString)."""
    def nearest_sol(lon, lat):
        best = min(waypoints, key=lambda p: (p["lon"] - lon) ** 2 + (p["lat"] - lat) ** 2)
        return best["sol"]

    segments: list[list[list[float]]] = []
    current: list[list[float]] = []
    for feat in traverse_fc["features"]:
        geom = feat["geometry"]
        lines = geom["coordinates"] if geom["type"] == "MultiLineString" else [geom["coordinates"]]
        for line in lines:
            for c in line:
                lon, lat = c[0], c[1]
                if in_bbox(lon, lat, b):
                    pt = [rnd(lon), rnd(lat)]
                    if not current or current[-1] != pt:
                        current.append(pt)
                elif current:
                    segments.append(current)
                    current = []
    if current:
        segments.append(current)

    # contracts.md: one Feature with a LineString. The rover leaves and re-enters
    # the bbox, so the visits are joined; `breaks` (extra field) lists the index
    # of the first point of every re-entry, so the map can skip those jumps.
    segments = [seg for seg in segments if len(seg) >= 2]
    coords: list[list[float]] = []
    breaks: list[int] = []
    visits = []
    for seg in segments:
        if coords:
            breaks.append(len(coords))
        coords.extend(seg)
        s0, s1 = nearest_sol(*seg[0]), nearest_sol(*seg[-1])
        visits.append({"sol_start": min(s0, s1), "sol_end": max(s0, s1)})
    return {
        "type": "Feature",
        "geometry": {"type": "LineString", "coordinates": coords},
        "properties": {
            "source": "MSL traverse, NASA/JPL-Caltech (MMGIS)",
            "sol_start": visits[0]["sol_start"] if visits else None,
            "sol_end": visits[-1]["sol_end"] if visits else None,
            "breaks": breaks,
            "visits": visits,
        },
    }


def site_visits(waypoints: list[dict], b: dict) -> list[dict]:
    """Group in-bbox waypoints by site -> sol range per site."""
    visits: dict[int, dict] = {}
    for p in waypoints:
        if not in_bbox(p["lon"], p["lat"], b):
            continue
        v = visits.setdefault(p["site"], {"site": p["site"], "sol_start": p["sol"], "sol_end": p["sol"]})
        v["sol_start"] = min(v["sol_start"], p["sol"])
        v["sol_end"] = max(v["sol_end"], p["sol"])
    return sorted(visits.values(), key=lambda v: v["sol_start"])


def position_at_sol(waypoints_sorted: list[dict], sol: int) -> dict | None:
    """Last waypoint with sol <= given sol (rover's location that sol)."""
    pos = None
    for p in waypoints_sorted:
        if p["sol"] <= sol:
            pos = p
        else:
            break
    return pos


# ---------------------------------------------------------------- images
def query_images(sol_start: int, sol_end: int, instrument: str, per_page: int = 25) -> list[dict]:
    """One query per instrument: the API sorts by instrument, so a mixed query
    would return only Mastcam frames."""
    params = {
        "order": "sol desc,sample_type_sort asc",
        "per_page": per_page,
        "page": 0,
        "condition_1": "msl:mission",
        "condition_2": f"{sol_start}:sol:gte",
        "condition_3": f"{sol_end}:sol:lte",
        "search": instrument,
    }
    url = RAW_API + "?" + urllib.parse.urlencode(params)
    return fetch_json(url).get("items", [])


def best_image(items: list[dict]) -> dict | None:
    """Full frame preferred over subframe; thumbnails never."""
    cands = []
    for it in items:
        st = (it.get("extended") or {}).get("sample_type")
        if it.get("is_thumbnail") or st == "thumbnail":
            continue
        cands.append((0 if st == "full" else 1, -int(it["sol"]), it))
    cands.sort(key=lambda c: c[:2])
    return cands[0][2] if cands else None


def images_for_visit(v: dict, per_site: int) -> list[tuple[str, dict]]:
    """Up to per_site images, one per instrument, in QUERY_INSTRUMENTS order."""
    chosen = []
    for inst in QUERY_INSTRUMENTS:
        if len(chosen) >= per_site:
            break
        it = best_image(query_images(v["sol_start"], v["sol_end"], inst))
        if it:
            chosen.append((CAMERAS[inst], it))
    return chosen


def fix_url(url: str) -> str:
    """Old mars.jpl.nasa.gov links 301-redirect to mars.nasa.gov; skip the hop."""
    return url.replace("http://", "https://").replace("//mars.jpl.nasa.gov/", "//mars.nasa.gov/")


def to_record(cam: str, it: dict, wps_sorted: list[dict]) -> dict:
    sol = int(it["sol"])
    inst = it.get("instrument")
    pos = position_at_sol(wps_sorted, sol)
    credit = it.get("image_credit") or ("NASA/JPL-Caltech/MSSS" if cam in MSSS_CAMERAS else "NASA/JPL-Caltech")
    utc = (it.get("date_taken") or "").replace(".000Z", "Z")
    return {
        "url": fix_url(it.get("https_url") or it["url"]),
        "sol": sol,
        "camera": inst,
        "camera_name": cam,
        "utc": utc,
        "site": pos["site"] if pos else None,
        "drive": pos["drive"] if pos else None,
        "credit": credit,
    }


# ---------------------------------------------------------------- main
def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--refresh", action="store_true", help="re-download traverse/waypoints instead of using data/cache")
    ap.add_argument("--per-site", type=int, default=3, help="images per rover site (default 3)")
    ap.add_argument("--area", type=Path, help="alternative area.json (default web/data/area.json)")
    args = ap.parse_args()

    b = load_bbox(args.area)
    log(f"bbox {b}")

    wp_fc = fetch_json(WAYPOINTS_URL, "MSL_waypoints.json", args.refresh)
    tr_fc = fetch_json(TRAVERSE_URL, "MSL_traverse.json", args.refresh)
    waypoints = sorted((f["properties"] for f in wp_fc["features"]), key=lambda p: (p["sol"], p["site"], p["drive"]))
    log(f"{len(waypoints)} waypoints, {len(tr_fc['features'])} traverse segments")

    traverse = build_traverse(tr_fc, waypoints, b)
    n_pts = len(traverse["geometry"]["coordinates"])
    log(f"traverse in bbox: {len(traverse['properties']['visits'])} visit(s), {n_pts} points")

    visits = site_visits(waypoints, b)
    if not visits:
        log("WARNING: Curiosity never drove inside this bbox -> images.json will be empty")
    images: list[dict] = []
    for v in visits:
        try:
            chosen = images_for_visit(v, args.per_site)
        except RuntimeError as e:
            log(f"  site {v['site']}: {e}")
            continue
        images.extend(to_record(cam, it, waypoints) for cam, it in chosen)
        log(f"  site {v['site']:>3} sols {v['sol_start']}-{v['sol_end']}: {len(chosen)} image(s)")

    # de-duplicate by url, chronological
    uniq = {im["url"]: im for im in images}
    images = sorted(uniq.values(), key=lambda im: (im["sol"], im["utc"]))

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / "traverse.geojson").write_text(json.dumps(traverse, separators=(",", ":")))
    (OUT_DIR / "images.json").write_text(json.dumps(images, indent=1))
    log(f"wrote web/data/traverse.geojson ({n_pts} points) "
        f"and web/data/images.json ({len(images)} images)")


if __name__ == "__main__":
    main()
