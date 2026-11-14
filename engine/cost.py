# cost.py
# Eğim ve pürüzlülükten her piksel için "yürüme maliyeti" haritası üretir ve
# data/cache/cost.tif olarak kaydeder. 25 dereceden dik yerler geçilmez (NaN).
# Rota (A*) bu haritada toplam maliyeti en düşük yolu arar.

import numpy as np
import rasterio
from scipy.ndimage import uniform_filter

DEM = "data/cache/dem_clip.tif"
SLOPE = "data/cache/slope.tif"
OUT = "data/cache/cost.tif"

# Eşikler: ileride Utku'nun config/mission.json dosyasından okunacak
WARN_DEG = 15      # uyarı eğimi
MAX_DEG = 25       # bunun üstü geçilmez

with rasterio.open(DEM) as ds:
    z = ds.read(1).astype("float64")
with rasterio.open(SLOPE) as ds:
    slope = ds.read(1).astype("float64")
    profile = ds.profile.copy()

# Pürüzlülük: 5x5 m pencerede yüksekliğin standart sapması (metre)
mean = uniform_filter(z, size=5)
mean_sq = uniform_filter(z * z, size=5)
rough = np.sqrt(np.clip(mean_sq - mean * mean, 0, None))

# Maliyet: 1 (düz) + eğim cezası + pürüzlülük cezası
cost = 1 + (slope / WARN_DEG) ** 2 + rough / 0.5

# Geçilmez yerler
cost[slope > MAX_DEG] = np.nan

profile.update(dtype="float32", nodata=np.nan, compress="deflate")
with rasterio.open(OUT, "w", **profile) as dst:
    dst.write(cost.astype("float32"), 1)

print("Pürüzlülük (m) ortalama/max:", round(float(rough.mean()), 2), round(float(rough.max()), 2))
print("Maliyet min/ortalama/max:",
      round(float(np.nanmin(cost)), 2), round(float(np.nanmean(cost)), 2), round(float(np.nanmax(cost)), 2))
print("Geçilmez alan: %", round(float(np.isnan(cost).mean() * 100), 1))
print("Kaydedildi:", OUT)