// Pure helpers for the HUD: no DOM access here, so they are easy to test.
// Every function tolerates missing data and returns null instead of throwing.

// Used ONLY when the real file is missing; every value shown from here is tagged "est.".
export const FALLBACK = {
  // Curiosity RAD surface dose equivalent rate at Gale (Hassler et al. 2014); same as
  // rad_base_mSv_per_day in CLAUDE.md. Replaced by radiation.json when it lands.
  rad_base_mSv_per_day: 0.64,
};

const MARS_RADIUS_M = 3396190; // same sphere as the project CRS (CLAUDE.md)

export const parseUtc = (s) => (s ? new Date(s) : null);

export function lmstToMin(hm) {
  if (typeof hm !== 'string' || !hm.includes(':')) return null;
  const [h, m] = hm.split(':').map(Number);
  return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null;
}

export function fmtDuration(min) {
  if (!Number.isFinite(min)) return '—';
  const sign = min < 0 ? '-' : '';
  const a = Math.round(Math.abs(min));
  return `${sign}${Math.floor(a / 60)}h ${String(a % 60).padStart(2, '0')}m`;
}

export function compass(azDeg) {
  if (!Number.isFinite(azDeg)) return '';
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return dirs[Math.round((((azDeg % 360) + 360) % 360) / 45) % 8];
}

function lerp(a, b, f) {
  return a == null || b == null ? null : a + (b - a) * f;
}

function lerpAngle(a, b, f) {
  if (a == null || b == null) return null;
  const d = ((b - a + 540) % 360) - 180;
  return (((a + d * f) % 360) + 360) % 360;
}

// sun.json row values at time t (linear interpolation between 10 min samples).
export function sunAt(sun, t) {
  const rows = sun?.rows;
  if (!Array.isArray(rows) || rows.length === 0 || !t) return null;
  const ts = t.getTime();
  let i = rows.findIndex((r) => parseUtc(r.utc).getTime() >= ts);
  if (i === -1) i = rows.length - 1;
  const b = rows[i];
  const a = rows[Math.max(0, i - 1)];
  const ta = parseUtc(a.utc).getTime();
  const tb = parseUtc(b.utc).getTime();
  const f = tb === ta ? 1 : Math.min(1, Math.max(0, (ts - ta) / (tb - ta)));
  const lmstA = lmstToMin(a.lmst);
  let lmstB = lmstToMin(b.lmst);
  if (lmstA != null && lmstB != null && lmstB < lmstA) lmstB += 1440; // midnight wrap
  return {
    lmst_min: lmstA == null || lmstB == null ? null : lerp(lmstA, lmstB, f) % 1440,
    sun_el: lerp(a.sun_el, b.sun_el, f),
    sun_az: lerpAngle(a.sun_az, b.sun_az, f),
    earth_el: lerp(a.earth_el, b.earth_el, f),
    light_time_min: lerp(a.light_time_min, b.light_time_min, f),
  };
}

