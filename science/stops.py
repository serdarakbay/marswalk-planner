"""Science stops along the clay -> sulfate story -> web/data/stops.json

Three stops, in this order: clay-bearing unit, clay-sulfate transition, sulfate-bearing unit.

- Candidates are the rover positions where Curiosity took the photos in images.json, so every
  stop sits on the real traverse and its photos show that place.
- The unit of a candidate comes from the sols of its photos (boundaries below). The USGS map in
  geology.geojson (1:20M) is too coarse to separate these units; its unit is recorded anyway.
- Among all candidate triples (at least MIN_STOP_SPACING_M apart) the shortest straight-line
  loop habitat -> 1 -> 2 -> 3 -> habitat is tried first. Each loop is then checked on Demir's
  cost grid (same least-cost search and walking model as arazi/route.py): total time must fit
  the EVA window (eva_window.json) and O2 must stay above the reserve (mission.json).

Run:  python -m science.stops    (the time/O2 check needs data/cache/dem_clip.tif and cost.tif)
"""
from __future__ import annotations

import itertools
import json
import math
import sys

import numpy as np

from pipeline.common import CACHE, WEB_DATA, load_area, load_mission, write_json

# Approximate sol boundaries between the units (assumption, see docs/story/assumptions.md).
# Inside the bbox Curiosity has no sols between 3005 and 3202, so the first boundary is safe
# anywhere in that gap; the second follows NASA's October 2022 report that the rover had
# reached the sulfate-bearing region.
TRANSITION_FIRST_SOL = 3100
SULFATE_FIRST_SOL = 3600

MIN_STOP_SPACING_M = 200      # stops must be distinct places
PHOTO_RADIUS_M = 30           # photos taken within this distance of the stop
MAX_PHOTOS = 3
ROUTE_SAMPLE_M = 5            # same vertex spacing as arazi/route.py
R = 3396190.0
M_PER_DEG = math.pi * R / 180

UNITS = [
    {
        "key": "clay",
        "name": "Clay-bearing mudstone",
        "observe": "Mudstone of the clay-bearing unit. Clay minerals form when rock sits in "
                   "water for a long time.",
        "question": "How long did the lake last here, and was its water calm and habitable?",
        "human": "A geologist can scan the whole outcrop, pick the freshest layers and sample "
                 "several of them in one EVA; the rover waits for a new plan from Earth, "
                 "usually once per sol, before each choice.",
    },
    {
        "key": "transition",
        "name": "Clay-to-sulfate transition",
        "observe": "Layers where clay-rich rock gives way to sulfate-rich rock.",
        "question": "Did the climate dry out gradually, or in wet and dry cycles?",
        "human": "A person can follow one layer along the slope, see where the rock type changes "
                 "and collect samples on both sides of the change.",
    },
    {
        "key": "sulfate",
        "name": "Sulfate-bearing layers",
        "observe": "Layers rich in sulfate salts, which are left behind when water evaporates.",
        "question": "Did the lake dry up for good here, or did water come back later?",
        "human": "A geologist can break rock open to expose fresh salt and choose the best "
                 "samples on the spot, faster than the rover's step-by-step commanding.",
    },
]


def dist_m(a, b):
    lat = math.radians((a[1] + b[1]) / 2)
    return math.hypot((b[0] - a[0]) * M_PER_DEG * math.cos(lat), (b[1] - a[1]) * M_PER_DEG)


def unit_of_sol(sol: int) -> str:
    if sol < TRANSITION_FIRST_SOL:
        return "clay"
    return "transition" if sol < SULFATE_FIRST_SOL else "sulfate"


def in_ring(p, ring):
    x, y, hit = p[0], p[1], False
    for (x1, y1), (x2, y2) in zip(ring, ring[1:]):
        if (y1 > y) != (y2 > y) and x < x1 + (y - y1) * (x2 - x1) / (y2 - y1):
            hit = not hit
    return hit


def map_unit(p, geology):
    """USGS unit at p (outer ring minus holes), or None."""
    for f in (geology or {}).get("features", []):
        rings = f["geometry"]["coordinates"]
        if in_ring(p, rings[0]) and not any(in_ring(p, h) for h in rings[1:]):
            return f["properties"].get("unit")
    return None


