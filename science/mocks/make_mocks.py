"""Generate mock files under web/data/ from area.json and the Curiosity traverse.

Run from the repo root:  python -m science.mocks.make_mocks
Writes only files that do not exist yet and never overwrites; to rebuild a mock, delete it first.
Check the result with:   python -m science.mocks.check_mocks
"""
import json
import math

from pipeline.common import WEB_DATA as DATA

# Study area and habitat always come from area.json.
_area = json.loads((DATA / "area.json").read_text(encoding="utf-8"))
BBOX = _area["bbox"]
HABITAT = _area["habitat"]
R = 3396190.0
M_PER_DEG = math.pi * R / 180.0

# Mock-only assumptions (real values will come from science/models.py and config/mission.json).
STEP_M = 25.0
DWELL_MIN = 20.0
FLAT_SPEED_KMH = 2.5
O2_NOMINAL_MIN = 8 * 60
O2_WALK_FACTOR, O2_REST_FACTOR = 1.25, 0.8
RAD_BASE = 0.64
MOCK = {"mock": True, "source": "MOCK"}


def dist_m(a, b):
    lat0 = math.radians((a[1] + b[1]) / 2)
    dx = (b[0] - a[0]) * M_PER_DEG * math.cos(lat0)
    dy = (b[1] - a[1]) * M_PER_DEG
    return math.hypot(dx, dy)


def offset(p, east_m, north_m):
    return [p[0] + east_m / (M_PER_DEG * math.cos(math.radians(p[1]))), p[1] + north_m / M_PER_DEG]


def resample(line, step):
    out = [line[0]]
    carry = 0.0
    for a, b in zip(line, line[1:]):
        seg = dist_m(a, b)
        if seg == 0:
            continue
        pos = step - carry
        while pos <= seg:
            f = pos / seg
            out.append([a[0] + f * (b[0] - a[0]), a[1] + f * (b[1] - a[1])])
            pos += step
        carry = seg - (pos - step)
    if dist_m(out[-1], line[-1]) > step * 0.3:
        out.append(line[-1])
    return out


def rnd(p):
    return [round(p[0], 6), round(p[1], 6)]


def write(name, obj):
    path = DATA / name
    if path.exists():
        print(f"SKIP (exists): {name}")
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"wrote: web/data/{name}")


# --- Curiosity traverse: pick the stretch nearest the habitat --------------------------------
trav = json.loads((DATA / "traverse.geojson").read_text(encoding="utf-8"))
feats = trav["features"] if trav["type"] == "FeatureCollection" else [trav]
best = None
for fi, f in enumerate(feats):
    for pi, p in enumerate(f["geometry"]["coordinates"]):
        d = dist_m(HABITAT, p)
        if best is None or d < best[0]:
            best = (d, fi, pi)
_, fi, pi = best
feat = feats[fi]
tcoords = feat["geometry"]["coordinates"]
props = feat["properties"]

# Walk ~1300 m along the traverse from the nearest point, in the direction that has room.
def along(start, direction, length):
    pts, acc, i = [tcoords[start]], 0.0, start
    while 0 <= i + direction < len(tcoords) and acc < length:
        acc += dist_m(tcoords[i], tcoords[i + direction])
        i += direction
        pts.append(tcoords[i])
    return pts, i

fwd, end_fwd = along(pi, +1, 1300)
bwd, end_bwd = along(pi, -1, 1300)
window, end_idx = (fwd, end_fwd) if len(fwd) >= len(bwd) else (bwd, end_bwd)
trav_part = resample(window, STEP_M)

# Sol estimate for each traverse point (linear in index within the segment).
def sol_at(idx):
    return props["sol_start"] + (props["sol_end"] - props["sol_start"]) * idx / (len(tcoords) - 1)

# Route: habitat -> traverse stretch -> back to habitat.
out_leg = resample([HABITAT, trav_part[0]], STEP_M)
back_leg = resample([trav_part[-1], HABITAT], STEP_M)
verts = out_leg[:-1] + trav_part + back_leg[1:]
verts[-1] = list(HABITAT)

# Stops on traverse vertices: greedy along the stretch, at least MIN_SEP_M (straight line)
# from the habitat and from every earlier stop, so a rover that doubled back does not
# produce two stops on the same spot.
MIN_SEP_M, MAX_STOPS = 200.0, 4
n_out = len(out_leg) - 1
chosen = []
for j, p in enumerate(trav_part):
    if len(chosen) == MAX_STOPS:
        break
    if all(dist_m(p, q) >= MIN_SEP_M for q in [HABITAT] + [trav_part[c] for c in chosen]):
        chosen.append(j)
stop_vidx = [n_out + j for j in chosen]

# --- Elevation profile (smooth, closed loop) -------------------------------------------------
cum = [0.0]
for a, b in zip(verts, verts[1:]):
    cum.append(cum[-1] + dist_m(a, b))
