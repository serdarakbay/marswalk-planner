"""Radio shadow, shelters and route safety -> web/data/safety/safety.json (+ comm_shadow.png)

Inputs:
  data/cache/dem_clip.tif   Demir's 1 m DEM (metric eqc grid, CLAUDE.md CRS)
  data/cache/slope.tif, cost.tif   from python -m arazi.slope / arazi.cost (impassable = NaN)
  web/data/area.json, route.geojson, summary.json, stops.json; config/mission.json

1. Radio: line of sight from an antenna comm_antenna_height_m above the habitat to a suit
   antenna comm_suit_antenna_height_m above the ground, on a sphere of radius R (each sample
   is lowered by d^2 / 2R). The map uses a radial sweep (one ray per border pixel); route
   vertices use an exact ray each, with bilinear heights every 0.5 m.
2. Shelters: sky-view factor (SVF = 1 - mean(sin(horizon angle)) over svf_directions, up to
   svf_radius_m) on a svf_grid_m grid of passable points within shelter_search_radius_m of
   the route; the shelter_count lowest-SVF points at least shelter_min_spacing_m apart.
3. route[]: one entry per summary.profile point, with the same `d`. shelter_min is the
   walking time to the nearest shelter on the cost grid (every step counted uphill, like
   Demir's return rings). offline_min sums route time (t_min) spent without radio.

Run:  python -m science.safety.build    (after python -m arazi.slope and arazi.cost)
"""
from __future__ import annotations

import json
import math
import sys

import numpy as np
import rasterio
from rasterio.warp import Resampling
from rasterio.warp import transform as warp_coords
from scipy.ndimage import map_coordinates
from skimage.graph import MCP_Geometric

from arazi.geo import MARS_GEO, cmap_hex, to_overlay_png
from arazi.walk import speed_m_min
from pipeline.common import CACHE, WEB_DATA, load_area, load_mission, write_json

MARS_RADIUS_M = 3396190.0          # project sphere (CLAUDE.md CRS)
LOS_STEP_M = 0.5                   # sampling step for exact route rays
OUT_DIR = WEB_DATA / "safety"
OUT_JSON = OUT_DIR / "safety.json"
SQRT2 = math.sqrt(2)


def read(path):
    with rasterio.open(path) as ds:
        a = ds.read(1).astype("float64")
        if ds.nodata is not None and not np.isnan(ds.nodata):
            a[a == ds.nodata] = np.nan
        return a, ds.transform, ds.crs


def lonlat_to_rc(points, tr, crs):
    """[[lon, lat], ...] -> float (row, col) arrays in pixel units (pixel centres at .0)."""
    lons, lats = zip(*points)
    xs, ys = warp_coords(MARS_GEO, crs, list(lons), list(lats))
    cols, rows = ~tr * (np.array(xs), np.array(ys))
    return np.asarray(rows) - 0.5, np.asarray(cols) - 0.5


def rc_to_lonlat(rows, cols, tr, crs):
    xs, ys = tr * (np.asarray(cols) + 0.5, np.asarray(rows) + 0.5)
    lons, lats = warp_coords(crs, MARS_GEO, list(np.atleast_1d(xs)), list(np.atleast_1d(ys)))
    return [[round(lo, 6), round(la, 6)] for lo, la in zip(lons, lats)]


# --- 1. Radio line of sight -------------------------------------------------------------------

def viewshed(z, r0, c0, z_obs, h_target, res):
    """Visible (True) where a target h_target above ground sees the observer at z_obs."""
    H, W = z.shape
    border = ([(0, c) for c in range(W)] + [(H - 1, c) for c in range(W)]
              + [(r, 0) for r in range(1, H - 1)] + [(r, W - 1) for r in range(1, H - 1)])
    visible = np.zeros((H, W), bool)
    ri0, ci0 = int(round(r0)), int(round(c0))
    visible[ri0, ci0] = True
    zf = np.where(np.isfinite(z), z, -np.inf)
    batch = 400
    for i in range(0, len(border), batch):
        ends = np.array(border[i:i + batch], float)
        dr, dc = ends[:, 0] - r0, ends[:, 1] - c0
        n = np.ceil(np.maximum(abs(dr), abs(dc))).astype(int)
        nmax = n.max()
        k = np.arange(1, nmax + 1)
        frac = k[None, :] / np.maximum(n, 1)[:, None]
        valid = k[None, :] <= n[:, None]
        rr = np.clip(np.round(r0 + dr[:, None] * frac), 0, H - 1).astype(int)
        cc = np.clip(np.round(c0 + dc[:, None] * frac), 0, W - 1).astype(int)
        dist = np.hypot(dr, dc)[:, None] * frac * res
        drop = dist ** 2 / (2 * MARS_RADIUS_M)
        ground = zf[rr, cc] - drop
        terrain = np.where(valid, (ground - z_obs) / dist, -np.inf)
        target = (ground + h_target - z_obs) / dist
        horizon = np.maximum.accumulate(terrain, axis=1)
        before = np.concatenate([np.full((len(ends), 1), -np.inf), horizon[:, :-1]], axis=1)
        vis = valid & (target >= before) & np.isfinite(ground)
        np.logical_or.at(visible, (rr[vis], cc[vis]), True)
    return visible


