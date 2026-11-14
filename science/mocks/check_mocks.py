"""Validate web/data/ mocks (and the real files they depend on) against docs/contracts.md.

Run from the repo root:  python -m science.mocks.check_mocks
Exit code 1 on schema errors; mismatches between mocks and real files are printed as warnings.
"""
import json
import math
import sys

from pipeline.common import WEB_DATA as DATA
AREA = json.loads((DATA / "area.json").read_text(encoding="utf-8"))
BBOX = AREA["bbox"]
errors, warnings = [], []


def check(cond, msg):
    if not cond:
        errors.append(msg)


def load(name):
    return json.loads((DATA / name).read_text(encoding="utf-8"))  # raises on invalid JSON


def num(x):
    return isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x)


NEAR_M = 1.0  # one DEM pixel: route vertices are pixel centres, so exact equality is too strict


def dm(a, b):
    m = math.pi * 3396190 / 180
    return math.hypot((b[0] - a[0]) * m * math.cos(math.radians((a[1] + b[1]) / 2)), (b[1] - a[1]) * m)


def nearest(p, pts):
    """(index, distance in m) of the point in pts closest to p."""
    return min(((i, dm(p, q)) for i, q in enumerate(pts)), key=lambda x: x[1])


def point(p, where):
    ok = (isinstance(p, list) and len(p) == 2 and all(num(v) for v in p)
          and BBOX["west"] <= p[0] <= BBOX["east"] and BBOX["south"] <= p[1] <= BBOX["north"])
    check(ok, f"{where}: {p} is not a [lon, lat] inside the bbox")


def keys(obj, req, where):
    check(isinstance(obj, dict), f"{where}: not an object")
    if isinstance(obj, dict):
        missing = [k for k in req if k not in obj]
        check(not missing, f"{where}: missing {missing}")


def cross(cond, msg):
    """Cross-file check: an error between mocks, a warning once a real file is involved."""
    if not cond:
        (warnings if REAL_ROUTE else errors).append(msg)


def marked(obj, where):
    """A file is either a marked mock or a real file; a half-marked file is an error."""
    is_mock = obj.get("mock") is True or obj.get("source") == "MOCK"
    if is_mock:
        check(obj.get("mock") is True and obj.get("source") == "MOCK", f"{where}: mock marker incomplete")
    print(f"  {where}: {'mock' if is_mock else 'real'}")


def bbox_obj(b, where):
    keys(b, ["west", "south", "east", "north"], where)


def overlay_list(lst, where):
    check(isinstance(lst, list), f"{where}: not a list")
    for i, ov in enumerate(lst):
        keys(ov, ["id", "name", "png", "bounds", "legend"], f"{where}[{i}]")
        check((DATA.parent / ov["png"]).exists(), f"{where}[{i}]: png {ov['png']} does not exist")
        bbox_obj(ov["bounds"], f"{where}[{i}].bounds")


def ring_ok(ring, where, real=False):
    """Mocks: CCW and inside the bbox, or error. Real files: both are warnings only."""
    check(len(ring) >= 4 and ring[0] == ring[-1], f"{where}: ring not closed")
    area2 = sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(ring, ring[1:]))
    msg = f"{where}: exterior ring is not counter-clockwise (RFC 7946)"
    if real:
        if area2 <= 0:
            warnings.append(msg)
        outside = sum(not inside_bbox(p) for p in ring)
        if outside:
            warnings.append(f"{where}: {outside} of {len(ring)} vertices outside the bbox")
    else:
        check(area2 > 0, msg)
        for p in ring:
            point(p, where)


def inside_bbox(p):
    return BBOX["west"] <= p[0] <= BBOX["east"] and BBOX["south"] <= p[1] <= BBOX["north"]


def in_ring(p, ring):
    """Point in polygon (ray casting)."""
    x, y, hit = p[0], p[1], False
    for (x1, y1), (x2, y2) in zip(ring, ring[1:]):
        if (y1 > y) != (y2 > y) and x < x1 + (y - y1) * (x2 - x1) / (y2 - y1):
            hit = not hit
    return hit


def _cross(a, b, c, d):
    def orient(p, q, r):
        return (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])
    return (orient(a, b, c) * orient(a, b, d) < 0) and (orient(c, d, a) * orient(c, d, b) < 0)


def polygon_hits_bbox(rings):
    """True if the polygon (outer ring minus holes) intersects the bbox."""
    w, s, e, n = BBOX["west"], BBOX["south"], BBOX["east"], BBOX["north"]
    box = [[w, s], [e, s], [e, n], [w, n], [w, s]]
    outer, holes = rings[0], rings[1:]
    if any(inside_bbox(p) for p in outer):
        return True
    if any(_cross(a, b, c, d) for a, b in zip(outer, outer[1:]) for c, d in zip(box, box[1:])):
        return True
    # bbox entirely inside the outer ring: intersects unless it sits entirely in a hole
    corners_in = all(in_ring(c, outer) for c in box[:4])
    return corners_in and not any(all(in_ring(c, h) for c in box[:4]) for h in holes)


