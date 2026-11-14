"""Backup tile cache: Mars Trek tiles for the study area -> web/tiles/<layer_id>/{z}/{y}/{x}.<ext>

The map falls back to these files when a Trek tile fails to load (web/js/map/index.js).
Tile grid: Leaflet EPSG4326 / Trek WMTS, 2 x 1 tiles of 256 px at zoom 0, top-left (-180, 90),
so a tile is 180 / 2^z degrees wide; URL order {z}/{y}/{x}.

Run:
  python -m pipeline.fetch.tiles                 plan only: tiles and estimated MB per layer/zoom
  python -m pipeline.fetch.tiles --download      download (skips tiles already on disk)
  --max-zoom ID=Z ...                            cap a layer below its maxNativeZoom
  --budget-mb N                                  plan warns above this total (default 100)

After a download, fallbackUrl in web/data/layers.json is set for every layer that has a
web/tiles/<layer_id>/ folder. The plan step sends a few HEAD requests (no tile bodies) to
estimate tile sizes.
"""
from __future__ import annotations

import argparse
import json
import math
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests

from pipeline.common import ROOT, WEB_DATA, load_area, write_json

TILES_DIR = ROOT / "web" / "tiles"
LAYERS_JSON = WEB_DATA / "layers.json"
WORKERS = 4                # parallel requests to Trek (keep it polite)
RETRIES = 4
BACKOFF_S = 2.0
TIMEOUT_S = 30
SAMPLE_TILES = 4           # HEAD requests per layer for the size estimate
DEFAULT_BUDGET_MB = 100


def fallback_url(layer: dict) -> str:
    """Local tile template, relative to web/ (the page root)."""
    return f"tiles/{layer['id']}/{{z}}/{{y}}/{{x}}.{layer['format']}"


def tile_range(bbox: dict, z: int):
    """Inclusive x and y ranges of the tiles covering bbox at zoom z."""
    size = 180.0 / 2 ** z
    eps = 1e-12
    x0 = math.floor((bbox["west"] + 180) / size)
    x1 = math.floor((bbox["east"] + 180 - eps) / size)
    y0 = math.floor((90 - bbox["north"]) / size)
    y1 = math.floor((90 - bbox["south"] - eps) / size)
    return range(x0, x1 + 1), range(y0, y1 + 1)


def tiles_for(layer: dict, bbox: dict, max_zoom: int):
    for z in range(0, max_zoom + 1):
        xs, ys = tile_range(bbox, z)
        for y in ys:
            for x in xs:
                yield z, y, x


def tile_url(layer, z, y, x):
    return layer["url"].replace("{z}", str(z)).replace("{y}", str(y)).replace("{x}", str(x))


def tile_path(layer, z, y, x):
    return TILES_DIR / layer["id"] / str(z) / str(y) / f"{x}.{layer['format']}"