def los_points(z, r0, c0, z_obs, rows, cols, h_target, res):
    """Exact line of sight from the observer to each (row, col), bilinear heights every 0.5 m."""
    out = []
    for r, c in zip(rows, cols):
        dist_px = math.hypot(r - r0, c - c0)
        if dist_px * res < 1:
            out.append(True)
            continue
        n = max(2, int(math.ceil(dist_px * res / LOS_STEP_M)))
        f = np.arange(1, n) / n
        zs = map_coordinates(z, [r0 + (r - r0) * f, c0 + (c - c0) * f], order=1, mode="nearest")
        d = dist_px * res * f
        terrain = (zs - d ** 2 / (2 * MARS_RADIUS_M) - z_obs) / d
        d_t = dist_px * res
        z_t = map_coordinates(z, [[r], [c]], order=1, mode="nearest")[0]
        target = (z_t - d_t ** 2 / (2 * MARS_RADIUS_M) + h_target - z_obs) / d_t
        out.append(bool(target >= np.nanmax(terrain)))
    return out


def offline_minutes(t_min, comm, stop_vertex, dwell) -> float:
    """Route time without a link: walking part of each segment by its two ends, dwell by the stop."""
    offline = 0.0
    for i in range(len(t_min) - 1):
        dt = t_min[i + 1] - t_min[i]
        stay = dwell if (i + 1) in stop_vertex and dt >= dwell else 0.0
        offline += (dt - stay) * ((not comm[i]) + (not comm[i + 1])) / 2 + stay * (not comm[i + 1])
    return offline


# --- 2. Sky-view factor -----------------------------------------------------------------------

