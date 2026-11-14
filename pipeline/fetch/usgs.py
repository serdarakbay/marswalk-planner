"""USGS global geologic map of Mars (SIM 3292) -> web/data/geology.geojson

Source: Tanaka, K.L., et al., 2014, Geologic map of Mars: USGS Scientific
Investigations Map 3292, scale 1:20,000,000, https://doi.org/10.3133/sim3292
(public domain). Queried from the USGS Astrogeology OGC API (pygeoapi).

At 1:20,000,000 the whole 2.4 km walk area lies in a single unit, so the
polygons are clipped to a disc around Gale crater instead. Zoomed out, the map
shows Gale's real geologic setting; the note of the unit that contains the walk
area says so.

Run:  python -m pipeline.fetch.usgs
The raw response is cached in data/cache/usgs/ and never re-fetched.
Standard library only.
"""
from __future__ import annotations

import hashlib
import json
import math
import sys
import urllib.parse
import urllib.request

from pipeline.common import CACHE, ROOT, WEB_DATA, load_area, write_json

API = "https://astrogeology.usgs.gov/pygeoapi/collections/mars/sim3292_global_geologic_map/units/items"
CACHE_DIR = CACHE / "usgs"
OUT = WEB_DATA / "geology.geojson"
PAGE = 100
USER_AGENT = "marswalk-planner-pipeline/1.0"

# Gale crater: centre 5.37 S, 137.81 E, about 154 km across. Units are clipped to a disc
# a little wider than the crater; the query box below just has to contain that disc.
GALE_CENTER = (137.81, -5.37)          # [lon, lat]
CLIP_RADIUS_KM = 90
GALE_REGION = {"west": 136.3, "south": -6.9, "east": 139.3, "north": -3.9}  # query box
MARS_RADIUS_M = 3396190                 # same sphere as the project CRS (CLAUDE.md)
CLIP_SIDES = 72

# Ring simplification, degrees (~60 m on Mars): far below what this map resolves.
SIMPLIFY_DEG = 0.001

SCALE_NOTE = "USGS SIM 3292 at 1:20,000,000; finer layers seen by Curiosity are not mapped at this scale."

# Short, plain-English notes for the units expected around Gale. Others fall back to unitdesc.
UNIT_NOTES = {
    "Htu": "Hesperian-age (about 3.7 to 3 billion years old) deposits.",
    "AHi": "Impact materials (crater rims, ejecta and floors) of Amazonian to Hesperian age; "
           "around Gale this maps the crater's impact-related terrain.",
    "mNh": "Middle Noachian highland crust: ancient, heavily cratered terrain, among the oldest on Mars.",
}


# --- fetch ----------------------------------------------------------------------------

def fetch_units(region: dict) -> list[dict]:
    bbox = f"{region['west']},{region['south']},{region['east']},{region['north']}"
    key = hashlib.sha1(f"{API}|{bbox}".encode()).hexdigest()[:12]
    cache = CACHE_DIR / f"sim3292_units_{key}.json"
    if cache.exists():
        print(f"cache: {cache.relative_to(ROOT)}")
        return json.loads(cache.read_text(encoding="utf-8"))

    features, offset = [], 0
    while True:
        params = {"bbox": bbox, "f": "json", "limit": PAGE, "offset": offset}
        url = API + "?" + urllib.parse.urlencode(params)
        print(f"USGS request: offset={offset} (slow: full polygons are returned)")
        # The server rejects Python's default User-Agent (HTTP 403)
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/geo+json"})
        with urllib.request.urlopen(req, timeout=300) as resp:
            page = json.loads(resp.read().decode("utf-8"))
        batch = page.get("features", [])
        features += batch
        if len(batch) < PAGE:
            break
        offset += PAGE
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cache.write_text(json.dumps(features), encoding="utf-8")
    return features


# --- geometry (lon/lat degrees; the region is small enough to treat as planar) ---------

def clip_disc() -> list:
    """Convex polygon (counter-clockwise, lon/lat) approximating the clip disc."""
    km_per_deg = 2 * math.pi * MARS_RADIUS_M / 1000 / 360
    lon0, lat0 = GALE_CENTER
    dlat = CLIP_RADIUS_KM / km_per_deg
    dlon = dlat / math.cos(math.radians(lat0))
    return [[lon0 + dlon * math.cos(2 * math.pi * i / CLIP_SIDES),
             lat0 + dlat * math.sin(2 * math.pi * i / CLIP_SIDES)] for i in range(CLIP_SIDES)]