def sample_size(session, layer, bbox, max_zoom) -> float | None:
    """Mean Content-Length (bytes) of a few tiles at the top zooms, via HEAD."""
    sizes = []
    for z in range(max_zoom, max(-1, max_zoom - 2), -1):
        xs, ys = tile_range(bbox, z)
        picks = [(z, ys[len(ys) // 2], xs[len(xs) // 2]), (z, ys[0], xs[0]), (z, ys[-1], xs[-1])]
        for t in picks:
            if len(sizes) >= SAMPLE_TILES:
                break
            try:
                r = session.head(tile_url(layer, *t), timeout=TIMEOUT_S, allow_redirects=True)
                if r.status_code == 200 and r.headers.get("Content-Length"):
                    sizes.append(int(r.headers["Content-Length"]))
            except requests.RequestException:
                pass
    return sum(sizes) / len(sizes) if sizes else None


def fetch_one(session, layer, z, y, x):
    """Download one tile with retries. Returns 'skip', 'ok', 'missing' or 'error'."""
    path = tile_path(layer, z, y, x)
    if path.exists() and path.stat().st_size > 0:
        return "skip"
    url = tile_url(layer, z, y, x)
    for attempt in range(RETRIES):
        try:
            r = session.get(url, timeout=TIMEOUT_S)
            if r.status_code == 404:
                return "missing"            # outside the layer's coverage
            if r.status_code == 200 and r.content:
                path.parent.mkdir(parents=True, exist_ok=True)
                tmp = path.with_suffix(path.suffix + ".part")
                tmp.write_bytes(r.content)
                tmp.replace(path)
                return "ok"
        except requests.RequestException:
            pass
        time.sleep(BACKOFF_S * 2 ** attempt)
    return "error"


def set_fallbacks(layers: list[dict]) -> list[str]:
    """fallbackUrl for layers that have a local tile folder; null otherwise."""
    changed = []
    for layer in layers:
        new = fallback_url(layer) if (TILES_DIR / layer["id"]).is_dir() else None
        if layer.get("fallbackUrl") != new:
            changed.append(layer["id"])
        layer["fallbackUrl"] = new
    return changed


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--download", action="store_true", help="download tiles (default: plan only)")
    ap.add_argument("--max-zoom", nargs="*", default=[], metavar="ID=Z", help="cap zoom for a layer")
    ap.add_argument("--budget-mb", type=float, default=DEFAULT_BUDGET_MB)
    args = ap.parse_args()

    bbox = load_area()["bbox"]
    layers = json.loads(LAYERS_JSON.read_text(encoding="utf-8"))
    caps = dict(item.split("=", 1) for item in args.max_zoom)
    session = requests.Session()

    plan = []
    for layer in layers:
        zmax = min(layer["maxNativeZoom"], int(caps.get(layer["id"], layer["maxNativeZoom"])))
        plan.append((layer, zmax))

    if not args.download:
        total_tiles, total_mb = 0, 0.0
        print(f"bbox {bbox}")
        print(f"{'layer':13s} {'fmt':4s} {'zoom':>4s} {'tiles':>6s} {'est. MB':>8s}")
        for layer, zmax in plan:
            mean = sample_size(session, layer, bbox, zmax)
            per_tile_mb = (mean or 0) / 1e6
            layer_tiles = 0
            for z in range(0, zmax + 1):
                xs, ys = tile_range(bbox, z)
                n = len(xs) * len(ys)
                layer_tiles += n
                print(f"{layer['id']:13s} {layer['format']:4s} {z:4d} {n:6d} {n * per_tile_mb:8.2f}")
            mb = layer_tiles * per_tile_mb
            note = f"mean tile {mean / 1e3:.0f} kB from HEAD" if mean else "no size sample (HEAD failed)"
            print(f"{layer['id']:13s} total z0-{zmax}: {layer_tiles} tiles, ~{mb:.1f} MB ({note})")
            total_tiles += layer_tiles
            total_mb += mb
        flag = "OK" if total_mb <= args.budget_mb else "OVER BUDGET"
        print(f"TOTAL: {total_tiles} tiles, ~{total_mb:.1f} MB (budget {args.budget_mb:.0f} MB: {flag})")
        print("Nothing downloaded. Run with --download to fetch.")
        return 0

    jobs = [(layer, z, y, x) for layer, zmax in plan for z, y, x in tiles_for(layer, bbox, zmax)]
    counts = {"ok": 0, "skip": 0, "missing": 0, "error": 0}
    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        futures = [pool.submit(fetch_one, session, *job) for job in jobs]
        for i, f in enumerate(as_completed(futures), 1):
            counts[f.result()] += 1
            if i % 100 == 0 or i == len(futures):
                print(f"  {i}/{len(futures)} {counts}")
    size_mb = sum(p.stat().st_size for p in TILES_DIR.rglob("*") if p.is_file()) / 1e6
    print(f"done: {counts}; web/tiles/ is {size_mb:.1f} MB")

    changed = set_fallbacks(layers)
    write_json(LAYERS_JSON, layers)
    print(f"fallbackUrl updated for: {changed or 'none'}")
    return 1 if counts["error"] else 0


if __name__ == "__main__":
    sys.exit(main())
