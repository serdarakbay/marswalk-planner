# return_rings.py
# "Return rings": for every pixel, how many minutes it takes to walk back to the
# habitat on the safest path (impassable pixels are never crossed). Saved as a
# banded overlay (web/data/overlays/return_time.png) and added to overlays.json.
# Conservative: every step is treated as uphill (the way back may climb).
# Run: python -m arazi.return_rings   (after arazi.cost; re-run arazi.overlays first
#      if you regenerate the other layers, since this appends to overlays.json)

import json

import numpy as np
import rasterio
from matplotlib.colors import ListedColormap
from matplotlib import colormaps
from rasterio.warp import Resampling
from rasterio.warp import transform as warp_coords
from scipy.ndimage import distance_transform_edt
from skimage.graph import MCP_Geometric

from arazi.geo import CACHE, MARS_GEO, ROOT, WEB, load_area, to_overlay_png
from arazi.walk import o2_used_pct, speed_m_min

BAND_MIN = 10                          # one colour band per 10 minutes
BAND_COLORS = ["#2e9e5b", "#7cc35a", "#e8c547", "#ef8a3a", "#d64545", "#8e2c6e"]
UNREACHABLE = "#555555"

with rasterio.open(CACHE / "slope.tif") as ds:
    slope = ds.read(1).astype("float64")
    crs, tr, profile = ds.crs, ds.transform, ds.profile.copy()
with rasterio.open(CACHE / "cost.tif") as ds:
    blocked = ~np.isfinite(ds.read(1))
res = abs(tr.a)

# Minutes needed to walk one metre across each pixel
min_per_m = 1 / speed_m_min(np.tan(np.radians(slope)))
min_per_m[blocked] = np.inf

# Snap the habitat to the nearest passable pixel
lon, lat = load_area()["habitat"]
xs, ys = warp_coords(MARS_GEO, crs, [lon], [lat])
col, row = ~tr * (xs[0], ys[0])
_, (near_r, near_c) = distance_transform_edt(blocked, return_indices=True)
start = (int(near_r[int(row), int(col)]), int(near_c[int(row), int(col)]))

# MCP costs are in pixel units -> multiply by pixel size to get minutes
minutes, _ = MCP_Geometric(min_per_m, fully_connected=True).find_costs([start])
minutes = minutes * res
minutes[~np.isfinite(minutes)] = np.nan

profile.update(dtype="float32", nodata=np.nan, compress="deflate")
with rasterio.open(CACHE / "return_time.tif", "w", **profile) as dst:
    dst.write(minutes.astype("float32"), 1)

reach = minutes[np.isfinite(minutes)]
print("Return time (min) median/max:", round(float(np.median(reach)), 1), round(float(reach.max()), 1))
print("O2 for the longest return: %", round(float(o2_used_pct(reach.max())), 1))
print("Unreachable area: %", round(float(np.isnan(minutes).mean() * 100), 1))

# Banded colours: 0-10, 10-20, ... last band is open-ended
n = len(BAND_COLORS)
colormaps.register(ListedColormap(BAND_COLORS, name="return_bands"), force=True)
legend = []
for i, c in enumerate(BAND_COLORS):
    lo, hi = i * BAND_MIN, (i + 1) * BAND_MIN
    o2 = float(o2_used_pct(hi))
    label = f"{lo}–{hi} min (O2 ≤ {o2:.0f}%)" if i < n - 1 else f"> {lo} min"
    legend.append({"color": c, "label": label})
legend.append({"color": UNREACHABLE, "label": "Unreachable"})

entry = to_overlay_png(
    (minutes, tr, crs), WEB / "data" / "overlays" / "return_time.png",
    id="return_time", name="Return time to habitat",
    cmap="return_bands", vmin=0, vmax=n * BAND_MIN,
    nan_color=UNREACHABLE, resampling=Resampling.nearest, legend=legend,
)

# Add (or replace) this layer in overlays.json
path = WEB / "data" / "overlays.json"
layers = [l for l in json.loads(path.read_text(encoding="utf-8")) if l["id"] != "return_time"]
layers.append(entry)
path.write_text(json.dumps(layers, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
print("Saved:", path.relative_to(ROOT))