# area.json (real file, not a mock)
keys(AREA, ["bbox", "habitat", "crs"], "area.json")
bbox_obj(BBOX, "area.bbox")
check(BBOX["west"] < BBOX["east"] and BBOX["south"] < BBOX["north"], "area.bbox: west/east or south/north swapped")
point(AREA["habitat"], "area.habitat")
check(AREA["crs"] == "+proj=longlat +R=3396190 +no_defs", "area.crs differs from CLAUDE.md")
check("mock" not in AREA and "source" not in AREA, "area.json must not carry a mock marker")

# overlays.json
ov = load("overlays.json")
overlay_list(ov, "overlays.json")

# route.geojson
route = load("route.geojson")
REAL_ROUTE = route.get("mock") is not True
if not REAL_ROUTE:
    marked(route, "route.geojson")
check(route.get("type") == "Feature", "route: not a Feature")
g = route["geometry"]
check(g["type"] == "LineString", "route: not a LineString")
coords = g["coordinates"]
for i, p in enumerate(coords):
    point(p, f"route.coords[{i}]")
pr = route["properties"]
for k in ("slope_deg", "t_min"):
    check(len(pr[k]) == len(coords), f"route: {k} length {len(pr[k])} != {len(coords)} coords")
    check(all(num(v) for v in pr[k]), f"route: {k} has non-numbers")
check(all(b >= a for a, b in zip(pr["t_min"], pr["t_min"][1:])), "route: t_min not cumulative")
check(pr["t_min"][0] == 0, "route: t_min does not start at 0")
cross(dm(coords[0], AREA["habitat"]) <= NEAR_M and dm(coords[-1], AREA["habitat"]) <= NEAR_M,
      "route: does not start and end at the habitat")

# summary.json
s = load("summary.json")
if s.get("mock") is True or not REAL_ROUTE:
    marked(s, "summary.json")
keys(s, ["distance_m", "duration_min", "o2_used_pct", "dose_mSv", "max_slope_deg", "profile"], "summary")
for k in ("distance_m", "duration_min", "o2_used_pct", "dose_mSv", "max_slope_deg"):
    check(num(s[k]), f"summary.{k} not a number")
for i, row in enumerate(s["profile"]):
    keys(row, ["d", "z", "slope"], f"summary.profile[{i}]")
ds = [r["d"] for r in s["profile"]]
check(ds[0] == 0 and all(b > a for a, b in zip(ds, ds[1:])), "summary: profile d not increasing from 0")
cross(abs(ds[-1] - s["distance_m"]) <= 1, "summary: distance_m != last profile d")
cross(abs(s["duration_min"] - pr["t_min"][-1]) <= 1, "summary: duration_min != route t_min[-1]")
cross(abs(s["max_slope_deg"] - max(pr["slope_deg"])) <= 0.1, "summary: max_slope_deg != max route slope")

# safety/safety.json
sf = load("safety/safety.json")
marked(sf, "safety.json")
keys(sf, ["overlays", "shelters", "route", "offline_min"], "safety")
overlay_list(sf["overlays"], "safety.overlays")
for i, sh in enumerate(sf["shelters"]):
    keys(sh, ["coord", "svf"], f"safety.shelters[{i}]")
    point(sh["coord"], f"safety.shelters[{i}].coord")
    check(num(sh["svf"]) and 0 <= sh["svf"] <= 1, f"safety.shelters[{i}].svf out of 0-1")
for i, r in enumerate(sf["route"]):
    keys(r, ["d", "comm_ok", "shelter_min"], f"safety.route[{i}]")
    check(isinstance(r["comm_ok"], bool), f"safety.route[{i}].comm_ok not bool")
cross([r["d"] for r in sf["route"]] == ds, "safety.route d axis != summary.profile d")
check(num(sf["offline_min"]), "safety.offline_min not a number")
if "relay" in sf:   # optional
    rl = sf["relay"]
    keys(rl, ["coord", "antenna_height_m"], "safety.relay")
    point(rl["coord"], "safety.relay.coord")
    check(num(rl["antenna_height_m"]) and rl["antenna_height_m"] > 0, "safety.relay.antenna_height_m not > 0")
    if "offline_min_without_relay" in rl:
        check(num(rl["offline_min_without_relay"]) and rl["offline_min_without_relay"] >= sf["offline_min"],
              "safety.relay: offline_min_without_relay is below offline_min")

# stops.json
stops = load("stops.json")
check(isinstance(stops, list) and stops, "stops: not a non-empty list")
ids = [st["id"] for st in stops]
check(len(set(ids)) == len(ids), "stops: duplicate ids")
stop_mock = [st.get("mock") is True for st in stops]
check(all(stop_mock) or not any(stop_mock), "stops: some stops are marked mock, some are not")
print(f"  stops.json: {'mock' if all(stop_mock) else 'real'}")
for i, st in enumerate(stops):
    keys(st, ["id", "name", "coord", "science", "photos"], f"stops[{i}]")
    point(st["coord"], f"stops[{i}].coord")
    cross(nearest(st["coord"], coords)[1] <= NEAR_M, f"stops[{i}]: not on the route (> {NEAR_M} m from a vertex)")
    for j, ph in enumerate(st["photos"]):
        keys(ph, ["url", "sol", "camera", "credit"], f"stops[{i}].photos[{j}]")
        check(ph["credit"].startswith("NASA/JPL-Caltech"), f"stops[{i}].photos[{j}]: credit")
