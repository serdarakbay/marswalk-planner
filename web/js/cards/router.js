// Route planner for the stop cards' navigation view (Egemen). Pure maths, no DOM:
// a walking graph on the DEM heightmap and an A* search between two points.
//
// Input grid: summary.terrain (Demir's heightmap of the 1 m USGS DEM, 4.6 m/px, rg16)
// plus the radio-shadow mask from safety.json (Utku). The walking model is the one the
// planned route uses (arazi/walk.py, arazi/cost.py):
//   speed  = Tobler's hiking function x suit_speed_factor        (mission.json)
//   steep  = slope > slope_max_deg is impassable; NoData is impassable
//   safety = cost.py's slope penalty (slope / slope_warn_deg)^2 + a radio-shadow penalty
// O2 and dose are estimates: O2 is scaled from the planned route's O2 per minute
// (summary.json) unless summary.o2_lut gives a per-grade table; dose = time x base rate.

const MARS_RADIUS_M = 3396190;
const M_PER_DEG = (MARS_RADIUS_M * Math.PI) / 180;

// Used only when data/mission.json is missing (it is copied from config/ at deploy time).
// Same values as config/mission.json.
const MISSION_FALLBACK = {
  slope_warn_deg: 15,
  slope_max_deg: 25,
  suit_speed_factor: 0.6,
  stop_dwell_min: 15,
  o2_reserve_pct: 25,
  eva_nominal_hours: 8,
  rad_base_mSv_per_day: 0.64,
};

// Tobler's hiking function (km/h), as in arazi/walk.py
const TOBLER_KMH = 6;
const TOBLER_K = 3.5;
const TOBLER_OFFSET = 0.05;
const KMH_TO_M_MIN = 1000 / 60;

// Planner choices (display and routing only; not mission thresholds)
const COMM_PENALTY = 2;          // safest route: a minute without radio counts as 1 + 2 minutes
const ALT_PENALTY = 1.6;         // alternative: cells next to the fastest route cost this much more
const ALT_BAND_CELLS = 4;        // ... within this many cells of it
const ALT_MAX_OVERLAP = 0.6;     // drop the alternative if it shares more than this with another option
const SNAP_MAX_M = 60;           // a picked point snaps to walkable ground within this distance
const LIMIT_HOURS = 24;          // stop searching beyond this (nothing that long is a walk)

const NEIGHBOURS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

export function missionValue(state, key) {
  const v = Number(state?.mission?.[key]);
  return Number.isFinite(v) ? v : MISSION_FALLBACK[key];
}

// ------------------------------------------------------------------ grid
// heightmap: {width, height, data: RGBA bytes}, shadow: Uint8Array(width*height) or null
export function buildGrid({ width: W, height: H, data }, terrain, shadow, state) {
  const b = terrain.bounds;
  const zMin = Number(terrain.z_min_m); const zMax = Number(terrain.z_max_m);
  if (!b || !Number.isFinite(zMin) || !Number.isFinite(zMax)) throw new Error('summary.terrain needs bounds, z_min_m and z_max_m');
  const gray = terrain.encoding === 'gray8';
  const N = W * H;
  const z = new Float32Array(N);
  const valid = new Uint8Array(N);
  for (let k = 0; k < N; k++) {
    const o = k * 4;
    if (data[o + 3] === 0) continue;          // transparent = NoData
    const f = gray ? data[o] / 255 : (data[o] * 256 + data[o + 1]) / 65535;
    z[k] = zMin + f * (zMax - zMin);
    valid[k] = 1;
  }
  const lat0 = (b.north + b.south) / 2;
  const dx = ((b.east - b.west) * M_PER_DEG * Math.cos((lat0 * Math.PI) / 180)) / (W - 1);
  const dy = ((b.north - b.south) * M_PER_DEG) / (H - 1);

  // slope of each cell (central differences, metres), as in arazi/slope.py
  const slope = new Float32Array(N);
  const maxDeg = missionValue(state, 'slope_max_deg');
  const pass = new Uint8Array(N);
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const k = j * W + i;
      if (!valid[k]) continue;
      const l = valid[k - 1] && i > 0 ? k - 1 : k; const r = valid[k + 1] && i < W - 1 ? k + 1 : k;
      const u = j > 0 && valid[k - W] ? k - W : k; const d = j < H - 1 && valid[k + W] ? k + W : k;
      const gx = (z[r] - z[l]) / (dx * Math.max(1, (r - l)));
      const gy = (z[d] - z[u]) / (dy * Math.max(1, (d - u) / W));
      slope[k] = (Math.atan(Math.hypot(gx, gy)) * 180) / Math.PI;
      pass[k] = slope[k] <= maxDeg ? 1 : 0;
    }
  }
  return { W, H, z, slope, pass, shadow, dx, dy, bounds: b };
}

