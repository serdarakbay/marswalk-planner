# route.py
# Finds the lowest-cost walking route on cost.tif: habitat -> stops -> habitat.
# Impassable pixels (NaN: too steep or NoData) are never crossed.
# Writes web/data/route.geojson and web/data/summary.json (docs/contracts.md).
# Run: python -m arazi.route   (needs data/cache/dem_clip.tif, slope.tif, cost.tif)

import json

import numpy as np
import rasterio
from rasterio.warp import transform as warp_coords
from scipy.ndimage import distance_transform_edt
from skimage.graph import MCP_Geometric

from arazi.geo import CACHE, MARS_GEO, ROOT, WEB, load_area
from arazi.walk import STOP_DWELL_MIN, dose_mSv, o2_rest_pct, o2_walk_pct, speed_m_min

# Used only until Utku's stops.json exists: two placeholder stops near the habitat
_DEFAULT_STOPS = [[137.375, -4.745], [137.392, -4.741]]

SAMPLE_EVERY_M = 5          # keep one route vertex every ~5 m
PROFILE_EVERY_M = 10        # summary.profile spacing

area = load_area()


def load_stops():
    path = WEB / "data" / "stops.json"
    if path.exists():
        return [s["coord"] for s in json.loads(path.read_text(encoding="utf-8"))]
    print("WARNING: web/data/stops.json not found, using placeholder stops")
    return _DEFAULT_STOPS


# --- Load rasters (metric grid, 1 m pixels) ---
with rasterio.open(CACHE / "cost.tif") as ds:
    cost = ds.read(1).astype("float64")
    crs, tr = ds.crs, ds.transform
    res = abs(tr.a)
with rasterio.open(CACHE / "slope.tif") as ds:
    slope = ds.read(1).astype("float64")
with rasterio.open(CACHE / "dem_clip.tif") as ds:
    z = ds.read(1).astype("float64")

blocked = ~np.isfinite(cost)
cost[blocked] = np.inf
# For every pixel, index of the nearest passable pixel (to snap points)
_, (near_r, near_c) = distance_transform_edt(blocked, return_indices=True)


def lonlat_to_pixel(lon, lat):
    xs, ys = warp_coords(MARS_GEO, crs, [lon], [lat])
    col, row = ~tr * (xs[0], ys[0])
    row = int(np.clip(row, 0, cost.shape[0] - 1))
    col = int(np.clip(col, 0, cost.shape[1] - 1))
    return int(near_r[row, col]), int(near_c[row, col])


# --- Route: habitat -> stops -> habitat ---
waypoints = [area["habitat"], *load_stops(), area["habitat"]]
pixels = [lonlat_to_pixel(*p) for p in waypoints]

mcp = MCP_Geometric(cost, fully_connected=True)
path, stop_index = [], []        # stop_index: path position of each stop
for i, (a, b) in enumerate(zip(pixels[:-1], pixels[1:])):
    costs, _ = mcp.find_costs([a], [b])
    if not np.isfinite(costs[b]):
        raise SystemExit(f"No passable route between waypoint {i} and {i + 1}")
    leg = mcp.traceback(b)
    path.extend(leg if not path else leg[1:])
    if i < len(pixels) - 2:
        stop_index.append(len(path) - 1)

path = np.array(path)
step = np.hypot(*np.diff(path, axis=0).T) * res
d_full = np.concatenate([[0], np.cumsum(step)])

# Keep a vertex every SAMPLE_EVERY_M metres, plus every stop and the end point
keep = {0, len(path) - 1, *stop_index}
next_d = 0.0
for i, d in enumerate(d_full):
    if d >= next_d:
        keep.add(i)
        next_d = d + SAMPLE_EVERY_M
keep = sorted(keep)

rows, cols = path[keep, 0], path[keep, 1]
d = d_full[keep]
zs = z[rows, cols]
slopes = slope[rows, cols]

# Time: walking speed from the grade of each segment, plus dwell at stops
seg_len = np.diff(d)
grade = np.divide(np.diff(zs), seg_len, out=np.zeros_like(seg_len), where=seg_len > 0)
seg_min = seg_len / speed_m_min(grade)
t = np.concatenate([[0], np.cumsum(seg_min)])
for si in stop_index:
    t[np.array(keep) >= si] += STOP_DWELL_MIN

