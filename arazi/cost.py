# cost.py
# Builds a per-pixel "walking cost" map from slope and roughness and saves it as
# data/cache/cost.tif. Pixels steeper than slope_max_deg are impassable (NaN).
# The route search finds the path with the lowest total cost on this map.
# Run: python -m arazi.cost

import numpy as np
import rasterio
from scipy.ndimage import uniform_filter

from arazi.geo import CACHE, ROOT, load_mission

DEM = CACHE / "dem_clip.tif"
SLOPE = CACHE / "slope.tif"
OUT = CACHE / "cost.tif"

mission = load_mission()
WARN_DEG = mission["slope_warn_deg"]   # warning slope
MAX_DEG = mission["slope_max_deg"]     # impassable above this
ROUGH_SCALE_M = 0.5                    # 0.5 m of roughness adds +1 to the cost
ROUGH_WINDOW_PX = 5                    # roughness window: 5 x 5 m

with rasterio.open(DEM) as ds:
    z = ds.read(1).astype("float64")
    if ds.nodata is not None:
        z[z == ds.nodata] = np.nan
with rasterio.open(SLOPE) as ds:
    slope = ds.read(1).astype("float64")
    profile = ds.profile.copy()

# Roughness: standard deviation of elevation in a 5 x 5 m window (metres)
mean = uniform_filter(z, size=ROUGH_WINDOW_PX)
mean_sq = uniform_filter(z * z, size=ROUGH_WINDOW_PX)
rough = np.sqrt(np.clip(mean_sq - mean * mean, 0, None))

# Cost: 1 (flat) + slope penalty + roughness penalty
cost = 1 + (slope / WARN_DEG) ** 2 + rough / ROUGH_SCALE_M

# Impassable: too steep, or NoData (NaN slope / elevation)
cost[~(slope <= MAX_DEG)] = np.nan
cost[np.isnan(z)] = np.nan

profile.update(dtype="float32", nodata=np.nan, compress="deflate")
with rasterio.open(OUT, "w", **profile) as dst:
    dst.write(cost.astype("float32"), 1)

print("Roughness (m) mean/max:", round(float(np.nanmean(rough)), 2), round(float(np.nanmax(rough)), 2))
print("Cost min/mean/max:",
      round(float(np.nanmin(cost)), 2), round(float(np.nanmean(cost)), 2), round(float(np.nanmax(cost)), 2))
print("Impassable area: %", round(float(np.isnan(cost).mean() * 100), 1))
print("Saved:", OUT.relative_to(ROOT))
