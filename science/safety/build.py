"""Radio shadow, shelters and route safety -> web/data/safety/safety.json (+ comm_shadow.png)

Inputs:
  data/cache/dem_clip.tif   Demir's 1 m DEM (metric eqc grid, CLAUDE.md CRS)
  data/cache/slope.tif, cost.tif   from python -m arazi.slope / arazi.cost (impassable = NaN)
  web/data/area.json, route.geojson, summary.json, stops.json; config/mission.json

1. Radio: line of sight from an antenna comm_antenna_height_m above the habitat to a suit
   antenna comm_suit_antenna_height_m above the ground, on a sphere of radius R (each sample
   is lowered by d^2 / 2R). The map uses a radial sweep (one ray per border pixel); route
   vertices use an exact ray each, with bilinear heights every 0.5 m.
   One relay (antenna relay_antenna_height_m) is placed where the habitat can see it, within
   relay_search_radius_m of the route, so that habitat + relay leave the least route time
   without a link (coarse relay_grid_m search, then a finer search around the best point).
   A route point has a link if it sees the habitat or the relay.
2. Shelters: sky-view factor (SVF = 1 - mean(sin(horizon angle)) over svf_directions, up to
   svf_radius_m) on a svf_grid_m grid of passable points within shelter_search_radius_m of
   the route. Only the most enclosed shelter_svf_percentile % qualify. Among those, the
   shelter_count points (at least shelter_min_spacing_m apart) that minimise the longest walk
   from any route point to its nearest shelter are chosen (ties: shorter mean walk, lower SVF).
3. route[]: one entry per summary.profile point, with the same `d`. shelter_min is the
   walking time to the nearest shelter on the cost grid (every step counted uphill, like
   Demir's return rings). offline_min sums route time (t_min) spent without radio.

Run:  python -m science.safety.build    (after python -m arazi.slope and arazi.cost)
      python -m science.safety.build --mast-sensitivity 3,6,10,20   (table only, no files)
"""
from __future__ import annotations

import argparse
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


def los_many(z, r0, c0, z_obs, rows, cols, h_target, res, step_m=1.0):
    """Vectorised line of sight from one observer to many points (bilinear heights every step_m)."""
    rows, cols = np.asarray(rows, float), np.asarray(cols, float)
    dist_px = np.hypot(rows - r0, cols - c0)
    n = np.maximum(2, np.ceil(dist_px * res / step_m)).astype(int)
    k = np.arange(1, n.max())
    f = k[None, :] / n[:, None]
    valid = k[None, :] < n[:, None]
    rr, cc = r0 + (rows - r0)[:, None] * f, c0 + (cols - c0)[:, None] * f
    zs = map_coordinates(z, [rr.ravel(), cc.ravel()], order=1, mode="nearest").reshape(rr.shape)
    d = dist_px[:, None] * res * f
    with np.errstate(divide="ignore", invalid="ignore"):
        terrain = np.where(valid & (d > 0), (zs - d ** 2 / (2 * MARS_RADIUS_M) - z_obs) / d, -np.inf)
        d_t = dist_px * res
        z_t = map_coordinates(z, [rows, cols], order=1, mode="nearest")
        target = (z_t - d_t ** 2 / (2 * MARS_RADIUS_M) + h_target - z_obs) / d_t
    vis = target >= terrain.max(axis=1)
    vis[d_t < 1] = True
    return vis


