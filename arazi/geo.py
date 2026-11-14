# geo.py
# Shared helpers for the terrain pipeline (arazi/).
#   - area bbox and habitat (from web/data/area.json, Utku)
#   - mission thresholds (from config/mission.json, Utku)
#   - Mars CRS definitions
#   - to_overlay_png(): warps a metric raster onto the lon/lat grid and writes a
#     small palette PNG for the map. Utku imports this for the safety layers, so
#     every overlay lines up pixel for pixel. Only Demir edits this file.

import json
from pathlib import Path

import numpy as np
import rasterio
from rasterio.crs import CRS
from rasterio.transform import from_bounds
from rasterio.warp import Resampling, reproject
from matplotlib import colormaps
from matplotlib.colors import to_hex, to_rgba
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
WEB = ROOT / "web"
CACHE = ROOT / "data" / "cache"

# Mars sphere (R = 3396190 m), planetocentric lon/lat in degrees
MARS_GEO = CRS.from_string("+proj=longlat +R=3396190 +no_defs")

# Used only until Utku's files land on main (values from docs/contracts.md)
_DEFAULT_AREA = {
    "bbox": {"west": 137.36, "south": -4.77, "east": 137.40, "north": -4.73},
    "habitat": [137.385, -4.755],
}
_DEFAULT_MISSION = {
    "gravity_m_s2": 3.71,
    "slope_warn_deg": 15,
    "slope_max_deg": 25,
    "eva_nominal_hours": 8,
    "o2_reserve_pct": 25,
    "rad_base_mSv_per_day": 0.64,
    "dem_resolution_m": 1,
    "dem_max_downsample_m": 2,
}

OVERLAY_SIZE = 1200   # PNG width/height in pixels


def _read_json(path, default):
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    print(f"WARNING: {path.relative_to(ROOT)} not found, using defaults from contracts.md")
    return default


def load_area():
    return _read_json(WEB / "data" / "area.json", _DEFAULT_AREA)


def load_mission():
    mission = dict(_DEFAULT_MISSION)
    mission.update(_read_json(ROOT / "config" / "mission.json", {}))
    return mission


def bbox():
    b = load_area()["bbox"]
    return b["west"], b["south"], b["east"], b["north"]


def warp_to_geo(src, resampling=Resampling.bilinear, size=OVERLAY_SIZE):
    """Reproject a raster onto the lon/lat grid of the area bbox.

    src: path to a GeoTIFF, or a tuple (array, transform, crs).
    Returns a float32 array (size x size); NoData becomes NaN.
    """
    west, south, east, north = bbox()
    dst = np.full((size, size), np.nan, dtype="float32")
    common = dict(
        destination=dst,
        dst_transform=from_bounds(west, south, east, north, size, size),
        dst_crs=MARS_GEO, dst_nodata=np.nan, resampling=resampling,
    )
    if isinstance(src, (str, Path)):
        with rasterio.open(src) as ds:
            reproject(source=rasterio.band(ds, 1), src_transform=ds.transform,
                      src_crs=ds.crs, src_nodata=ds.nodata, **common)
    else:
        array, transform, crs = src
        reproject(source=np.asarray(array, dtype="float32"), src_transform=transform,
                  src_crs=crs, src_nodata=np.nan, **common)
    return dst


def cmap_hex(cmap, vmin, vmax, value):
    """Hex colour that the overlay uses for `value` (handy for legends)."""
    t = float(np.clip((value - vmin) / (vmax - vmin), 0, 1))
    return to_hex(colormaps[cmap](t))


def to_overlay_png(src, out_png, *, id, name, cmap, vmin, vmax, legend,
                   nan_color=None, resampling=Resampling.bilinear):
    """Warp `src` to lon/lat, colour it and save a palette PNG under web/.

    src:       GeoTIFF path or (array, transform, crs) in any CRS (e.g. metric eqc)
    out_png:   path under web/, e.g. WEB / "data/overlays/slope.png"
    legend:    list of {"color": "#rrggbb", "label": "..."} (docs/contracts.md)
    nan_color: colour for NaN pixels (e.g. "#cc0000"); None = transparent
    Returns the overlays.json entry for this layer.
    """
    values = warp_to_geo(src, resampling)
    nan = np.isnan(values)

    # 254 colour steps + 1 slot for NaN -> 8-bit palette PNG (small file)
    steps = 254
    t = np.clip((values - vmin) / (vmax - vmin), 0, 1)
    index = np.round(np.nan_to_num(t) * (steps - 1)).astype("uint8")
    index[nan] = steps

    lut = colormaps[cmap](np.linspace(0, 1, steps))
    nan_rgba = to_rgba(nan_color) if nan_color else (0, 0, 0, 0)
    rgba = (np.vstack([lut, nan_rgba]) * 255).round().astype("uint8")

    img = Image.fromarray(index, mode="P")
    img.putpalette(rgba[:, :3].flatten().tolist())

    out_png = Path(out_png)
    out_png.parent.mkdir(parents=True, exist_ok=True)
    img.save(out_png, optimize=True, transparency=bytes(rgba[:, 3].tolist()))
    print(f"Saved: {out_png.relative_to(ROOT)} | {out_png.stat().st_size / 1e6:.2f} MB")

    west, south, east, north = bbox()
    return {
        "id": id,
        "name": name,
        "png": out_png.relative_to(WEB).as_posix(),
        "bounds": {"west": west, "south": south, "east": east, "north": north},
        "legend": legend,
    }
