# overlays.py
# Turns slope.tif and cost.tif into coloured PNGs on the lon/lat grid
# (web/data/overlays/) and writes web/data/overlays.json so the map can place them.
# Run: python -m arazi.overlays

import json

from rasterio.warp import Resampling

from arazi.geo import CACHE, ROOT, WEB, cmap_hex, load_mission, to_overlay_png

mission = load_mission()
WARN, MAX = mission["slope_warn_deg"], mission["slope_max_deg"]
OUT_DIR = WEB / "data" / "overlays"

SLOPE_CMAP, SLOPE_MIN, SLOPE_MAX = "RdYlGn_r", 0, 35
COST_CMAP, COST_MIN, COST_MAX = "magma_r", 1, 5
IMPASSABLE = "#cc0000"

slope = to_overlay_png(
    CACHE / "slope.tif", OUT_DIR / "slope.png",
    id="slope", name="Slope",
    cmap=SLOPE_CMAP, vmin=SLOPE_MIN, vmax=SLOPE_MAX,
    legend=[
        {"color": cmap_hex(SLOPE_CMAP, SLOPE_MIN, SLOPE_MAX, WARN / 2), "label": f"< {WARN}°"},
        {"color": cmap_hex(SLOPE_CMAP, SLOPE_MIN, SLOPE_MAX, (WARN + MAX) / 2), "label": f"{WARN}–{MAX}°"},
        {"color": cmap_hex(SLOPE_CMAP, SLOPE_MIN, SLOPE_MAX, MAX + 5), "label": f"> {MAX}°"},
    ],
)

cost = to_overlay_png(
    CACHE / "cost.tif", OUT_DIR / "cost.png",
    id="cost", name="Traverse cost",
    cmap=COST_CMAP, vmin=COST_MIN, vmax=COST_MAX,
    nan_color=IMPASSABLE, resampling=Resampling.nearest,
    legend=[
        {"color": cmap_hex(COST_CMAP, COST_MIN, COST_MAX, COST_MIN), "label": "Easy"},
        {"color": cmap_hex(COST_CMAP, COST_MIN, COST_MAX, COST_MAX), "label": "Hard"},
        {"color": IMPASSABLE, "label": f"Impassable (> {MAX}°)"},
    ],
)

out = WEB / "data" / "overlays.json"
out.write_text(json.dumps([slope, cost], indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
print("Saved:", out.relative_to(ROOT))
