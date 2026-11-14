// Demo scenarios for the HUD simulation: solar storm (go to the nearest shelter and wait)
// and a dust devil crossing the route (hold position until it passes).
//
// simulate() steps through the EVA in small time steps and records, for every step, where the
// astronaut is, what they are doing (mode), how far along the planned route they are (tau, in
// route minutes) and the cumulative O2 and dose. With no scenario switched on, the astronaut
// simply follows the planned route, exactly as before.
//
// Modes: pre (in the habitat before the EVA), route (walking the plan), hold (waiting for a dust
// devil to pass), to_refuge (walking to a shelter or the habitat), sheltered, return (back to
// the point where the route was left), home (back inside because of the storm), done.

import { bearingDeg, distanceM, routeState } from './model.js';

// Scenario constants. Storm duration and shelter dose factors come from radiation.json (Utku);
// the rest are demo assumptions, shown as such in the UI.
export const SCENARIO = {
  STEP_MIN: 0.25,
  WALK_M_PER_MIN: 50,          // ~3 km/h suited walking on flat ground (docs/story/assumptions.md)
  STORM_URL_START_MIN: 40,     // ?radiation=replay: the storm hits 40 min into the walk
  DUST_URL_START_MIN: 20,      // ?hazard=dustdevil: the dust devil appears 20 min into the walk
  DUST_SPEED_M_PER_MIN: 180,   // 3 m/s, a light Martian afternoon wind (assumption)
  DUST_RADIUS_M: 40,           // visual radius of the vortex (assumption)
  DUST_START_M: 500,           // where it appears, upwind of the route
  DUST_TRACK_M: 1000,          // it dissipates after this distance
  DUST_FROM_DEG: 45,           // comes from the NE, moves to the SW
  DUST_APPROACH_M: 400,        // warning distance
  DUST_HOLD_M: 120,            // hold position inside this distance while it approaches
  DUST_CLEAR_M: 160,           // resume once it is this far and moving away
  O2_RESERVE_PCT: 25,          // o2_reserve_pct in config/mission.json: never plan to dip below it
};

const OUTSIDE = new Set(['route', 'hold', 'to_refuge', 'sheltered', 'return']);
export const isOutside = (mode) => OUTSIDE.has(mode);

// Move `from` by `meters` on a bearing (degrees from north). Small distances: flat approximation.
export function offset(from, bearing, meters, radiusM = 3396190) {
  const rad = Math.PI / 180;
  const dLat = (meters * Math.cos(bearing * rad)) / radiusM / rad;
  const dLon = (meters * Math.sin(bearing * rad)) / (radiusM * Math.cos(from[1] * rad)) / rad;
  return [from[0] + dLon, from[1] + dLat];
}

function toward(a, b, meters) {
  const d = distanceM(a, b);
  if (d <= meters || d === 0) return { coord: b, arrived: true };
  const f = meters / d;
  return { coord: [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f], arrived: false };
}

/**
 * @param {object} p
 * @param {object} p.tl            routeTimeline(...)
 * @param {Array}  p.shelters      safety.json shelters [{coord, svf}]
 * @param {Array}  p.habitat       [lon, lat]
 * @param {number} p.startMin      first simulated minute (relative to EVA start, may be < 0)
 * @param {number} p.endMin        last simulated minute
 * @param {number} p.o2PerMin      O2 % used per minute outside
 * @param {number} p.doseBasePerMin  mSv per minute outside, quiet Sun
 * @param {object|null} p.storm    {t0, duration, mult, habitatFactor}
 * @param {object|null} p.dust     {t0}
 */