export function cellToLonLat(g, k) {
  const i = k % g.W; const j = Math.floor(k / g.W);
  const b = g.bounds;
  return [b.west + (i / (g.W - 1)) * (b.east - b.west), b.north - (j / (g.H - 1)) * (b.north - b.south)];
}

function lonLatToCell(g, [lon, lat]) {
  const b = g.bounds;
  const i = Math.round(((lon - b.west) / (b.east - b.west)) * (g.W - 1));
  const j = Math.round(((b.north - lat) / (b.north - b.south)) * (g.H - 1));
  if (i < 0 || j < 0 || i >= g.W || j >= g.H) return -1;
  return j * g.W + i;
}

// nearest walkable cell to a point (or -1)
export function snap(g, coord) {
  const k0 = lonLatToCell(g, coord);
  if (k0 < 0) return -1;
  if (g.pass[k0]) return k0;
  const i0 = k0 % g.W; const j0 = Math.floor(k0 / g.W);
  const rMax = Math.ceil(SNAP_MAX_M / Math.min(g.dx, g.dy));
  let best = -1; let bd = Infinity;
  for (let r = 1; r <= rMax && best < 0; r++) {
    for (let j = j0 - r; j <= j0 + r; j++) {
      for (let i = i0 - r; i <= i0 + r; i++) {
        if (i < 0 || j < 0 || i >= g.W || j >= g.H) continue;
        if (Math.max(Math.abs(i - i0), Math.abs(j - j0)) !== r) continue;
        const k = j * g.W + i;
        if (!g.pass[k]) continue;
        const d = Math.hypot((i - i0) * g.dx, (j - j0) * g.dy);
        if (d < bd) { bd = d; best = k; }
      }
    }
  }
  return best;
}

// ------------------------------------------------------------------ walking model
export function speedMMin(grade, state) {
  return TOBLER_KMH * Math.exp(-TOBLER_K * Math.abs(grade + TOBLER_OFFSET)) * KMH_TO_M_MIN
    * missionValue(state, 'suit_speed_factor');
}

function o2Model(state) {
  const lut = state?.summary?.o2_lut;
  if (lut && Array.isArray(lut.grade) && Array.isArray(lut.pct_per_min) && lut.grade.length === lut.pct_per_min.length) {
    const gs = lut.grade; const ps = lut.pct_per_min;
    return {
      exact: true,
      walk(grade) {
        if (grade <= gs[0]) return ps[0];
        for (let i = 1; i < gs.length; i++) {
          if (grade <= gs[i]) return ps[i - 1] + ((grade - gs[i - 1]) / (gs[i] - gs[i - 1])) * (ps[i] - ps[i - 1]);
        }
        return ps[ps.length - 1];
      },
      rest: Number(lut.rest_pct_per_min) || ps[Math.floor(ps.length / 2)],
    };
  }
  // estimate: the planned route's average O2 use per minute outside
  const s = state?.summary;
  const rate = s && s.duration_min > 0 && Number.isFinite(s.o2_used_pct) ? s.o2_used_pct / s.duration_min : null;
  return rate == null ? null : { exact: false, walk: () => rate, rest: rate };
}

// ------------------------------------------------------------------ A*
class Heap {
  constructor(cap) { this.k = new Float64Array(cap); this.v = new Int32Array(cap); this.n = 0; }
  push(key, val) {
    if (this.n >= this.k.length) {
      const k = new Float64Array(this.k.length * 2); k.set(this.k); this.k = k;
      const v = new Int32Array(this.v.length * 2); v.set(this.v); this.v = v;
    }
    let i = this.n++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.k[p] <= key) break;
      this.k[i] = this.k[p]; this.v[i] = this.v[p]; i = p;
    }
    this.k[i] = key; this.v[i] = val;
  }
  pop() {
    const top = this.v[0];
    const key = this.k[--this.n]; const val = this.v[this.n];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= this.n) break;
      if (c + 1 < this.n && this.k[c + 1] < this.k[c]) c++;
      if (this.k[c] >= key) break;
      this.k[i] = this.k[c]; this.v[i] = this.v[c]; i = c;
    }
    this.k[i] = key; this.v[i] = val;
    return top;
  }
}

