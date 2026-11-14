# slope.py
# Computes the slope (degrees) of every pixel of dem_clip.tif and saves it as
# data/cache/slope.tif. Computed on the metric grid (1 m pixels).
# Run: python -m arazi.slope

import numpy as np
import rasterio

from arazi.geo import CACHE, ROOT, load_mission

SRC = CACHE / "dem_clip.tif"
OUT = CACHE / "slope.tif"
mission = load_mission()

with rasterio.open(SRC) as ds:
    z = ds.read(1).astype("float64")
    nodata = ds.nodata
    res_x, res_y = ds.res
    profile = ds.profile.copy()

if nodata is not None:
    z[z == nodata] = np.nan

dz_dy, dz_dx = np.gradient(z, res_y, res_x)
slope_deg = np.degrees(np.arctan(np.hypot(dz_dx, dz_dy)))

profile.update(dtype="float32", nodata=np.nan, compress="deflate")
with rasterio.open(OUT, "w", **profile) as dst:
    dst.write(slope_deg.astype("float32"), 1)

warn, smax = mission["slope_warn_deg"], mission["slope_max_deg"]
print("Slope (deg) min/mean/max:",
      round(float(np.nanmin(slope_deg)), 1),
      round(float(np.nanmean(slope_deg)), 1),
      round(float(np.nanmax(slope_deg)), 1))
print(f"Steeper than {warn} deg: %", round(float(np.nanmean(slope_deg > warn) * 100), 1))
print(f"Steeper than {smax} deg: %", round(float(np.nanmean(slope_deg > smax) * 100), 1))
print("Saved:", OUT.relative_to(ROOT))
