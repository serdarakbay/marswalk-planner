"""Mars Trek WMTS layers -> web/data/layers.json

Reads each selected layer's endpoint, format, max zoom and coverage from the Mars Trek
catalog and its WMTSCapabilities.xml. Tile URLs follow the Leaflet EPSG4326 scheme:
2x1 tiles at zoom 0, order {z}/{y}/{x}.

Run:  python -m pipeline.fetch.trek
Raw responses are cached in data/cache/trek/; --refresh downloads them again.
If area.json exists, every layer is checked to cover the study area.
"""
from __future__ import annotations

import argparse
import json
import re
import sys

import requests

from pipeline.common import CACHE, WEB_DATA, bbox_covers, load_area, write_json

CATALOG_URL = (
    "https://trek.nasa.gov/mars/TrekServices/ws/index/eq/searchItems?start=0&rows=2147483647"
    "&facetKeys=itemType%7CproductCat2%7CserviceTypes%7CthumbnailURLDir"
    "&facetValues=product%7C-%28DEM%20ConfidenceRaw%20Slope%29%7CMosaic%7C%5B%2A%20TO%20%2A%5D"
)
SERVICES_URL = "https://trek.nasa.gov/mars/TrekServices/ws/index/getLayerServices?uuid="
TILE_PATH = "/1.0.0/default/default028mm/{z}/{y}/{x}."

# (id, UI name, type, Trek productLabel, credit). Order = order in the layer panel.
LAYERS = [
    ("hirise", "HiRISE mosaic", "base", "curiosity_hirise_mosaic", "NASA/JPL-Caltech/UArizona"),
    ("ctx", "CTX mosaic", "base", "Gale_CTX_BlockAdj_dd", "NASA/JPL-Caltech/MSSS"),
    ("viking", "Viking color mosaic", "base", "Mars_Viking_MDIM21_ClrMosaic_global_232m", "NASA/JPL/USGS"),
    ("themis_day", "Thermal IR (day)", "overlay", "THEMIS_DayIR_ControlledMosaics_100m_v2_oct2018", "NASA/JPL-Caltech/ASU"),
    ("themis_night", "Thermal IR (night)", "overlay", "THEMIS_NightIR_ControlledMosaics_100m_v2_oct2018", "NASA/JPL-Caltech/ASU"),
    ("mola_shade", "Elevation (MOLA/HRSC)", "overlay", "Mars_MOLA_blend200ppx_HRSC_ClrShade_clon0dd_200mpp_lzw", "NASA/JPL/GSFC, ESA/DLR/FU Berlin"),
]

CACHE_DIR = CACHE / "trek"
OUT_JSON = WEB_DATA / "layers.json"
EXT = {"image/png": "png", "image/jpeg": "jpg"}


def cached_get(url: str, name: str, refresh: bool) -> str:
    path = CACHE_DIR / name
    if path.exists() and not refresh:
        return path.read_text(encoding="utf-8")
    r = requests.get(url, timeout=90)
    r.raise_for_status()
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    path.write_text(r.text, encoding="utf-8")
    return r.text


def parse_bbox(s: str) -> dict:
    w, s_, e, n = (float(v) for v in s.split(","))
    return {"west": w, "south": s_, "east": e, "north": n}


def describe(doc: dict, refresh: bool) -> dict:
    label = doc["productLabel"]
    svc = json.loads(cached_get(SERVICES_URL + doc["item_UUID"], f"{label}_services.json", refresh))
    endpoint = svc["response"]["docs"][0]["endPoint"].rstrip("/")
    cap = cached_get(endpoint + "/1.0.0/WMTSCapabilities.xml", f"{label}_capabilities.xml", refresh)
    mime = re.search(r"<Format>([^<]+)</Format>", cap).group(1)
    zooms = [int(z) for z in re.findall(r"<TileMatrix>\s*<ows:Identifier>(\d+)</ows:Identifier>", cap)]
    return {"endpoint": endpoint, "format": EXT[mime], "maxNativeZoom": max(zooms),
            "bounds": parse_bbox(doc["bbox"])}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--refresh", action="store_true", help="ignore the cache and download again")
    args = ap.parse_args()

    try:
        area_bbox = load_area()["bbox"]
    except (FileNotFoundError, ValueError) as exc:
        print(f"WARNING: {exc} Skipping the coverage check.", file=sys.stderr)
        area_bbox = None

    docs = json.loads(cached_get(CATALOG_URL, "catalog_eq.json", args.refresh))["response"]["docs"]
    by_label = {d["productLabel"]: d for d in docs}

    out = []
    for layer_id, name, kind, label, credit in LAYERS:
        doc = by_label.get(label)
        if doc is None:
            print(f"WARNING: {label} is not in the Trek catalog, skipped", file=sys.stderr)
            continue
        info = describe(doc, args.refresh)
        if area_bbox and not bbox_covers(info["bounds"], area_bbox):
            print(f"WARNING: {label} does not cover the study area, skipped", file=sys.stderr)
            continue
        out.append({
            "id": layer_id,
            "name": name,
            "type": kind,
            "url": info["endpoint"] + TILE_PATH + info["format"],
            "fallbackUrl": None,
            "format": info["format"],
            "maxNativeZoom": info["maxNativeZoom"],
            "attribution": f"{credit}, NASA Mars Trek",
            "bounds": info["bounds"],
            "source": label,
        })
        print(f"{layer_id:13s} {kind:8s} z<={info['maxNativeZoom']:2d} {info['format']}  {label}")

    if not any(l["type"] == "base" for l in out):
        print("ERROR: no base layer", file=sys.stderr)
        return 1
    write_json(OUT_JSON, out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
