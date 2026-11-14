# check_dem.py
# Checks that the big Gale DEM covers our work area (bbox) and whether it has
# NoData pixels. Writes no files, only prints the results.
# Run: python -m arazi.check_dem

import rasterio
from rasterio.warp import transform
from rasterio.windows import from_bounds

from arazi.geo import MARS_GEO, ROOT, bbox

PATH = ROOT / "data" / "raw" / "MSL_Gale_DEM_Mosaic_1m_v3.tif"
WEST, SOUTH, EAST, NORTH = bbox()

with rasterio.open(PATH) as ds:
    print("CRS:", ds.crs)
    print("Size:", ds.width, "x", ds.height, "| pixel:", ds.res, "| nodata:", ds.nodata)
    print("File bounds:", ds.bounds)

    xs, ys = transform(MARS_GEO, ds.crs, [WEST, EAST], [SOUTH, NORTH])
    window = from_bounds(min(xs), min(ys), max(xs), max(ys), ds.transform)
    data = ds.read(1, window=window, masked=True)

print("Clip size:", data.shape)
print("NoData share: %", round(100 * data.mask.sum() / data.size, 2))
print("Elevation min/max (m):", float(data.min()), float(data.max()))