def candidates(images):
    """Rover positions with photos, grouped; unit from the earliest sol at that spot."""
    spots = {}
    for im in images:
        if not im.get("coord"):
            continue
        key = (round(im["coord"][0], 5), round(im["coord"][1], 5))
        spots.setdefault(key, []).append(im)
    out = []
    for (lon, lat), ims in spots.items():
        sols = sorted({im["sol"] for im in ims})
        units = {unit_of_sol(s) for s in sols}
        if len(units) == 1:
            out.append({"coord": [lon, lat], "unit": units.pop(), "sols": sols})
    return out


def pick_photos(coord, images):
    near = sorted((im for im in images
                   if im.get("coord") and dist_m(coord, im["coord"]) <= PHOTO_RADIUS_M),
                  key=lambda im: (dist_m(coord, im["coord"]), im["sol"]))
    photos, cameras = [], set()
    for im in near:
        cam = im.get("camera_name") or im["camera"]
        if cam not in cameras:
            photos.append(im)
            cameras.add(cam)
        if len(photos) == MAX_PHOTOS:
            break
    return [{"url": p["url"], "sol": p["sol"], "camera": p["camera"], "credit": p["credit"],
             "camera_name": p.get("camera_name"), "utc": p.get("utc")} for p in photos]


# --- Time and O2 on Demir's cost grid ---------------------------------------------------------

class Walker:
    """Least-cost walking between points on cost.tif, like arazi/route.py."""

    def __init__(self):
        import rasterio
        from rasterio.warp import transform as warp
        from scipy.ndimage import distance_transform_edt
        from skimage.graph import MCP_Geometric
        from arazi.geo import MARS_GEO
        from arazi import walk

        with rasterio.open(CACHE / "cost.tif") as ds:
            cost = ds.read(1).astype("float64")
            self.tr, self.crs = ds.transform, ds.crs
        with rasterio.open(CACHE / "dem_clip.tif") as ds:
            self.z = ds.read(1).astype("float64")
        self.res = abs(self.tr.a)
        blocked = ~np.isfinite(cost)
        cost[blocked] = np.inf
        _, self.near = distance_transform_edt(blocked, return_indices=True)
        self.mcp = MCP_Geometric(cost, fully_connected=True)
        self.walk, self.warp, self.geo = walk, warp, MARS_GEO
        self.shape = cost.shape

    def pixel(self, p):
        xs, ys = self.warp(self.geo, self.crs, [p[0]], [p[1]])
        col, row = ~self.tr * (xs[0], ys[0])
        r = int(np.clip(row, 0, self.shape[0] - 1))
        c = int(np.clip(col, 0, self.shape[1] - 1))
        return int(self.near[0][r, c]), int(self.near[1][r, c])

    def elevation(self, p):
        r, c = self.pixel(p)
        return float(self.z[r, c])

    def loop(self, points, n_stops, dwell_min):
        """(distance_m, minutes, o2_pct) for habitat -> points... -> habitat, or None if blocked."""
        px = [self.pixel(p) for p in points]
        path = []
        for a, b in zip(px[:-1], px[1:]):
            costs, _ = self.mcp.find_costs([a], [b])
            if not np.isfinite(costs[b]):
                return None
            leg = self.mcp.traceback(b)
            path.extend(leg if not path else leg[1:])
        path = np.array(path)
        d_full = np.concatenate([[0], np.cumsum(np.hypot(*np.diff(path, axis=0).T) * self.res)])
        keep, nxt = [], 0.0
        for i, d in enumerate(d_full):
            if d >= nxt or i == len(d_full) - 1:
                keep.append(i)
                nxt = d + ROUTE_SAMPLE_M
        d = d_full[keep]
        zs = self.z[path[keep, 0], path[keep, 1]]
        seg = np.diff(d)
        grade = np.divide(np.diff(zs), seg, out=np.zeros_like(seg), where=seg > 0)
        seg_min = seg / self.walk.speed_m_min(grade)
        minutes = float(seg_min.sum() + n_stops * dwell_min)
        o2 = float(self.walk.o2_walk_pct(seg_min, grade).sum() + self.walk.o2_rest_pct(n_stops * dwell_min))
        return float(d[-1]), minutes, o2


