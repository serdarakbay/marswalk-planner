# fetch_dem.py
# Clips only our work area (~2.4 x 2.4 km) out of the big DEM and saves it as
# data/cache/dem_clip.tif. All later steps use this small file.
# Run: python -m arazi.fetch_dem

import rasterio
from rasterio.warp import transform
from rasterio.windows import Window, from_bounds

from arazi.geo import CACHE, MARS_GEO, ROOT, bbox

SRC = ROOT / "data" / "raw" / "MSL_Gale_DEM_Mosaic_1m_v3.tif"
OUT = CACHE / "dem_clip.tif"
WEST, SOUTH, EAST, NORTH = bbox()

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

print("Saved:", OUT.relative_to(ROOT), "| shape:", data.shape)