check(len({st["name"] for st in stops}) == len(stops), "stops: duplicate names")
for i, a in enumerate(stops):
    for b in stops[i + 1:]:
        check(dm(a["coord"], b["coord"]) >= 150, f"stops: {a['id']} and {b['id']} closer than 150 m")
if all(nearest(st["coord"], coords)[1] <= NEAR_M for st in stops):
    first_idx = [nearest(st["coord"], coords)[0] for st in stops]
    cross(first_idx == sorted(first_idx), "stops: not in route order")

# geology.geojson
geo = load("geology.geojson")
marked(geo, "geology.geojson")
check(geo.get("type") == "FeatureCollection", "geology: not a FeatureCollection")
geo_real = not (geo.get("mock") is True or geo.get("source") == "MOCK")
hits = []
for i, f in enumerate(geo["features"]):
    check(f["geometry"]["type"] == "Polygon", f"geology[{i}]: not a Polygon")
    keys(f["properties"], ["unit", "name", "note"], f"geology[{i}].properties")
    ring_ok(f["geometry"]["coordinates"][0], f"geology[{i}]", real=geo_real)
    hit = polygon_hits_bbox(f["geometry"]["coordinates"])
    hits.append(hit)
    if not hit:
        warnings.append(f"geology[{i}] ({f['properties'].get('unit')}): does not intersect the bbox")
check(any(hits), "geology: no polygon intersects the bbox")
print(f"  geology: {sum(hits)} of {len(hits)} polygons intersect the bbox")

# donki.json
d = load("donki.json")
marked(d, "donki.json")
check(d["mode"] in ("live", "replay"), "donki: bad mode")
for i, e in enumerate(d["events"]):
    keys(e, ["type", "start", "peak", "mars_impact"], f"donki.events[{i}]")
    check(e["start"].endswith("Z") and (e["peak"] is None or e["peak"].endswith("Z")), f"donki.events[{i}]: time not UTC Z")

# radiation.json
r = load("radiation.json")
marked(r, "radiation.json")
keys(r, ["base_mSv_per_day", "event_multiplier", "status", "message"], "radiation")
check(r["status"] in ("nominal", "elevated", "storm"), "radiation: bad status")
if "replay" in r:   # optional
    rp = r["replay"]
    keys(rp, ["status", "event_multiplier", "message", "event_dose_mGy", "duration_min"], "radiation.replay")
    check(rp.get("status") in ("nominal", "elevated", "storm"), "radiation.replay: bad status")
    check(num(rp.get("duration_min")) and rp["duration_min"] > 0, "radiation.replay.duration_min not > 0")
    if "habitat_dose_factor" in rp:
        check(num(rp["habitat_dose_factor"]) and 0 <= rp["habitat_dose_factor"] <= 1,
              "radiation.replay.habitat_dose_factor not in 0-1")

# alerts.json
a = load("alerts.json")
marked(a, "alerts.json")
metrics = {"o2_remaining_pct", "o2_used_pct", "dose_mSv", "slope_deg", "max_slope_deg", "shelter_min",
           "eva_remaining_min", "elapsed_min", "sun_el", "earth_el", "light_time_min",
           "comm_ok", "at_habitat", "radiation_status", "eva_state"}   # docs/contracts.md
for i, rule in enumerate(a["rules"]):
    keys(rule, ["id", "metric", "op", "value", "level", "text"], f"alerts.rules[{i}]")
    check(rule["op"] in ("<", "<=", ">", ">=", "==", "!="), f"alerts.rules[{i}]: bad op")
    check(rule["level"] in ("info", "warn", "danger"), f"alerts.rules[{i}]: bad level")
    check(rule["metric"] in metrics, f"alerts.rules[{i}]: unknown metric")

print(f"route/summary/overlays: {'REAL (not mocks)' if REAL_ROUTE else 'mocks'}")
print("ERRORS:" if errors else "All files are valid JSON and match docs/contracts.md.")
for e in errors:
    print(" -", e)
if warnings:
    print("WARNINGS:")
for w in warnings:
    print(" -", w)
print(f"route: {len(coords)} vertices, {s['distance_m']} m, {s['duration_min']} min, "
      f"O2 {s['o2_used_pct']}%, dose {s['dose_mSv']} mSv, max slope {s['max_slope_deg']} deg, "
      f"offline {sf['offline_min']} min")
for st in stops:
    print(f"  {st['id']} {st['name']:24s} {st['coord']}  photos sol {[p['sol'] for p in st['photos']]} {[p['camera'] for p in st['photos']]}")
sys.exit(1 if errors else 0)