export function fmtLmst(min) {
  if (!Number.isFinite(min)) return '—';
  const m = Math.floor(((min % 1440) + 1440) % 1440);
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

// EVA window status at time t: before / open / closed.
export function evaStatus(eva, t) {
  const start = parseUtc(eva?.start_utc);
  const end = parseUtc(eva?.end_utc);
  if (!start || !end || !t) return null;
  const ts = t.getTime();
  if (ts < start) return { state: 'before', min: (start - ts) / 60000 };
  if (ts <= end) return { state: 'open', min: (end - ts) / 60000, elapsed: (ts - start) / 60000 };
  return { state: 'closed', min: (ts - end) / 60000 };
}

// Planned dose for the time spent outside. Returns {mSv, estimated, multiplier}.
// activeMin: minutes outside (route duration if known), else the EVA window length.
export function evaDose(radiation, eva, activeMin) {
  const durMin = Number.isFinite(activeMin) ? activeMin : eva?.duration_min;
  if (!Number.isFinite(durMin)) return null;
  const base = radiation?.base_mSv_per_day;
  const mult = Number.isFinite(radiation?.event_multiplier) ? radiation.event_multiplier : 1;
  const estimated = !Number.isFinite(base);
  const rate = estimated ? FALLBACK.rad_base_mSv_per_day : base;
  return { mSv: (rate * mult * durMin) / 1440, estimated, multiplier: mult };
}

// Great-circle distance on the project sphere, coords as [lon, lat].
export function distanceM(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return null;
  const rad = Math.PI / 180;
  const [lon1, lat1] = a.map((v) => v * rad);
  const [lon2, lat2] = b.map((v) => v * rad);
  const h = Math.sin((lat2 - lat1) / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin((lon2 - lon1) / 2) ** 2;
  return 2 * MARS_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

const OPS = {
  '<': (a, b) => a < b,
  '<=': (a, b) => a <= b,
  '>': (a, b) => a > b,
  '>=': (a, b) => a >= b,
  '==': (a, b) => a === b,
  '!=': (a, b) => a !== b,
};

// alerts.json rules + built-in HUD alerts. metrics: {name: number|string|null}
export function evalAlerts(alerts, metrics) {
  const out = [];
  for (const r of alerts?.rules ?? []) {
    const v = metrics[r.metric];
    const op = OPS[r.op];
    if (v == null || !op) continue;
    if (op(v, r.value)) out.push({ id: r.id, level: r.level || 'warn', text: r.text || r.id });
  }
  if (Number.isFinite(metrics.earth_el) && metrics.earth_el < 0) {
    out.push({ id: 'hud-earth-down', level: 'warn', text: 'Earth below horizon: no direct-to-Earth link' });
  }
  if (metrics.eva_state === 'closed' && metrics.at_habitat !== true) {
    out.push({ id: 'hud-eva-closed', level: 'crit', text: 'Outside EVA window: return to habitat' });
  }
  if (metrics.radiation_status && metrics.radiation_status !== 'nominal') {
    out.push({ id: 'hud-radiation', level: 'warn', text: metrics.radiation_message || `Radiation: ${metrics.radiation_status}` });
  }
  const rank = { crit: 0, critical: 0, warn: 1, warning: 1, info: 2 };
  return out.sort((a, b) => (rank[a.level] ?? 3) - (rank[b.level] ?? 3));
}

// ---------------------------------------------------------------------------
// Simulation helpers (route timing, O2 and dose over time)

// route.geojson (Demir): LineString with properties.t_min[] (minutes from EVA start
// at each vertex). Accepts a Feature, a FeatureCollection or a bare geometry.
// If t_min is missing, time is spread by distance over summary.duration_min.
export function routeTimeline(route, summary) {
  const feat = route?.type === 'FeatureCollection' ? route.features?.[0] : route;
  const geom = feat?.type === 'Feature' ? feat.geometry : feat;
  const coords = geom?.type === 'LineString' ? geom.coordinates : null;
  if (!Array.isArray(coords) || coords.length < 2) return null;

  let t = feat?.properties?.t_min;
  if (!Array.isArray(t) || t.length !== coords.length || !t.every(Number.isFinite)) {
    const total = summary?.duration_min;
    if (!Number.isFinite(total)) return null;
    const cum = [0];
    for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + distanceM(coords[i - 1], coords[i]));
    const len = cum[cum.length - 1] || 1;
    t = cum.map((d) => (d / len) * total);
  }
  return { coords, t, total_min: t[t.length - 1] };
}

// Astronaut position on the route at `elapsedMin` after EVA start.
export function routePosition(tl, elapsedMin) {
  if (!tl || !Number.isFinite(elapsedMin)) return null;
  const { coords, t } = tl;
  if (elapsedMin <= t[0]) return coords[0];
  for (let i = 1; i < t.length; i++) {
    if (elapsedMin <= t[i]) {
      const f = t[i] === t[i - 1] ? 1 : (elapsedMin - t[i - 1]) / (t[i] - t[i - 1]);
      return [lerp(coords[i - 1][0], coords[i][0], f), lerp(coords[i - 1][1], coords[i][1], f)];
    }
  }
  return coords[coords.length - 1];
}

// Arrival time of each stop = t_min of the nearest route vertex. Sorted by time.
export function stopSchedule(tl, stops) {
  if (!tl || !Array.isArray(stops)) return [];
  const out = [];
  for (const stop of stops) {
    if (!Array.isArray(stop?.coord)) continue;
    let best = -1;
    let bestD = Infinity;
    tl.coords.forEach((c, i) => {
      const d = distanceM(c, stop.coord);
      if (d < bestD) { bestD = d; best = i; }
    });
    if (best >= 0) out.push({ stop, t_min: tl.t[best] });
  }
  return out.sort((a, b) => a.t_min - b.t_min);
}

export function nextStop(schedule, elapsedMin) {
  if (!schedule.length || !Number.isFinite(elapsedMin)) return null;
  return schedule.find((s) => s.t_min >= elapsedMin) ?? null;
}

// Fraction of the planned outside activity done at `elapsedMin` (0..1).
// Activity length = route duration if known, else the EVA window length.
export function activityFraction(elapsedMin, activeMin) {
  if (!Number.isFinite(elapsedMin) || !Number.isFinite(activeMin) || activeMin <= 0) return null;
  return Math.min(1, Math.max(0, elapsedMin / activeMin));
}

// O2: summary.o2_used_pct spread linearly over the activity (assumption, shown as est.).
export function o2At(summary, frac) {
  const used = summary?.o2_used_pct;
  if (!Number.isFinite(used) || frac == null) return null;
  const usedNow = used * frac;
  return { used_pct: usedNow, remaining_pct: Math.max(0, 100 - usedNow), at_return_pct: Math.max(0, 100 - used) };
}

// Dose accumulated so far (mSv) for a given total EVA dose.
export function doseAt(dose, frac) {
  return dose && frac != null ? dose.mSv * frac : null;
}