// weight(k, nb, minutes) -> edge cost (>= minutes, so the time heuristic stays admissible)
function search(g, from, to, state, weight) {
  const { W, H, z, pass } = g;
  const N = W * H;
  const cost = new Float64Array(N).fill(Infinity);
  const came = new Int32Array(N).fill(-1);
  const done = new Uint8Array(N);
  const maxGrade = Math.tan((missionValue(state, 'slope_max_deg') * Math.PI) / 180);
  const vMax = speedMMin(-TOBLER_OFFSET, state);
  const ti = to % W; const tj = Math.floor(to / W);
  const hEst = (k) => Math.hypot(((k % W) - ti) * g.dx, (Math.floor(k / W) - tj) * g.dy) / vMax;
  const steps = NEIGHBOURS.map(([di, dj]) => ({ di, dj, off: dj * W + di, len: Math.hypot(di * g.dx, dj * g.dy) }));
  const limit = LIMIT_HOURS * 60;
  const heap = new Heap(1 << 16);
  cost[from] = 0;
  heap.push(hEst(from), from);
  while (heap.n) {
    const k = heap.pop();
    if (done[k]) continue;
    done[k] = 1;
    if (k === to) break;
    if (cost[k] > limit) break;
    const i = k % W; const j = (k - i) / W;
    for (const s of steps) {
      const ni = i + s.di; const nj = j + s.dj;
      if (ni < 0 || nj < 0 || ni >= W || nj >= H) continue;
      const nb = k + s.off;
      if (!pass[nb] || done[nb]) continue;
      const grade = (z[nb] - z[k]) / s.len;
      if (Math.abs(grade) > maxGrade) continue;
      const minutes = s.len / speedMMin(grade, state);
      const c = cost[k] + weight(k, nb, minutes);
      if (c < cost[nb]) { cost[nb] = c; came[nb] = k; heap.push(c + hEst(nb), nb); }
    }
  }
  if (came[to] < 0 && from !== to) return null;
  const path = [to];
  while (path[path.length - 1] !== from) path.push(came[path[path.length - 1]]);
  return path.reverse();
}

// ------------------------------------------------------------------ summary
function describe(g, cells, state, { dwellAt = -1, dwellMin = 0 } = {}) {
  const o2 = o2Model(state);
  const coords = []; const tMin = []; const slopeDeg = []; const profile = [];
  let d = 0; let t = 0; let o2Used = 0; let commOff = 0; let maxSlope = 0; let steep = 0;
  const warnDeg = missionValue(state, 'slope_warn_deg');
  for (let n = 0; n < cells.length; n++) {
    const k = cells[n];
    if (n > 0) {
      const p = cells[n - 1];
      const di = (k % g.W) - (p % g.W); const dj = Math.floor(k / g.W) - Math.floor(p / g.W);
      const len = Math.hypot(di * g.dx, dj * g.dy);
      const grade = (g.z[k] - g.z[p]) / len;
      const minutes = len / speedMMin(grade, state);
      d += len; t += minutes;
      if (o2) o2Used += minutes * o2.walk(grade);
      if (g.shadow?.[k]) commOff += minutes;
      if (g.slope[k] > warnDeg) steep += len;
    }
    maxSlope = Math.max(maxSlope, g.slope[k]);
    coords.push(cellToLonLat(g, k));
    tMin.push(Math.round(t * 10) / 10);
    slopeDeg.push(Math.round(g.slope[k] * 10) / 10);
    profile.push({ d: Math.round(d), z: Math.round(g.z[k] * 10) / 10, slope: Math.round(g.slope[k] * 10) / 10 });
    if (n === dwellAt && dwellMin > 0) {
      t += dwellMin;
      if (o2) o2Used += dwellMin * o2.rest;
      coords.push(coords[coords.length - 1]);
      tMin.push(Math.round(t * 10) / 10);
      slopeDeg.push(slopeDeg[slopeDeg.length - 1]);
    }
  }
  const dosePerMin = (Number(state?.radiation?.base_mSv_per_day) || missionValue(state, 'rad_base_mSv_per_day')) / (24 * 60);
  const reserve = missionValue(state, 'o2_reserve_pct');
  const evaMin = missionValue(state, 'eva_nominal_hours') * 60;
  const warnings = [];
  if (o2 && 100 - o2Used < reserve) warnings.push(`Oxygen left would be ${Math.round(100 - o2Used)} %, below the ${reserve} % reserve`);
  if (t > evaMin) warnings.push(`Longer than the ${evaMin / 60} h EVA limit`);
  if (steep > 0) warnings.push(`${Math.round(steep)} m on ground steeper than ${warnDeg}°`);
  return {
    feature: {
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: coords },
      properties: { slope_deg: slopeDeg, t_min: tMin },
    },
    summary: {
      distance_m: Math.round(d),
      duration_min: Math.round(t),
      o2_used_pct: o2 ? Math.round(o2Used * 10) / 10 : null,
      o2_exact: !!o2?.exact,
      dose_mSv: Math.round(t * dosePerMin * 1000) / 1000,
      max_slope_deg: Math.round(maxSlope * 10) / 10,
      comm_off_min: Math.round(commOff),
      steep_m: Math.round(steep),
      profile,
    },
    warnings,
    cells,
  };
}