def main() -> int:
    area, mission = load_area(), load_mission()
    habitat = area["habitat"]
    images = json.loads((WEB_DATA / "images.json").read_text(encoding="utf-8"))
    try:
        geology = json.loads((WEB_DATA / "geology.geojson").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        geology = None
    try:
        eva_min = float(json.loads((WEB_DATA / "eva_window.json").read_text(encoding="utf-8"))["duration_min"])
    except (OSError, ValueError, KeyError, TypeError):
        eva_min = mission["eva_nominal_hours"] * 60
        print(f"WARNING: eva_window.json unreadable; using eva_nominal_hours ({eva_min:.0f} min)", file=sys.stderr)
    o2_limit = 100 - mission["o2_reserve_pct"]
    dwell = mission["stop_dwell_min"]

    cands = candidates(images)
    by_unit = {u["key"]: [c for c in cands if c["unit"] == u["key"]] for u in UNITS}
    for k, v in by_unit.items():
        print(f"candidates {k:10s}: {len(v)}")
        if not v:
            print(f"ERROR: no photo location in the {k} unit", file=sys.stderr)
            return 1

    def straight(trip):
        pts = [habitat, *[c["coord"] for c in trip], habitat]
        return sum(dist_m(a, b) for a, b in zip(pts, pts[1:]))

    trips = [t for t in itertools.product(*(by_unit[u["key"]] for u in UNITS))
             if all(dist_m(a["coord"], b["coord"]) >= MIN_STOP_SPACING_M for a, b in itertools.combinations(t, 2))]
    trips.sort(key=straight)

    try:
        walker = Walker()
    except Exception as exc:   # rasterio or rasters missing: keep the shortest loop, unchecked
        print(f"WARNING: cannot check time/O2 on the cost grid ({exc}); using the shortest loop", file=sys.stderr)
        walker = None

    chosen, estimate = None, None
    for trip in trips:
        if walker is None:
            chosen = trip
            break
        est = walker.loop([habitat, *[c["coord"] for c in trip], habitat], len(trip), dwell)
        if est and est[1] <= eva_min and est[2] <= o2_limit:
            chosen, estimate = trip, est
            break
    if chosen is None:
        print("ERROR: no stop triple fits the EVA window and O2 reserve", file=sys.stderr)
        return 1

    stops = []
    for i, (unit, c) in enumerate(zip(UNITS, chosen), 1):
        photos = pick_photos(c["coord"], images)
        sols = sorted({p["sol"] for p in photos})
        first = min(photos, key=lambda p: p["sol"])
        visited = (f"Curiosity photographed this spot on sol {sols[0]} ({first['utc'][:10]})."
                   if len(sols) == 1 else
                   f"Curiosity photographed this spot on sols {', '.join(map(str, sols))} "
                   f"(from {first['utc'][:10]}).")
        stops.append({
            "id": f"s{i}",
            "name": unit["name"],
            "coord": c["coord"],
            "science": f"{unit['observe']} {unit['question']} {unit['human']} {visited}",
            "photos": photos,
            "unit": unit["key"],
            "map_unit": map_unit(c["coord"], geology),
            "unit_basis": f"Curiosity sols {sols[0]}-{sols[-1]} at this spot "
                          f"(transition from sol {TRANSITION_FIRST_SOL}, sulfate from sol {SULFATE_FIRST_SOL}; approximate)",
        })
    write_json(WEB_DATA / "stops.json", stops)

    print(f"habitat {habitat}")
    for s in stops:
        z = f"{walker.elevation(s['coord']):.1f} m" if walker else "n/a"
        print(f"{s['id']} {s['unit']:10s} {s['coord']}  map unit {s['map_unit']}  "
              f"{dist_m(habitat, s['coord']):6.0f} m from habitat  elevation {z}  "
              f"photos sol {[p['sol'] for p in s['photos']]} {[p['camera_name'] for p in s['photos']]}")
    print(f"straight-line loop: {straight(chosen):.0f} m")
    if estimate:
        d, t, o2 = estimate
        print(f"estimate on the cost grid: {d:.0f} m, {t:.0f} min (EVA window {eva_min:.0f} min), "
              f"O2 {o2:.1f} % (limit {o2_limit} %, reserve {mission['o2_reserve_pct']} %)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