def clip_ring(ring: list, clip: list) -> list:
    """Sutherland-Hodgman clip of one ring against a convex counter-clockwise polygon."""
    def inside(p, a, b):
        return (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]) >= 0

    def cross(p, q, a, b):
        x1, y1, x2, y2 = p[0], p[1], q[0], q[1]
        x3, y3, x4, y4 = a[0], a[1], b[0], b[1]
        den = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4)
        t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / den
        return [x1 + t * (x2 - x1), y1 + t * (y2 - y1)]

    pts = [[float(c[0]), float(c[1])] for c in ring]
    if pts and pts[0] == pts[-1]:
        pts = pts[:-1]
    for i, b in enumerate(clip):
        a = clip[i - 1]
        if not pts:
            break
        src, pts = pts, []
        for j, q in enumerate(src):
            p = src[j - 1]
            if inside(q, a, b):
                if not inside(p, a, b):
                    pts.append(cross(p, q, a, b))
                pts.append(q)
            elif inside(p, a, b):
                pts.append(cross(p, q, a, b))
    return pts


def simplify(pts: list, tol: float) -> list:
    """Ramer-Douglas-Peucker on an open polyline (iterative)."""
    if len(pts) < 3:
        return pts
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        i, j = stack.pop()
        (x1, y1), (x2, y2) = pts[i], pts[j]
        dx, dy = x2 - x1, y2 - y1
        norm = (dx * dx + dy * dy) ** 0.5
        best, idx = 0.0, -1
        for k in range(i + 1, j):
            x0, y0 = pts[k]
            d = abs(dy * x0 - dx * y0 + x2 * y1 - y2 * x1) / norm if norm else ((x0 - x1) ** 2 + (y0 - y1) ** 2) ** 0.5
            if d > best:
                best, idx = d, k
        if best > tol:
            keep[idx] = True
            stack += [(i, idx), (idx, j)]
    return [p for p, k in zip(pts, keep) if k]


def ring_area(r: list) -> float:
    return abs(sum(r[i - 1][0] * r[i][1] - r[i][0] * r[i - 1][1] for i in range(len(r)))) / 2


def finish_ring(pts: list) -> list | None:
    pts = simplify(pts, SIMPLIFY_DEG)
    out = []
    for x, y in pts:
        p = [round(x, 4), round(y, 4)]
        if not out or p != out[-1]:
            out.append(p)
    if len(out) < 3 or ring_area(out) < SIMPLIFY_DEG ** 2:
        return None
    return out + [out[0]]


def point_in_ring(pt: list, ring: list) -> bool:
    x, y = pt
    inside = False
    for i in range(len(ring) - 1):
        (x1, y1), (x2, y2) = ring[i], ring[i + 1]
        if (y1 > y) != (y2 > y) and x < x1 + (y - y1) * (x2 - x1) / (y2 - y1):
            inside = not inside
    return inside


def contains(polys: list, pt: list) -> bool:
    return any(point_in_ring(pt, p[0]) and not any(point_in_ring(pt, h) for h in p[1:]) for p in polys)


# --- build ------------------------------------------------------------------------------

def build() -> dict:
    area = load_area()
    b = area["bbox"]
    disc = clip_disc()
    corners = [[b["west"], b["south"]], [b["east"], b["south"]], [b["east"], b["north"]], [b["west"], b["north"]]]
    if not all(point_in_ring(c, disc + [disc[0]]) for c in corners):
        sys.exit("The clip disc does not contain area.json's bbox; check GALE_CENTER / CLIP_RADIUS_KM")
    walk_pt = area.get("habitat") or [(b["west"] + b["east"]) / 2, (b["south"] + b["north"]) / 2]

    out = []
    for f in fetch_units(GALE_REGION):
        g, p = f["geometry"], f["properties"]
        src = g["coordinates"] if g["type"] == "MultiPolygon" else [g["coordinates"]]
        polys = []
        for poly in src:
            outer = finish_ring(clip_ring(poly[0], disc))
            if not outer:
                continue
            holes = [h for h in (finish_ring(clip_ring(r, disc)) for r in poly[1:]) if h]
            polys.append([outer] + holes)
        if not polys:
            continue
        unit = p.get("unit", "?")
        desc = (p.get("unitdesc") or unit).strip()
        here = contains(polys, walk_pt)
        note = UNIT_NOTES.get(unit, f"{desc}.")
        if here:
            note += " The whole walk area lies in this unit."
        note += " " + SCALE_NOTE
        out.append({
            "type": "Feature",
            "geometry": {"type": "MultiPolygon" if len(polys) > 1 else "Polygon",
                         "coordinates": polys if len(polys) > 1 else polys[0]},
            "properties": {"unit": unit, "name": desc[0].upper() + desc[1:], "note": note},
        })

    if not out:
        sys.exit("USGS returned no units for the Gale region")
    out.sort(key=lambda ft: ft["properties"]["unit"])
    return {
        "type": "FeatureCollection",
        "source": "USGS SIM 3292, Tanaka et al. 2014, Geologic map of Mars (public domain)",
        "doi": "https://doi.org/10.3133/sim3292",
        "scale": "1:20,000,000",
        "clip": {"center": list(GALE_CENTER), "radius_km": CLIP_RADIUS_KM},
        "features": out,
    }


def main() -> None:
    data = build()
    write_json(OUT, data, indent=None)
    for ft in data["features"]:
        print(f"  {ft['properties']['unit']:5s} {ft['properties']['name']}")


if __name__ == "__main__":
    main()
