# fetch_dem.py
# Büyük DEM dosyasından sadece çalışma alanımızı (2,4 x 2,4 km) keser ve
# data/cache/dem_clip.tif olarak kaydeder. Sonraki hesaplar bu küçük dosyayı kullanır.


from pathlib import Path

import rasterio
from rasterio.crs import CRS
from rasterio.warp import transform
from rasterio.windows import Window, from_bounds

SRC = "data/raw/MSL_Gale_DEM_Mosaic_1m_v3.tif"
OUT = Path("data/cache/dem_clip.tif")
WEST, SOUTH, EAST, NORTH = 137.36, -4.77, 137.40, -4.73
MARS_GEO = CRS.from_string("+proj=longlat +R=3396190 +no_defs")

OUT.parent.mkdir(parents=True, exist_ok=True)

with rasterio.open(SRC) as ds:
    xs, ys = transform(MARS_GEO, ds.crs, [WEST, EAST], [SOUTH, NORTH])
    w = from_bounds(min(xs), min(ys), max(xs), max(ys), ds.transform)
    window = Window(round(w.col_off), round(w.row_off), round(w.width), round(w.height))
    data = ds.read(1, window=window)

    profile = ds.profile.copy()
    profile.pop("blockxsize", None)
    profile.pop("blockysize", None)
    profile.update(
        driver="GTiff", tiled=False, compress="deflate",
        height=data.shape[0], width=data.shape[1], count=1,
        transform=ds.window_transform(window),
    )

with rasterio.open(OUT, "w", **profile) as dst:
    dst.write(data, 1)

print("Kaydedildi:", OUT, "| boyut:", data.shape)