export function simulate(p) {
  const { tl, habitat, startMin, endMin, o2PerMin, doseBasePerMin, storm, dust } = p;
  const dt = SCENARIO.STEP_MIN;
  const shelters = (p.shelters || []).filter((s) => Array.isArray(s?.coord));
  const total = tl.total_min;
  const steps = [];

  let mode = 'pre';
  let tau = 0;
  let coord = habitat ?? tl.coords[0];
  let refuge = null;
  let resume = null;
  let stormHandled = false;
  let o2 = 0;
  let dose = 0;
  let devil = null;          // {start, bearing, t0}
  let prevDevilDist = null;
  let clearedAt = null;

  for (let t = startMin; t <= endMin + 1e-9; t += dt) {
    const stormOn = Boolean(storm) && t >= storm.t0 && t < storm.t0 + storm.duration;

    // EVA starts at T+0, unless a storm is on: then it waits in the habitat
    if (mode === 'pre' && t > 0 && !stormOn) mode = 'route';

    // Storm hits while outside: pick the closest refuge (terrain shelter or habitat)
    if (storm && !stormHandled && t >= storm.t0 && isOutside(mode)) {
      stormHandled = true;
      const options = shelters.map((s) => ({ coord: s.coord, factor: Number.isFinite(s.svf) ? s.svf : 1, svf: s.svf, habitat: false }));
      if (habitat) options.push({ coord: habitat, factor: storm.habitatFactor, habitat: true });
      refuge = options.reduce((best, o) => {
        const d = distanceM(coord, o.coord);
        return !best || d < best.d ? { ...o, d } : best;
      }, null);
      // Waiting out the storm at a terrain shelter must fit in the O2 above the reserve
      // (walk there, wait, walk back home); otherwise go back to the habitat (Utku's rule).
      if (refuge && !refuge.habitat && habitat) {
        const left = storm.t0 + storm.duration - t;
        const home = distanceM(refuge.coord, habitat);
        const need = o2PerMin * ((refuge.d + home) / SCENARIO.WALK_M_PER_MIN + left);
        if (o2 + need > 100 - SCENARIO.O2_RESERVE_PCT) {
          refuge = { coord: habitat, factor: storm.habitatFactor, habitat: true, d: distanceM(coord, habitat), o2Short: true };
        }
      }
      resume = { coord, tau };
      mode = 'to_refuge';
    }

    // Dust devil appears upwind of where the astronaut will be in a few minutes (or of where
    // they are, if they are off the route: walking to / sitting in a shelter)
    if (dust && !devil && t >= dust.t0 && isOutside(mode)) {
      const meetMin = SCENARIO.DUST_START_M / SCENARIO.DUST_SPEED_M_PER_MIN;
      const q = mode === 'route' ? routeState(tl, Math.min(total, tau + meetMin)).coord : coord;
      devil = { t0: t, start: offset(q, SCENARIO.DUST_FROM_DEG, SCENARIO.DUST_START_M), bearing: (SCENARIO.DUST_FROM_DEG + 180) % 360 };
    }
    let devilNow = null;
    if (devil) {
      const travelled = (t - devil.t0) * SCENARIO.DUST_SPEED_M_PER_MIN;
      if (travelled <= SCENARIO.DUST_TRACK_M) devilNow = offset(devil.start, devil.bearing, travelled);
    }
    const devilDist = devilNow ? distanceM(coord, devilNow) : null;
    const approaching = devilDist != null && prevDevilDist != null && devilDist < prevDevilDist;

    switch (mode) {
      case 'route':
        if (devilDist != null && devilDist < SCENARIO.DUST_HOLD_M && approaching) {
          mode = 'hold';
        } else {
          tau = Math.min(total, tau + dt);
          if (tau >= total) mode = 'done';
        }
        break;
      case 'hold':
        if (devilDist == null || (devilDist > SCENARIO.DUST_CLEAR_M && !approaching)) {
          mode = 'route';
          clearedAt = t;
        }
        break;
      case 'to_refuge': {
        const m = toward(coord, refuge.coord, SCENARIO.WALK_M_PER_MIN * dt);
        coord = m.coord;
        if (m.arrived) mode = refuge.habitat ? 'home' : 'sheltered';
        break;
      }
      case 'sheltered':
        if (!stormOn) mode = 'return';
        break;
      case 'return': {
        const m = toward(coord, resume.coord, SCENARIO.WALK_M_PER_MIN * dt);
        coord = m.coord;
        if (m.arrived) { mode = 'route'; tau = resume.tau; }
        break;
      }
      default:
        break;
    }
    if (mode === 'route' || mode === 'hold' || mode === 'done') coord = routeState(tl, tau).coord;
    if (mode === 'pre' || mode === 'home') coord = mode === 'home' ? refuge.coord : (habitat ?? tl.coords[0]);

    if (isOutside(mode)) {
      o2 += o2PerMin * dt;
      const factor = mode === 'sheltered' ? refuge.factor : 1;
      dose += doseBasePerMin * (stormOn ? storm.mult : 1) * factor * dt;
    }
    prevDevilDist = devilDist;

    steps.push({
      t, mode, tau, coord, stormOn,
      refuge: refuge && (mode === 'to_refuge' || mode === 'sheltered' || mode === 'home') ? refuge : null,
      resume: mode === 'return' ? resume : null,
      o2, dose,
      devil: devilNow, devilDist, approaching,
      justCleared: clearedAt != null && t - clearedAt <= 2,
      delay: mode === 'pre' || t <= 0 ? Math.max(0, t) : Math.max(0, t - tau),
    });
  }

  // Intervals for the event strip on the time slider: [{kind, a, b}] in minutes
  const events = [];
  if (storm) events.push({ kind: 'storm', a: storm.t0, b: storm.t0 + storm.duration });
  let runKind = null;
  let runStart = null;
  for (const s of steps) {
    const kind = s.mode === 'hold' ? 'hold' : s.mode === 'sheltered' ? 'sheltered' : null;
    if (kind !== runKind) {
      if (runKind) events.push({ kind: runKind, a: runStart, b: s.t });
      runKind = kind;
      runStart = s.t;
    }
  }
  if (runKind) events.push({ kind: runKind, a: runStart, b: steps[steps.length - 1].t });
  if (dust && devil) events.push({ kind: 'dust', a: devil.t0, b: devil.t0 + SCENARIO.DUST_TRACK_M / SCENARIO.DUST_SPEED_M_PER_MIN });

  return {
    storm, dust, events,
    startMin, endMin,
    // O2 used by the time the astronaut is back inside (the whole simulated walk)
    finalO2: steps.length ? steps[steps.length - 1].o2 : 0,
    at(e) {
      if (!Number.isFinite(e) || !steps.length) return null;
      const i = Math.round((e - startMin) / dt);
      return steps[Math.min(steps.length - 1, Math.max(0, i))];
    },
    // Dose if the walk had simply continued through the storm (for the comparison row)
    noShelterDose(e) {
      if (!Number.isFinite(e)) return null;
      const outEnd = Math.min(Math.max(e, 0), total);
      let d = doseBasePerMin * outEnd;
      if (storm) {
        const a = Math.max(storm.t0, 0);
        const b = Math.min(storm.t0 + storm.duration, outEnd);
        if (b > a) d += doseBasePerMin * (storm.mult - 1) * (b - a);
      }
      return d;
    },
  };
}

export { bearingDeg };
