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

// Planned EVA dose. Returns {mSv, estimated}.
export function evaDose(radiation, eva) {
  const durMin = eva?.duration_min;
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
  if (metrics.eva_state === 'closed') {
    out.push({ id: 'hud-eva-closed', level: 'crit', text: 'Outside EVA window: return to habitat' });
  }
  if (metrics.radiation_status && metrics.radiation_status !== 'nominal') {
    out.push({ id: 'hud-radiation', level: 'warn', text: metrics.radiation_message || `Radiation: ${metrics.radiation_status}` });
  }
  const rank = { crit: 0, critical: 0, warn: 1, warning: 1, info: 2 };
  return out.sort((a, b) => (rank[a.level] ?? 3) - (rank[b.level] ?? 3));
}
