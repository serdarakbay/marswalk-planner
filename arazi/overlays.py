# overlays.py
# Turns the terrain rasters into coloured PNGs on the lon/lat grid
# (web/data/overlays/) and writes them into web/data/overlays.json:
#   hillshade (shaded relief), slope, roughness, traverse cost.
# Other layers already in overlays.json (e.g. return_time) are kept.
# Run: python -m arazi.overlays   (after arazi.slope and arazi.cost)

import json

import numpy as np
import rasterio
from rasterio.warp import Resampling

from arazi.geo import CACHE, ROOT, WEB, cmap_hex, load_mission, to_overlay_png

mission = load_mission()
WARN, MAX = mission["slope_warn_deg"], mission["slope_max_deg"]
OUT_DIR = WEB / "data" / "overlays"

SLOPE_CMAP, SLOPE_MIN, SLOPE_MAX = "RdYlGn_r", 0, 35
COST_CMAP, COST_MIN, COST_MAX = "magma_r", 1, 5
ROUGH_CMAP, ROUGH_MIN, ROUGH_MAX = "YlOrBr", 0, 1.0     # metres (std of elevation, 5 x 5 m)
ROUGH_SMOOTH_M, ROUGH_ROCKY_M = 0.25, 0.5               # legend breaks; 0.5 m = +1 cost
IMPASSABLE = "#cc0000"

# Hillshade: classic cartographic light from the north-west, 45 degrees up
SUN_AZIMUTH_DEG, SUN_ALTITUDE_DEG = 315, 45


def hillshade(dem_path):
    """Shaded relief (0 = full shadow, 1 = fully lit) on the metric grid."""
    with rasterio.open(dem_path) as ds:
        z = ds.read(1).astype("float64")
        if ds.nodata is not None:
            z[z == ds.nodata] = np.nan
        res_x, res_y = ds.res
        tr, crs = ds.transform, ds.crs
    dz_dy, dz_dx = np.gradient(z, res_y, res_x)        # rows go south: dz_dy is -dz/dnorth
    slope = np.arctan(np.hypot(dz_dx, dz_dy))
    aspect = np.arctan2(-dz_dx, dz_dy)                 # downslope direction, clockwise from north
    az, alt = np.radians(SUN_AZIMUTH_DEG), np.radians(SUN_ALTITUDE_DEG)
    shade = np.sin(alt) * np.cos(slope) + np.cos(alt) * np.sin(slope) * np.cos(az - aspect)
    return np.clip(shade, 0, 1), tr, crs


layers = []

layers.append(to_overlay_png(
    hillshade(CACHE / "dem_clip.tif"), OUT_DIR / "hillshade.png",
    id="hillshade", name="Shaded relief",
    cmap="gray", vmin=0, vmax=1,
    legend=[
        {"color": cmap_hex("gray", 0, 1, 0.15), "label": "Facing away from light"},
        {"color": cmap_hex("gray", 0, 1, 0.9), "label": f"Lit from NW ({SUN_AZIMUTH_DEG}°, {SUN_ALTITUDE_DEG}° up)"},
    ],
))

layers.append(to_overlay_png(
    CACHE / "slope.tif", OUT_DIR / "slope.png",
    id="slope", name="Slope",
    cmap=SLOPE_CMAP, vmin=SLOPE_MIN, vmax=SLOPE_MAX,
    legend=[
        {"color": cmap_hex(SLOPE_CMAP, SLOPE_MIN, SLOPE_MAX, WARN / 2), "label": f"< {WARN}°"},
        {"color": cmap_hex(SLOPE_CMAP, SLOPE_MIN, SLOPE_MAX, (WARN + MAX) / 2), "label": f"{WARN}–{MAX}°"},
        {"color": cmap_hex(SLOPE_CMAP, SLOPE_MIN, SLOPE_MAX, MAX + 5), "label": f"> {MAX}°"},
    ],
))

layers.append(to_overlay_png(
    CACHE / "rough.tif", OUT_DIR / "roughness.png",
    id="roughness", name="Surface roughness",
    cmap=ROUGH_CMAP, vmin=ROUGH_MIN, vmax=ROUGH_MAX,
    legend=[
        {"color": cmap_hex(ROUGH_CMAP, ROUGH_MIN, ROUGH_MAX, ROUGH_SMOOTH_M / 2),
         "label": f"Smooth (< {ROUGH_SMOOTH_M} m)"},
        {"color": cmap_hex(ROUGH_CMAP, ROUGH_MIN, ROUGH_MAX, (ROUGH_SMOOTH_M + ROUGH_ROCKY_M) / 2),
         "label": f"Uneven ({ROUGH_SMOOTH_M}–{ROUGH_ROCKY_M} m)"},
        {"color": cmap_hex(ROUGH_CMAP, ROUGH_MIN, ROUGH_MAX, ROUGH_MAX),
         "label": f"Rocky (> {ROUGH_ROCKY_M} m)"},
    ],
))

layers.append(to_overlay_png(
    CACHE / "cost.tif", OUT_DIR / "cost.png",
    id="cost", name="Traverse cost",
    cmap=COST_CMAP, vmin=COST_MIN, vmax=COST_MAX,
    nan_color=IMPASSABLE, resampling=Resampling.nearest,
    legend=[
        {"color": cmap_hex(COST_CMAP, COST_MIN, COST_MAX, COST_MIN), "label": "Easy"},
        {"color": cmap_hex(COST_CMAP, COST_MIN, COST_MAX, COST_MAX), "label": "Hard"},
        {"color": IMPASSABLE, "label": f"Impassable (> {MAX}°)"},
    ],
))

# Keep layers written by other scripts (e.g. return_time from arazi.return_rings)
out = WEB / "data" / "overlays.json"
mine = {l["id"] for l in layers}
others = []
if out.exists():
    others = [l for l in json.loads(out.read_text(encoding="utf-8")) if l["id"] not in mine]
out.write_text(json.dumps(layers + others, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
print("Saved:", out.relative_to(ROOT), "| layers:", [l["id"] for l in layers + others])
