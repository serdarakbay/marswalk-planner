// Pure helpers for the HUD: no DOM access here, so they are easy to test.
// Every function tolerates missing data and returns null instead of throwing.

// Used ONLY when the real file is missing; every value shown from here is tagged "est.".
export const FALLBACK = {
  // Curiosity RAD surface dose equivalent rate at Gale (Hassler et al. 2014); same as
  // rad_base_mSv_per_day in CLAUDE.md. Replaced by radiation.json when it lands.
  rad_base_mSv_per_day: 0.64,
  // Same as rad_event_window_h in config/mission.json; used until radiation.json carries
  // its own event_window_h.
  rad_event_window_h: 48,
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

// Planned dose for the time spent outside. Returns {mSv, estimated, multiplier, source}.
// activeMin: minutes outside (route duration if known), else the EVA window length.
// Source order: radiation.json rate x time > summary.json dose_mSv > FALLBACK rate (est.).
export function evaDose(radiation, eva, activeMin, summary) {
  const durMin = Number.isFinite(activeMin) ? activeMin : eva?.duration_min;
  const base = radiation?.base_mSv_per_day;
  const mult = Number.isFinite(radiation?.event_multiplier) ? radiation.event_multiplier : 1;
  if (Number.isFinite(base) && Number.isFinite(durMin)) {
    return { mSv: (base * mult * durMin) / 1440, estimated: false, multiplier: mult, source: 'radiation.json' };
  }
  if (Number.isFinite(summary?.dose_mSv)) {
    return { mSv: summary.dose_mSv, estimated: false, multiplier: 1, source: 'summary.json' };
  }
  if (!Number.isFinite(durMin)) return null;
  return { mSv: (FALLBACK.rad_base_mSv_per_day * durMin) / 1440, estimated: true, multiplier: 1, source: 'fallback' };
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
    out.push({ id: 'hud-eva-closed', level: 'danger', text: 'Outside EVA window: return to habitat' });
  }
  if (metrics.radiation_status && metrics.radiation_status !== 'nominal') {
    out.push({
      id: 'hud-radiation',
      level: metrics.radiation_status === 'storm' ? 'danger' : 'warn',
      text: metrics.radiation_message || `Radiation: ${metrics.radiation_status}`,
    });
  }
  const rank = { danger: 0, crit: 0, critical: 0, warn: 1, warning: 1, info: 2 };
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

  const cum = [0];
  for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + distanceM(coords[i - 1], coords[i]));
  let t = feat?.properties?.t_min;
  if (!Array.isArray(t) || t.length !== coords.length || !t.every(Number.isFinite)) {
    const total = summary?.duration_min;
    if (!Number.isFinite(total)) return null;
    const len = cum[cum.length - 1] || 1;
    t = cum.map((d) => (d / len) * total);
  }
  let slope = feat?.properties?.slope_deg;
  if (!Array.isArray(slope) || slope.length !== coords.length) slope = null;
  return { coords, t, d: cum, slope, total_min: t[t.length - 1] };
}

// Position, distance along route (m) and slope at `elapsedMin`.
export function routeState(tl, elapsedMin) {
  if (!tl || !Number.isFinite(elapsedMin)) return null;
  const { coords, t, d, slope } = tl;
  const n = t.length;
  let i = 1;
  while (i < n - 1 && elapsedMin > t[i]) i++;
  const f = elapsedMin <= t[0] ? 0
    : elapsedMin >= t[n - 1] ? 1
      : t[i] === t[i - 1] ? 1 : (elapsedMin - t[i - 1]) / (t[i] - t[i - 1]);
  return {
    coord: [lerp(coords[i - 1][0], coords[i][0], f), lerp(coords[i - 1][1], coords[i][1], f)],
    d_m: lerp(d[i - 1], d[i], f),
    slope_deg: slope ? Math.max(slope[i - 1], slope[i]) : null,
  };
}

// safety.json route[] entry in effect at distance d_m (last entry with d <= d_m).
export function safetyAt(safety, dM) {
  const rows = safety?.route;
  if (!Array.isArray(rows) || !rows.length || !Number.isFinite(dM)) return null;
  let cur = null;
  for (const r of rows) {
    if (Number.isFinite(r?.d) && r.d <= dM) cur = r;
  }
  return cur ?? rows[0];
}


// A route vertex this close to a stop counts as "at the stop" (covers dwell vertices).
const AT_STOP_M = 25;
// A stop farther than this from every route vertex is not on the route and is not scheduled.
const OFF_ROUTE_M = 100;