L = cum[-1]
k = max(3, round(L / 170))
z = [-4150.0 + 15 * math.sin(2 * math.pi * 2 * d / L) + 6 * math.sin(2 * math.pi * k * d / L) for d in cum]
slope = [0.0]
for i in range(1, len(verts)):
    dd = cum[i] - cum[i - 1]
    slope.append(math.degrees(math.atan(abs(z[i] - z[i - 1]) / dd)) if dd else slope[-1])

# --- Timing: Tobler-like walking speed, dwell at stops via a duplicated vertex ---------------
def speed_m_min(dz, dd):
    grade = dz / dd if dd else 0.0
    kmh = FLAT_SPEED_KMH / math.exp(-0.175) * math.exp(-3.5 * abs(grade + 0.05))
    return kmh * 1000 / 60

coords, slope_deg, t_min, vz, vd = [], [], [], [], []
t = walk_min = rest_min = 0.0
for i, p in enumerate(verts):
    if i:
        dd = cum[i] - cum[i - 1]
        dt = dd / speed_m_min(z[i] - z[i - 1], dd)
        t += dt
        walk_min += dt
    coords.append(rnd(p)); slope_deg.append(round(slope[i], 1)); t_min.append(round(t, 1))
    vz.append(z[i]); vd.append(cum[i])
    if i in stop_vidx:
        t += DWELL_MIN
        rest_min += DWELL_MIN
        coords.append(rnd(p)); slope_deg.append(round(slope[i], 1)); t_min.append(round(t, 1))
        vz.append(z[i]); vd.append(cum[i])

duration = round(t_min[-1], 1)
o2_used = (walk_min * O2_WALK_FACTOR + rest_min * O2_REST_FACTOR) / O2_NOMINAL_MIN * 100
dose = RAD_BASE * duration / 1440

route = {"type": "Feature", **MOCK,
         "geometry": {"type": "LineString", "coordinates": coords},
         "properties": {"slope_deg": slope_deg, "t_min": t_min, "mock": True}}

profile = [{"d": round(cum[i], 1), "z": round(z[i], 1), "slope": round(slope[i], 1)} for i in range(len(verts))]
summary = {"distance_m": round(L), "duration_min": duration, "o2_used_pct": round(o2_used, 1),
           "dose_mSv": round(dose, 3), "max_slope_deg": max(slope_deg), "profile": profile, **MOCK}

# --- Geology: three east-west bands, Mount Sharp rising to the south --------------------------
W, E, S, N = BBOX["west"], BBOX["east"], BBOX["south"], BBOX["north"]
xs = [W + (E - W) * i / 8 for i in range(9)]
b1 = [[x, -4.7445 + 0.0015 * math.sin(i * 1.3)] for i, x in enumerate(xs)]
b2 = [[x, -4.7585 + 0.0015 * math.sin(i * 0.9 + 1)] for i, x in enumerate(xs)]
rings = [
    b1 + [[E, N], [W, N], b1[0]],
    b2 + b1[::-1] + [b2[0]],
    [[W, S], [E, S]] + b2[::-1] + [[W, S]],
]
units = [
    ("Mcb", "Clay-bearing mudstone (Murray formation)",
     "Fine-grained lake mudstone rich in clay minerals; a record of long-lived water."),
    ("Mtr", "Clay-to-sulfate transition",
     "Interbedded mudstone and sandstone where clay minerals give way to sulfate salts."),
    ("Msu", "Layered sulfate-bearing unit",
     "Sulfate-bearing layers from a drying climate; resistant ridges and veins are common."),
]
geology = {"type": "FeatureCollection", **MOCK, "features": [
    {"type": "Feature",
     "geometry": {"type": "Polygon", "coordinates": [[rnd(p) for p in ring]]},
     "properties": {"unit": u, "name": n, "note": f"MOCK unit, not from the USGS map. {note}", "mock": True}}
    for ring, (u, n, note) in zip(rings, units)]}

def unit_at(p):
    def lat_on(b):
        for a, c in zip(b, b[1:]):
            if a[0] <= p[0] <= c[0]:
                f = (p[0] - a[0]) / (c[0] - a[0])
                return a[1] + f * (c[1] - a[1])
        return b[-1][1]
    if p[1] >= lat_on(b1):
        return 0
    return 1 if p[1] >= lat_on(b2) else 2

