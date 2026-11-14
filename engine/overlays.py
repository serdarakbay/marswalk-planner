# overlays.py
# slope.tif ve cost.tif'i enlem/boylam gridine çevirir (warp), renkli PNG yapar ve
# web/data/overlays/ içine kaydeder. Haritanın PNG'leri oturtması için overlays.json yazar.

import json
from pathlib import Path

import numpy as np
import rasterio
from rasterio.crs import CRS
from rasterio.transform import from_bounds
from rasterio.warp import Resampling, reproject
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

WEST, SOUTH, EAST, NORTH = 137.36, -4.77, 137.40, -4.73
SIZE = 1200    # PNG genişlik/yükseklik (piksel); dosya 5 MB altında kalsın diye
MARS_GEO = CRS.from_string("+proj=longlat +R=3396190 +no_defs")
OUT_DIR = Path("web/data/overlays")
OUT_DIR.mkdir(parents=True, exist_ok=True)


def warp(path, resampling):
    dst = np.full((SIZE, SIZE), np.nan, dtype="float32")
    with rasterio.open(path) as src:
        reproject(
            source=rasterio.band(src, 1), destination=dst,
            src_transform=src.transform, src_crs=src.crs, src_nodata=src.nodata,
            dst_transform=from_bounds(WEST, SOUTH, EAST, NORTH, SIZE, SIZE),
            dst_crs=MARS_GEO, dst_nodata=np.nan, resampling=resampling,
        )
    return dst


def to_png(values, path, cmap, vmin, vmax, nan_color):
    norm = np.clip((values - vmin) / (vmax - vmin), 0, 1)
    rgba = plt.get_cmap(cmap)(np.nan_to_num(norm))
    rgba[np.isnan(values)] = nan_color
    plt.imsave(path, rgba)
    print("Kaydedildi:", path, "|", round(path.stat().st_size / 1e6, 2), "MB")


slope = warp("data/cache/slope.tif", Resampling.bilinear)
cost = warp("data/cache/cost.tif", Resampling.nearest)

to_png(slope, OUT_DIR / "slope.png", "RdYlGn_r", 0, 35, [0, 0, 0, 0])
to_png(cost, OUT_DIR / "cost.png", "magma_r", 1, 5, [0.8, 0, 0, 1])   # geçilmez: kırmızı

bounds = {"west": WEST, "south": SOUTH, "east": EAST, "north": NORTH}
overlays = [
    {"id": "slope", "name": "Slope", "png": "data/overlays/slope.png", "bounds": bounds,
     "legend": {"min": 0, "max": 35, "unit": "deg", "colormap": "RdYlGn_r"}},
    {"id": "cost", "name": "Traverse cost", "png": "data/overlays/cost.png", "bounds": bounds,
     "legend": {"min": 1, "max": 5, "unit": "relative", "colormap": "magma_r",
                "impassable_color": "#cc0000"}},
]
Path("web/data/overlays.json").write_text(json.dumps(overlays, indent=2))
print("Kaydedildi: web/data/overlays.json")