function overlap(a, b) {
  const set = new Set(b);
  let n = 0;
  for (const k of a) if (set.has(k)) n++;
  return n / Math.max(1, a.length);
}

// ------------------------------------------------------------------ public
// -> {options:[{id, label, note, feature, summary, warnings}], error?}
export function planRoutes(g, start, end, state, { roundTrip = true, dwell = false } = {}) {
  const a = snap(g, start); const b = snap(g, end);
  if (a < 0) return { options: [], error: 'The start is on ground that cannot be walked (too steep or no elevation data).' };
  if (b < 0) return { options: [], error: 'The destination is on ground that cannot be walked (too steep or no elevation data).' };
  if (a === b) return { options: [], error: 'Start and destination are the same place.' };
  const warnDeg = missionValue(state, 'slope_warn_deg');
  const dwellMin = dwell ? missionValue(state, 'stop_dwell_min') : 0;

  const fastW = (k, nb, m) => m;
  const safeW = (k, nb, m) => m * (1 + (g.slope[nb] / warnDeg) ** 2) * (g.shadow?.[nb] ? 1 + COMM_PENALTY : 1);

  const run = (w) => {
    const out = search(g, a, b, state, w);
    if (!out) return null;
    if (!roundTrip) return { cells: out, dwellAt: dwell ? out.length - 1 : -1 };
    const back = search(g, b, a, state, w);
    if (!back) return null;
    return { cells: out.concat(back.slice(1)), dwellAt: dwell ? out.length - 1 : -1 };
  };

  const fast = run(fastW);
  if (!fast) return { options: [], error: 'No walkable way between these points: steep slopes (over the limit) cut it off.' };
  const safe = run(safeW);

  const band = new Uint8Array(g.W * g.H);
  for (const k of fast.cells) {
    const i0 = k % g.W; const j0 = Math.floor(k / g.W);
    for (let j = j0 - ALT_BAND_CELLS; j <= j0 + ALT_BAND_CELLS; j++) {
      for (let i = i0 - ALT_BAND_CELLS; i <= i0 + ALT_BAND_CELLS; i++) {
        if (i >= 0 && j >= 0 && i < g.W && j < g.H) band[j * g.W + i] = 1;
      }
    }
  }
  const alt = run((k, nb, m) => m * (band[nb] ? ALT_PENALTY : 1));

  const options = [
    { id: 'fastest', label: 'Fastest', note: 'Shortest time on foot', ...describe(g, fast.cells, state, { dwellAt: fast.dwellAt, dwellMin }) },
  ];
  if (safe) {
    options.push({ id: 'safest', label: 'Safest', note: 'Gentle slopes, keeps the radio link to the habitat',
      ...describe(g, safe.cells, state, { dwellAt: safe.dwellAt, dwellMin }) });
  }
  if (alt && options.every((o) => overlap(alt.cells, o.cells) < ALT_MAX_OVERLAP)) {
    options.push({ id: 'alternative', label: 'Alternative', note: 'A different way, if the others are blocked',
      ...describe(g, alt.cells, state, { dwellAt: alt.dwellAt, dwellMin }) });
  }
  for (const o of options) delete o.cells;
  return { options };
}