# --- Stops ------------------------------------------------------------------------------------
images = json.loads((DATA / "images.json").read_text(encoding="utf-8"))
stop_text = [
    [("Clay-rich mudstone", "Mudstone with clay minerals that formed in standing water. Look for fine lamination and light-toned veins."),
     ("Laminated lake beds", "Millimetre-thin layers settled out of a calm lake; their chemistry tracks how the water changed.")],
    [("Vein-filled outcrop", "Light-toned calcium sulfate veins cut the bedrock; groundwater moved through these fractures long after the lake dried."),
     ("Cross-bedded sandstone", "Inclined sand layers show where wind or flowing water moved sediment across the transition zone.")],
    [("Layered sulfate slope", "Thin repeating layers rich in sulfate salts record a drier climate as Mount Sharp built up."),
     ("Resistant ridge", "A ridge of mineral-cemented rock that stands out because it eroded more slowly than the layers around it."),
     ("Sulfate vein network", "Bright fractures filled with calcium sulfate show that groundwater kept moving through the rock after it formed."),
     ("Wind-scoured bedrock", "Wind-blown sand has polished and grooved this bedrock; the grooves point along the prevailing wind.")],
]
used = [0, 0, 0]
stops = []
for n, vi in enumerate(stop_vidx, 1):
    p = verts[vi]
    ti = min(range(len(tcoords)), key=lambda j: dist_m(p, tcoords[j]))
    sol = sol_at(ti)
    picks, cams = [], set()
    for im in sorted(images, key=lambda im: abs(im["sol"] - sol)):
        if im["camera"] not in cams:
            picks.append({k: im[k] for k in ("url", "sol", "camera", "credit")})
            cams.add(im["camera"])
        if len(picks) == 2:
            break
    u = unit_at(p)
    name, science = stop_text[u][used[u] % len(stop_text[u])]
    used[u] += 1
    stops.append({"id": f"s{n}", "name": name, "coord": rnd(p), "science": science,
                  "photos": picks, "mock": True})

# --- Safety -----------------------------------------------------------------------------------
shelters = []
for f, svf in ((0.2, 0.58), (0.45, 0.47), (0.65, 0.63), (0.85, 0.52)):
    p = verts[round(f * (len(verts) - 1))]
    shelters.append({"coord": rnd(offset(p, -70, -40)), "svf": svf})

flat = FLAT_SPEED_KMH * 1000 / 60
shadow = (0.55 * L, 0.68 * L)
safety_route, offline = [], 0.0
for i in range(len(vd)):
    comm = not (shadow[0] <= vd[i] < shadow[1])
    if i + 1 < len(vd) and not comm:
        offline += t_min[i + 1] - t_min[i]
    if i and vd[i] == vd[i - 1]:
        continue  # duplicated stop vertex
    p = coords[i]
    sm = min(dist_m(p, s["coord"]) for s in shelters) / flat
    safety_route.append({"d": round(vd[i], 1), "comm_ok": comm, "shelter_min": round(sm, 1)})

safety = {"overlays": [], "shelters": shelters, "route": safety_route,
          "offline_min": round(offline, 1), **MOCK}

# --- DONKI, radiation, alerts -----------------------------------------------------------------
donki = {"mode": "replay", "events": [
    {"type": "FLR", "start": "2024-05-20T05:00:00Z", "peak": "2024-05-20T05:22:00Z", "mars_impact": True},
    {"type": "CME", "start": "2024-05-20T05:36:00Z", "peak": None, "mars_impact": True},
    {"type": "SEP", "start": "2024-05-20T06:00:00Z", "peak": None, "mars_impact": True},
], **MOCK}

radiation = {"base_mSv_per_day": RAD_BASE, "event_multiplier": 1.0, "status": "nominal",
             "message": "Background GCR only.", **MOCK}

alerts = {"rules": [
    {"id": "o2_warn", "metric": "o2_remaining_pct", "op": "<", "value": 40, "level": "warn", "text": "O2 below 40%. Plan the return leg."},
    {"id": "o2_low", "metric": "o2_remaining_pct", "op": "<", "value": 25, "level": "danger", "text": "O2 reserve reached. Return to habitat."},
    {"id": "dose_warn", "metric": "dose_mSv", "op": ">=", "value": 0.25, "level": "warn", "text": "EVA dose above plan. Shorten the stop."},
    {"id": "slope_warn", "metric": "slope_deg", "op": ">", "value": 15, "level": "warn", "text": "Steep ground. Slow down."},
    {"id": "slope_max", "metric": "slope_deg", "op": ">", "value": 25, "level": "danger", "text": "Slope over limit. Turn back."},
    {"id": "comm_lost", "metric": "comm_ok", "op": "==", "value": False, "level": "warn", "text": "Radio shadow. No link to habitat."},
    {"id": "shelter_far", "metric": "shelter_min", "op": ">", "value": 15, "level": "info", "text": "Nearest shelter is more than 15 min away."},
], **MOCK}

print(f"traverse segment sols {props['sol_start']}-{props['sol_end']}, nearest point {best[0]:.0f} m from habitat")
for name, obj in [("stops.json", stops), ("geology.geojson", geology), ("safety/safety.json", safety),
                  ("donki.json", donki), ("radiation.json", radiation), ("alerts.json", alerts),
                  ("overlays.json", []), ("route.geojson", route), ("summary.json", summary)]:
    write(name, obj)