// Arrival (t_min) and departure (t_leave) of each stop on the route, sorted by arrival.
// The route stays at a stop for the dwell time. It may also pass close to a stop on the
// way somewhere else, so of all the visits (runs of vertices near the stop) the longest
// one in time is the real stop; arrival / departure are its first / last vertex.
export function stopSchedule(tl, stops) {
  if (!tl || !Array.isArray(stops)) return [];
  const out = [];
  for (const stop of stops) {
    if (!Array.isArray(stop?.coord)) continue;
    const dist = tl.coords.map((c) => distanceM(c, stop.coord));
    const dMin = Math.min(...dist);
    if (!(dMin <= OFF_ROUTE_M)) {
      console.warn(`[hud] stop ${stop.id ?? stop.name} is ${Math.round(dMin)} m from the route; not scheduled`);
      continue;
    }
    const near = Math.max(AT_STOP_M, dMin + 1);
    let best = null;
    for (let i = 0; i < dist.length; i++) {
      if (dist[i] > near) continue;
      let j = i;
      while (j + 1 < dist.length && dist[j + 1] <= near) j++;
      const span = tl.t[j] - tl.t[i];
      if (!best || span > best.span) best = { first: i, last: j, span };
      i = j;
    }
    out.push({ stop, t_min: tl.t[best.first], t_leave: tl.t[best.last] });
  }
  return out.sort((a, b) => a.t_min - b.t_min);
}

// The stop being visited now, or the next one ahead.
export function nextStop(schedule, elapsedMin) {
  if (!schedule.length || !Number.isFinite(elapsedMin)) return null;
  return schedule.find((s) => (s.t_leave ?? s.t_min) >= elapsedMin) ?? null;
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

// ---------------------------------------------------------------------------
// Solar storm replay (radiation.json "replay" block, Utku)

// Live status at simulation time t. radiation.json is written for the moment the script
// ran: "elevated" when a CME reached Mars within +/- window hours of then. Re-apply the same
// rule at time t using mars_arrivals_in_window, so the alert ends when the window ends.
export function radiationAt(radiation, t) {
  const arrivals = radiation?.mars_arrivals_in_window;
  if (!radiation || radiation.status !== 'elevated' || !Array.isArray(arrivals) || !arrivals.length || !t) {
    return radiation ?? null;
  }
  const windowH = Number.isFinite(radiation.event_window_h)
    ? radiation.event_window_h : FALLBACK.rad_event_window_h;
  const active = arrivals.some((a) => {
    const at = parseUtc(a?.utc);
    return at && Math.abs(t - at) <= windowH * 3600000;
  });
  return active ? radiation : { ...radiation, status: 'nominal', message: 'Background GCR only.' };
}

// radiation.json with the replay scenario applied on top when `storm` is on.
// The top-level fields stay the live values; replay only overrides status,
// event_multiplier and message. Absorbed dose (mGy) is never mixed into mSv.
export function effectiveRadiation(radiation, storm) {
  const r = radiation?.replay;
  if (!storm || !r) return radiation ?? null;
  return {
    ...radiation,
    status: r.status ?? 'storm',
    event_multiplier: Number.isFinite(r.event_multiplier) ? r.event_multiplier : radiation.event_multiplier,
    message: r.message ?? radiation.message,
    replay_date: r.date ?? null,
  };
}

// Initial bearing from a to b, degrees clockwise from north ([lon, lat] in degrees).
export function bearingDeg(a, b) {
  const rad = Math.PI / 180;
  const [lon1, lat1] = [a[0] * rad, a[1] * rad];
  const [lon2, lat2] = [b[0] * rad, b[1] * rad];
  const y = Math.sin(lon2 - lon1) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(lon2 - lon1);
  return ((Math.atan2(y, x) / rad) + 360) % 360;
}

// Closest shelter (safety.json shelters[{coord, svf}]) to `from`: {coord, svf, d_m, bearing_deg}.
export function nearestShelter(shelters, from) {
  if (!Array.isArray(shelters) || !Array.isArray(from)) return null;
  let best = null;
  for (const s of shelters) {
    if (!Array.isArray(s?.coord)) continue;
    const d = distanceM(from, s.coord);
    if (!best || d < best.d_m) best = { coord: s.coord, svf: s.svf ?? null, d_m: d };
  }
  if (best) best.bearing_deg = bearingDeg(from, best.coord);
  return best;
}