def find_relay(z, cost, hab, mast_h, relay_h, h_suit, vr, vc, comm_hab, t_min, stop_vertex,
               dwell, radius_m, grid_m, res):
    """Best relay position: seen from the habitat, within radius_m of the route, passable.

    Returns (row, col, comm, offline) or None. comm = habitat OR relay, per route vertex.
    """
    hr, hc, z_hab = hab
    z_obs = z_hab + mast_h
    seen = viewshed(z, hr, hc, z_obs, relay_h, res)
    H, W = z.shape
    rad_px = radius_m / res
    route_r, route_c = vr[::5], vc[::5]

    def candidates(step_px, r_lo=0, r_hi=H, c_lo=0, c_hi=W):
        gr, gc = np.mgrid[max(0, r_lo):min(H, r_hi):step_px, max(0, c_lo):min(W, c_hi):step_px]
        gr, gc = gr.ravel(), gc.ravel()
        ok = seen[gr, gc] & np.isfinite(cost[gr, gc])
        gr, gc = gr[ok], gc[ok]
        near = np.zeros(len(gr), bool)
        for a, b in zip(route_r, route_c):
            near |= (gr - a) ** 2 + (gc - b) ** 2 <= rad_px ** 2
        return gr[near], gc[near]

    def score(r, c):
        z_relay = map_coordinates(z, [[r], [c]], order=1)[0] + relay_h
        comm = comm_hab | los_many(z, r, c, z_relay, vr, vc, h_suit, res)
        return offline_minutes(t_min, comm, stop_vertex, dwell), comm

    step = max(1, int(round(grid_m / res)))
    best = None
    for r, c in zip(*candidates(step)):
        off, comm = score(r, c)
        if best is None or off < best[3]:
            best = (int(r), int(c), comm, off)
    if best is None:
        return None
    fine = max(1, step // 4)
    r0, c0 = best[0], best[1]
    for r, c in zip(*candidates(fine, r0 - step, r0 + step + 1, c0 - step, c0 + step + 1)):
        off, comm = score(r, c)
        if off < best[3]:
            best = (int(r), int(c), comm, off)
    return best


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


def coarse_minutes(min_per_m, factor):
    """Block-average a minutes-per-metre grid; a block more than half impassable is impassable."""
    H, W = min_per_m.shape
    h, w = H // factor, W // factor
    blocks = min_per_m[:h * factor, :w * factor].reshape(h, factor, w, factor)
    finite = np.isfinite(blocks)
    mean = np.where(finite, blocks, 0).sum(axis=(1, 3)) / np.maximum(finite.sum(axis=(1, 3)), 1)
    mean[finite.mean(axis=(1, 3)) < 0.5] = np.inf
    return mean


def pick_shelters_minimax(times, svf, rows, cols, count, spacing_px):
    """Choose `count` candidates minimising the longest walk from any route point.

    times: (n_candidates, n_route_points) walking minutes. Greedy start, then swaps until no
    swap improves (longest, mean, sum of SVF). Candidates closer than spacing_px are not combined.
    """
    n = len(svf)

    def far_enough(i, chosen):
        return all(math.hypot(rows[i] - rows[j], cols[i] - cols[j]) >= spacing_px for j in chosen if j != i)

    def objective(chosen):
        best = times[chosen].min(axis=0)
        return (round(float(best.max()), 1), round(float(best.mean()), 2), float(svf[chosen].sum()))

    chosen = []
    for _ in range(count):
        options = [i for i in range(n) if i not in chosen and far_enough(i, chosen)]
        if not options:
            break
        chosen.append(min(options, key=lambda i: objective(chosen + [i])))
    improved = True
    while improved:
        improved = False
        current = objective(chosen)
        for k in range(len(chosen)):
            rest = chosen[:k] + chosen[k + 1:]
            for i in range(n):
                if i in chosen or not far_enough(i, rest):
                    continue
                trial = rest[:k] + [i] + rest[k:]
                if objective(trial) < current:
                    chosen, current, improved = trial, objective(trial), True
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


def load_inputs():
    mission, area = load_mission(), load_area()
    for name in ("dem_clip.tif", "slope.tif", "cost.tif"):
        if not (CACHE / name).exists():
            raise SystemExit(f"ERROR: data/cache/{name} missing (run python -m arazi.slope and arazi.cost)")
    z, tr, crs = read(CACHE / "dem_clip.tif")
    slope, _, _ = read(CACHE / "slope.tif")
    cost, _, _ = read(CACHE / "cost.tif")
    route = json.loads((WEB_DATA / "route.geojson").read_text(encoding="utf-8"))
    summary = json.loads((WEB_DATA / "summary.json").read_text(encoding="utf-8"))
    stops = json.loads((WEB_DATA / "stops.json").read_text(encoding="utf-8"))
    coords = route["geometry"]["coordinates"]
    vr, vc = lonlat_to_rc(coords, tr, crs)
    sr, sc = lonlat_to_rc([s["coord"] for s in stops], tr, crs)
    (hr,), (hc,) = lonlat_to_rc([area["habitat"]], tr, crs)
    return {
        "mission": mission, "z": z, "tr": tr, "crs": crs, "slope": slope, "cost": cost,
        "res": abs(tr.a), "summary": summary, "vr": vr, "vc": vc,
        "t_min": np.array(route["properties"]["t_min"], float),
        "slope_deg": route["properties"]["slope_deg"],
        "stop_vertex": {int(np.argmin(np.hypot(vr - a, vc - b))) for a, b in zip(sr, sc)},
        "hab": (hr, hc, map_coordinates(z, [[hr], [hc]], order=1)[0]),
    }


def radio(d, mast_h):
    """Habitat-only and habitat+relay link along the route for a given mast height."""
    m = d["mission"]
    hr, hc, z_hab = d["hab"]
    h_suit = m["comm_suit_antenna_height_m"]
    comm_hab = np.array(los_points(d["z"], hr, hc, z_hab + mast_h, d["vr"], d["vc"], h_suit, d["res"]))
    off_hab = offline_minutes(d["t_min"], comm_hab, d["stop_vertex"], m["stop_dwell_min"])
    relay = find_relay(d["z"], d["cost"], d["hab"], mast_h, m["relay_antenna_height_m"], h_suit,
                       d["vr"], d["vc"], comm_hab, d["t_min"], d["stop_vertex"], m["stop_dwell_min"],
                       m["relay_search_radius_m"], m["relay_grid_m"], d["res"])
    return comm_hab, off_hab, relay


def mast_sensitivity(heights) -> int:
    d = load_inputs()
    print("| Mast height | Route points with a link (habitat only) | Time without a link, habitat only "
          "| Time without a link, habitat + relay |")
    print("|---|---|---|---|")
    for h in heights:
        comm_hab, off_hab, relay = radio(d, h)
        with_relay = f"{relay[3]:.1f} min" if relay else "no relay site"
        print(f"| {h:g} m | {100 * comm_hab.mean():.0f} % | {off_hab:.1f} min | {with_relay} |")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--mast-sensitivity", help="comma-separated mast heights; print a table, write nothing")
    args = ap.parse_args()
    if args.mast_sensitivity:
        return mast_sensitivity([float(h) for h in args.mast_sensitivity.split(",")])

    d = load_inputs()
    m, z, tr, crs, res = d["mission"], d["z"], d["tr"], d["crs"], d["res"]
    vr, vc, t_min = d["vr"], d["vc"], d["t_min"]
    hr, hc, z_hab = d["hab"]
    h_suit, relay_h = m["comm_suit_antenna_height_m"], m["relay_antenna_height_m"]

    # 1. Radio: habitat, then the best relay
    comm_hab, off_hab, relay = radio(d, m["comm_antenna_height_m"])
    vis = viewshed(z, hr, hc, z_hab + m["comm_antenna_height_m"], h_suit, res)
    relay_out = None
    if relay:
        rr, rc, _, _ = relay
        z_relay = z[rr, rc] + relay_h
        # final link check with the exact (0.5 m) rays
        comm = comm_hab | np.array(los_points(z, rr, rc, z_relay, vr, vc, h_suit, res))
        offline = offline_minutes(t_min, comm, d["stop_vertex"], m["stop_dwell_min"])
        vis = vis | viewshed(z, rr, rc, z_relay, h_suit, res)
        relay_out = {"coord": rc_to_lonlat([rr], [rc], tr, crs)[0], "antenna_height_m": relay_h,
                     "offline_min_without_relay": round(off_hab, 1)}
    else:
        print("WARNING: no relay site is visible from the habitat near the route", file=sys.stderr)
        comm, offline = comm_hab, off_hab
    shadow = np.where(vis | ~np.isfinite(z), np.nan, 1.0)
    label = "No radio link to habitat or relay" if relay_out else "No radio link to habitat"
    overlay = to_overlay_png((shadow, tr, crs), OUT_DIR / "comm_shadow.png", id="comm_shadow",
                             name="Radio shadow", cmap="Reds", vmin=0, vmax=1.2,
                             legend=[{"color": cmap_hex("Reds", 0, 1, 0.85), "label": label}],
                             resampling=Resampling.nearest)

    # Profile points on the route (for route[] and for the shelter objective)
    d_route = route_axis(vr, vc, res)
    z_route = z[np.round(vr).astype(int), np.round(vc).astype(int)]
    idx, worst = match_profile(d["summary"]["profile"], d_route, z_route, d["slope_deg"])

    # 2. Shelters: enclosed candidates, then minimise the longest walk from the route
    H, W = z.shape
    step_px = max(1, int(round(m["svf_grid_m"] / res)))
    gr, gc = np.mgrid[0:H:step_px, 0:W:step_px]
    gr, gc = gr.ravel().astype(float), gc.ravel().astype(float)
    near = np.zeros(len(gr), bool)
    radius_px = m["shelter_search_radius_m"] / res
    for a, b in zip(vr[::2], vc[::2]):
        near |= (gr - a) ** 2 + (gc - b) ** 2 <= radius_px ** 2
    ok = near & np.isfinite(d["cost"][gr.astype(int), gc.astype(int)])
    gr, gc = gr[ok], gc[ok]
    svf = sky_view_factor(z, gr, gc, m["svf_directions"], m["svf_radius_m"], res)
    n_all = len(svf)
    svf_limit = float(np.percentile(svf, m["shelter_svf_percentile"]))
    keep = svf <= svf_limit
    gr, gc, svf = gr[keep], gc[keep], svf[keep]
    # one candidate per cell (a third of the minimum spacing): the most enclosed one
    cell = m["shelter_min_spacing_m"] / 3 / res
    best_in_cell = {}
    for i in np.argsort(svf):
        best_in_cell.setdefault((int(gr[i] // cell), int(gc[i] // cell)), i)
    cand = np.array(sorted(best_in_cell.values()))
    gr, gc, svf = gr[cand], gc[cand], svf[cand]

    uphill = np.nan_to_num(np.tan(np.radians(d["slope"])))
    min_per_m = 1 / speed_m_min(uphill)
    min_per_m[~np.isfinite(d["cost"])] = np.inf
    factor = step_px
    coarse = coarse_minutes(min_per_m, factor)
    mcp = MCP_Geometric(coarse, fully_connected=True)
    pr = np.clip((np.round(vr[idx]) // factor).astype(int), 0, coarse.shape[0] - 1)
    pc = np.clip((np.round(vc[idx]) // factor).astype(int), 0, coarse.shape[1] - 1)
    times = np.empty((len(gr), len(idx)))
    for k, (a, b) in enumerate(zip(gr, gc)):
        start = (min(int(a) // factor, coarse.shape[0] - 1), min(int(b) // factor, coarse.shape[1] - 1))
        costs, _ = mcp.find_costs([start])
        times[k] = costs[pr, pc] * factor * res
    pick = pick_shelters_minimax(times, svf, gr, gc, m["shelter_count"], m["shelter_min_spacing_m"] / res)
    shelter_ll = rc_to_lonlat(gr[pick], gc[pick], tr, crs)
    shelters = [{"coord": ll, "svf": round(float(svf[i]), 3)} for ll, i in zip(shelter_ll, pick)]

    # Final walking time to the nearest shelter on the 1 m grid
    starts = [(int(gr[i]), int(gc[i])) for i in pick]
    to_shelter, _ = MCP_Geometric(min_per_m, fully_connected=True).find_costs(starts)
    to_shelter = to_shelter * res

    # 3. route[] on summary.profile's d axis
    safety_route = []
    for p, i in zip(d["summary"]["profile"], idx):
        t = to_shelter[int(round(vr[i])), int(round(vc[i]))]
        safety_route.append({"d": p["d"], "comm_ok": bool(comm[i]),
                             "shelter_min": round(float(t), 1) if np.isfinite(t) else None})

    out = {"overlays": [overlay], "shelters": shelters, "route": safety_route,
           "offline_min": round(offline, 1)}
    if relay_out:
        out["relay"] = relay_out
    write_json(OUT_JSON, out)

    print(f"radio: habitat only {off_hab:.1f} min offline; with relay {offline:.1f} of {t_min[-1]:.1f} min; "
          f"relay {relay_out['coord'] if relay_out else None}; shadow {100 * (~vis & np.isfinite(z)).mean():.1f} % of the map")
    sm = [r["shelter_min"] for r in safety_route if r["shelter_min"] is not None]
    print(f"shelters: {len(shelters)} chosen from {len(gr)} candidates ({n_all} points, SVF <= {svf_limit:.3f}); "
          f"svf {[s['svf'] for s in shelters]}")
    print(f"shelter_min along the route: max {max(sm):.1f}, mean {np.mean(sm):.1f} min")
    print(f"profile match: {len(idx)} points, worst d offset {worst:.1f} m")
    return 0


if __name__ == "__main__":
    sys.exit(main())