def sky_view_factor(z, rows, cols, n_dir, radius_m, res):
    """SVF = 1 - mean_i sin(max(0, horizon angle_i)), heights from the ground surface."""
    steps = np.arange(1, int(radius_m / res) + 1) * res
    sin_sum = np.zeros(len(rows))
    z0 = map_coordinates(z, [rows, cols], order=1, mode="nearest")
    for a in np.linspace(0, 2 * np.pi, n_dir, endpoint=False):
        dr, dc = -np.cos(a), np.sin(a)
        best = np.zeros(len(rows))
        for chunk in np.array_split(np.arange(len(rows)), max(1, len(rows) // 2000)):
            rr = rows[chunk, None] + dr * steps[None, :] / res
            cc = cols[chunk, None] + dc * steps[None, :] / res
            zs = map_coordinates(z, [rr.ravel(), cc.ravel()], order=1, mode="nearest").reshape(rr.shape)
            ang = np.arctan((zs - steps[None, :] ** 2 / (2 * MARS_RADIUS_M) - z0[chunk, None]) / steps[None, :])
            best[chunk] = np.clip(np.nanmax(ang, axis=1), 0, None)
        sin_sum += np.sin(best)
    return 1 - sin_sum / n_dir


def pick_shelters(rows, cols, svf, count, spacing_px):
    order = np.argsort(svf)
    chosen = []
    for i in order:
        if all(math.hypot(rows[i] - rows[j], cols[i] - cols[j]) >= spacing_px for j in chosen):
            chosen.append(i)
            if len(chosen) == count:
                break
    return chosen


# --- 3. Profile axis and route timing ---------------------------------------------------------

def route_axis(rows, cols, res):
    """Cumulative distance along the route vertices (octile steps between pixel centres)."""
    r, c = np.round(rows), np.round(cols)
    dr, dc = np.abs(np.diff(r)), np.abs(np.diff(c))
    step = (np.maximum(dr, dc) - np.minimum(dr, dc) + SQRT2 * np.minimum(dr, dc)) * res
    return np.concatenate([[0], np.cumsum(step)])


def match_profile(profile, d_route, z_route, slope_route):
    """Route vertex index for each summary.profile point: nearest d, confirmed by z and slope."""
    idx, worst = [], 0.0
    for p in profile:
        cand = np.where(np.abs(d_route - p["d"]) <= 3)[0]
        exact = [i for i in cand if round(z_route[i], 1) == p["z"] and round(slope_route[i], 1) == p["slope"]]
        i = min(exact or cand.tolist() or [int(np.argmin(np.abs(d_route - p["d"])))],
                key=lambda j: abs(d_route[j] - p["d"]))
        worst = max(worst, abs(d_route[i] - p["d"]))
        idx.append(i)
    return idx, worst


def main() -> int:
    mission, area = load_mission(), load_area()
    for name in ("dem_clip.tif", "slope.tif", "cost.tif"):
        if not (CACHE / name).exists():
            print(f"ERROR: data/cache/{name} missing (run python -m arazi.slope and arazi.cost)", file=sys.stderr)
            return 1
    z, tr, crs = read(CACHE / "dem_clip.tif")
    slope, _, _ = read(CACHE / "slope.tif")
    cost, _, _ = read(CACHE / "cost.tif")
    res = abs(tr.a)
    route = json.loads((WEB_DATA / "route.geojson").read_text(encoding="utf-8"))
    summary = json.loads((WEB_DATA / "summary.json").read_text(encoding="utf-8"))
    stops = json.loads((WEB_DATA / "stops.json").read_text(encoding="utf-8"))
    coords = route["geometry"]["coordinates"]
    t_min = np.array(route["properties"]["t_min"], float)
    slope_deg = route["properties"]["slope_deg"]

    # Habitat antenna
    (hr,), (hc,) = lonlat_to_rc([area["habitat"]], tr, crs)
    z_obs = map_coordinates(z, [[hr], [hc]], order=1)[0] + mission["comm_antenna_height_m"]
    h_suit = mission["comm_suit_antenna_height_m"]

    # 1. Radio shadow: map and route
    vis = viewshed(z, hr, hc, z_obs, h_suit, res)
    shadow = np.where(vis | ~np.isfinite(z), np.nan, 1.0)
    shadow_color = cmap_hex("Reds", 0, 1, 0.85)
    overlay = to_overlay_png((shadow, tr, crs), OUT_DIR / "comm_shadow.png", id="comm_shadow",
                             name="Radio shadow", cmap="Reds", vmin=0, vmax=1.2,
                             legend=[{"color": shadow_color, "label": "No radio link to habitat"}],
                             resampling=Resampling.nearest)
    vr, vc = lonlat_to_rc(coords, tr, crs)
    comm = los_points(z, hr, hc, z_obs, vr, vc, h_suit, res)

    sr, sc = lonlat_to_rc([s["coord"] for s in stops], tr, crs)
    stop_vertex = {int(np.argmin(np.hypot(vr - a, vc - b))) for a, b in zip(sr, sc)}
    offline = offline_minutes(t_min, comm, stop_vertex, mission["stop_dwell_min"])

    # 2. Shelters: SVF on a grid within the search radius of the route, passable points only
    H, W = z.shape
    step_px = max(1, int(round(mission["svf_grid_m"] / res)))
    gr, gc = np.mgrid[0:H:step_px, 0:W:step_px]
    gr, gc = gr.ravel().astype(float), gc.ravel().astype(float)
    near = np.zeros(len(gr), bool)
    radius_px = mission["shelter_search_radius_m"] / res
    for a, b in zip(vr[::2], vc[::2]):
        near |= (gr - a) ** 2 + (gc - b) ** 2 <= radius_px ** 2
    ok = near & np.isfinite(cost[gr.astype(int), gc.astype(int)])
    gr, gc = gr[ok], gc[ok]
    svf = sky_view_factor(z, gr, gc, mission["svf_directions"], mission["svf_radius_m"], res)
    pick = pick_shelters(gr, gc, svf, mission["shelter_count"], mission["shelter_min_spacing_m"] / res)
    shelter_ll = rc_to_lonlat(gr[pick], gc[pick], tr, crs)
    shelters = [{"coord": ll, "svf": round(float(svf[i]), 3)} for ll, i in zip(shelter_ll, pick)]

    # Walking time to the nearest shelter (uphill-conservative, impassable never crossed)
    uphill = np.nan_to_num(np.tan(np.radians(slope)))
    min_per_m = 1 / speed_m_min(uphill)
    min_per_m[~np.isfinite(cost)] = np.inf
    starts = [(int(gr[i]), int(gc[i])) for i in pick]
    to_shelter, _ = MCP_Geometric(min_per_m, fully_connected=True).find_costs(starts)
    to_shelter = to_shelter * res

    # 3. route[] on summary.profile's d axis
    d_route = route_axis(vr, vc, res)
    z_route = z[np.round(vr).astype(int), np.round(vc).astype(int)]
    idx, worst = match_profile(summary["profile"], d_route, z_route, slope_deg)
    safety_route = []
    for p, i in zip(summary["profile"], idx):
        m = to_shelter[int(round(vr[i])), int(round(vc[i]))]
        safety_route.append({"d": p["d"], "comm_ok": bool(comm[i]),
                             "shelter_min": round(float(m), 1) if np.isfinite(m) else None})

    out = {"overlays": [overlay], "shelters": shelters, "route": safety_route,
           "offline_min": round(offline, 1)}
    write_json(OUT_JSON, out)

    print(f"radio shadow: {100 * (~vis & np.isfinite(z)).mean():.1f} % of the map, "
          f"{sum(not c for c in comm)}/{len(comm)} route vertices, offline {offline:.1f} of {t_min[-1]:.1f} min")
    print(f"shelters: {len(shelters)} from {len(gr)} candidate points; svf {[s['svf'] for s in shelters]}")
    sm = [r["shelter_min"] for r in safety_route if r["shelter_min"] is not None]
    print(f"shelter_min along the route: max {max(sm):.1f}, mean {np.mean(sm):.1f} min")
    print(f"profile match: {len(idx)} points, worst d offset {worst:.1f} m")
    return 0


if __name__ == "__main__":
    sys.exit(main())
