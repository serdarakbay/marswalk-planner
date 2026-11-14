# slope.py
# dem_clip.tif'ten her pikselin eğimini (derece) hesaplar ve data/cache/slope.tif
# olarak kaydeder. Hesap metre cinsinden gridde yapılır.

import numpy as np
import rasterio

SRC = "data/cache/dem_clip.tif"
OUT = "data/cache/slope.tif"

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

print("Eğim (derece) min/ortalama/max:",
      round(float(np.nanmin(slope_deg)), 1),
      round(float(np.nanmean(slope_deg)), 1),
      round(float(np.nanmax(slope_deg)), 1))
print("%15 dereceden dik:", round(float(np.nanmean(slope_deg > 15) * 100), 1))
print("%25 dereceden dik:", round(float(np.nanmean(slope_deg > 25) * 100), 1))
print("Kaydedildi:", OUT)