# Pixel centres -> lon/lat
xs, ys = tr * (cols + 0.5, rows + 0.5)
lons, lats = warp_coords(crs, MARS_GEO, list(xs), list(ys))

route = {
    "type": "Feature",
    "geometry": {
        "type": "LineString",
        "coordinates": [[round(lo, 6), round(la, 6)] for lo, la in zip(lons, lats)],
    },
    "properties": {
        "slope_deg": [round(float(s), 1) for s in slopes],
        "t_min": [round(float(x), 1) for x in t],
    },
}

# Elevation profile every PROFILE_EVERY_M metres
prof_idx = np.searchsorted(d, np.arange(0, d[-1], PROFILE_EVERY_M))
prof_idx = np.unique(np.append(prof_idx, len(d) - 1))
duration = float(t[-1])
# O2: each segment at its own grade (uphill costs more), plus standing at the stops
o2_used = float(o2_walk_pct(seg_min, grade).sum() + o2_rest_pct(STOP_DWELL_MIN * len(stop_index)))
summary = {
    "distance_m": round(float(d[-1])),
    "duration_min": round(duration),
    "o2_used_pct": round(o2_used, 1),
    "dose_mSv": round(float(dose_mSv(duration)), 3),
    "max_slope_deg": round(float(slopes.max()), 1),
    "profile": [{"d": round(float(d[i])), "z": round(float(zs[i]), 1),
                 "slope": round(float(slopes[i]), 1)} for i in prof_idx],
}

def traverse_lines(path):
    """Curiosity traverse (Egemen's traverse.geojson) as a list of [lon, lat] lines."""
    t = json.loads(path.read_text(encoding="utf-8"))
    geoms = [f["geometry"] for f in t["features"]] if t.get("type") == "FeatureCollection" \
        else [t.get("geometry", t)]
    lines = []
    for g in geoms:
        if g["type"] == "LineString":
            lines.append(g["coordinates"])
        elif g["type"] == "MultiLineString":
            lines.extend(g["coordinates"])
    return lines


def compare_with_traverse(route_x, route_y):
    """How far (metres) our route stays from the path Curiosity's drivers chose."""
    segs = []
    for line in traverse_lines(WEB / "data" / "traverse.geojson"):
        pts = np.array(line)[:, :2]
        tx, ty = warp_coords(MARS_GEO, crs, list(pts[:, 0]), list(pts[:, 1]))
        p = np.c_[tx, ty]
        segs.extend(zip(p[:-1], p[1:]))
    a = np.array([s[0] for s in segs])
    ab = np.array([s[1] for s in segs]) - a
    ab2 = np.maximum((ab * ab).sum(1), 1e-9)

    # Resample our route every 1 m so the mean is weighted by distance, not by vertex
    r = np.c_[route_x, route_y]
    along = np.concatenate([[0], np.cumsum(np.hypot(*np.diff(r, axis=0).T))])
    dd = np.arange(0, along[-1], 1.0)
    pts = np.c_[np.interp(dd, along, r[:, 0]), np.interp(dd, along, r[:, 1])]

    def nearest(p):
        t = np.clip(((p - a) * ab).sum(1) / ab2, 0, 1)
        return np.hypot(*(a + ab * t[:, None] - p).T).min()

    dist = np.array([nearest(p) for p in pts])
    return {
        "mean_m": round(float(dist.mean())),
        "median_m": round(float(np.median(dist))),
        "max_m": round(float(dist.max())),
        "within_100m_pct": round(float((dist <= 100).mean() * 100)),
    }


try:
    summary["curiosity_traverse"] = compare_with_traverse(xs, ys)
except Exception as exc:   # traverse.geojson missing or broken: skip, keep the route
    print(f"WARNING: no Curiosity traverse comparison ({exc})")

# Keep the "terrain" block written by arazi.heightmap (Egemen's 3D view)
old_summary = WEB / "data" / "summary.json"
if old_summary.exists():
    terrain = json.loads(old_summary.read_text(encoding="utf-8")).get("terrain")
    if terrain:
        summary["terrain"] = terrain

for name, obj in [("route.geojson", route), ("summary.json", summary)]:
    out = WEB / "data" / name
    out.write_text(json.dumps(obj, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"Saved: {out.relative_to(ROOT)} | {out.stat().st_size / 1e3:.0f} kB")

print({k: v for k, v in summary.items() if k != "profile"})
print("Route vertices:", len(d), "| stops:", len(stop_index))
