# heightmap.py
# Small heightmap PNG for Egemen's 3D view, on the same lon/lat grid as the overlays.
# Elevation is stored as 16 bits in the R and G channels ("rg16"):
#   v = round((z - z_min_m) / (z_max_m - z_min_m) * 65535),  R = v >> 8,  G = v & 255,  B = 0
#   decode: z = z_min_m + (R * 256 + G) / 65535 * (z_max_m - z_min_m)
# NoData pixels have alpha 0. Also writes a "terrain" block into summary.json.
# Run: python -m arazi.heightmap   (after arazi.fetch_dem; re-run after arazi.route,
#      or route.py keeps the existing "terrain" block when it rewrites summary.json)

import json

import numpy as np
from PIL import Image
from rasterio.warp import Resampling

from arazi.geo import CACHE, ROOT, WEB, bbox, warp_to_geo

SIZE = 512                      # pixels per side
OUT = WEB / "data" / "overlays" / "heightmap.png"
SUMMARY = WEB / "data" / "summary.json"

z = warp_to_geo(CACHE / "dem_clip.tif", Resampling.bilinear, size=SIZE)
valid = np.isfinite(z)
z_min = round(float(np.nanmin(z)), 2)
z_max = round(float(np.nanmax(z)), 2)

v = np.zeros(z.shape, dtype="uint16")
v[valid] = np.round((z[valid] - z_min) / (z_max - z_min) * 65535).astype("uint16")

rgba = np.zeros((SIZE, SIZE, 4), dtype="uint8")
rgba[..., 0] = v >> 8
rgba[..., 1] = v & 255
rgba[..., 3] = np.where(valid, 255, 0)
OUT.parent.mkdir(parents=True, exist_ok=True)
Image.fromarray(rgba, mode="RGBA").save(OUT, optimize=True)

# Round-trip check: decoding must give back the elevation within half a step
back = z_min + (rgba[..., 0].astype(float) * 256 + rgba[..., 1]) / 65535 * (z_max - z_min)
err = float(np.nanmax(np.abs(back - z)[valid]))

west, south, east, north = bbox()
px_m = (north - south) * 3396190 * np.pi / 180 / SIZE   # metres per pixel (north-south)
terrain = {
    "png": OUT.relative_to(WEB).as_posix(),
    "bounds": {"west": west, "south": south, "east": east, "north": north},
    "z_min_m": z_min,
    "z_max_m": z_max,
    "encoding": "rg16",
    "source": f"1 m DEM (USGS), {px_m:.1f} m/px",
}

summary = json.loads(SUMMARY.read_text(encoding="utf-8"))
summary["terrain"] = terrain
SUMMARY.write_text(json.dumps(summary, separators=(",", ":")) + "\n", encoding="utf-8")

print(f"Saved: {OUT.relative_to(ROOT)} | {OUT.stat().st_size / 1e3:.0f} kB")
print(f"z range {z_min} .. {z_max} m | step {(z_max - z_min) / 65535 * 100:.2f} cm | "
      f"max round-trip error {err * 100:.2f} cm | NoData {100 * (~valid).mean():.1f} %")
print("Updated:", SUMMARY.relative_to(ROOT), json.dumps(terrain))
