# check_dem.py
# Büyük Gale DEM dosyasının çalışma alanımızı (bbox) kapsayıp kapsamadığını
# ve içinde boş (NoData) piksel olup olmadığını kontrol eder. Dosya üretmez,
# sadece sonuçları ekrana yazar.


import rasterio
from rasterio.crs import CRS
from rasterio.warp import transform
from rasterio.windows import from_bounds

PATH = "data/raw/MSL_Gale_DEM_Mosaic_1m_v3.tif"
WEST, SOUTH, EAST, NORTH = 137.36, -4.77, 137.40, -4.73

# Mars küresi (yarıçap 3396190 m), derece cinsinden koordinat sistemi
MARS_GEO = CRS.from_string("+proj=longlat +R=3396190 +no_defs")

with rasterio.open(PATH) as ds:
    print("CRS:", ds.crs)
    print("Boyut:", ds.width, "x", ds.height, "| piksel:", ds.res, "| nodata:", ds.nodata)
    print("Dosya sınırları:", ds.bounds)

    xs, ys = transform(MARS_GEO, ds.crs, [WEST, EAST], [SOUTH, NORTH])
    window = from_bounds(min(xs), min(ys), max(xs), max(ys), ds.transform)
    data = ds.read(1, window=window, masked=True)

print("Kesit boyutu:", data.shape)
print("NoData oranı: %", round(100 * data.mask.sum() / data.size, 2))
print("Yükseklik min/max (m):", float(data.min()), float(data.max()))