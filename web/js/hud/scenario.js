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
  RETURN_PATH_FACTOR: 1.3,     // walk home is ~30 % longer than the straight line (assumption)
  SHADOW_WARN_MIN: 10,         // warn this many route minutes before a radio shadow
};

const OUTSIDE = new Set(['route', 'hold', 'to_refuge', 'sheltered', 'return']);
export const isOutside = (mode) => OUTSIDE.has(mode);
// Heading to or waiting in a storm refuge: the HUD gives the exact refuge, so the generic
// "go to the nearest shelter" storm alert (alerts.json) is not shown then.
export const refugeGuided = (mode) => mode === 'to_refuge' || mode === 'sheltered';

// Move `from` by `meters` on a bearing (degrees from north). Small distances: flat approximation.
export function offset(from, bearing, meters, radiusM = 3396190) {
  const rad = Math.PI / 180;
  const dLat = (meters * Math.cos(bearing * rad)) / radiusM / rad;
  const dLon = (meters * Math.sin(bearing * rad)) / (radiusM * Math.cos(from[1] * rad)) / rad;
  return [from[0] + dLon, from[1] + dLat];
}

/**
 * Storm refuges compared from where the astronaut is now: every terrain shelter plus the habitat,
 * sorted by the storm dose still to come (walk there at the full storm rate, then wait at the
 * shelter's sky-view factor, or the habitat's dose factor, until the storm ends).
 * o2Short: waiting there would take O2 below the reserve (walk there, wait, walk home).
 * Returns [{id, label, coord, svf, factor, habitat, d, walkMin, dose, o2Short}].
 */
export function refugeOptions(q) {
  const { coord, shelters = [], habitat, storm } = q;
  if (!Array.isArray(coord) || !storm) return [];
  const left = Math.max(0, q.left);
  const rate = (q.doseBasePerMin || 0) * storm.mult;
  const o2PerMin = q.o2PerMin || 0;
  const stand = Number.isFinite(q.o2StandPerMin) ? q.o2StandPerMin : o2PerMin;
  const o2 = q.o2 || 0;
  const list = [];
  shelters.forEach((s, i) => {
    if (!Array.isArray(s?.coord)) return;
    list.push({ id: `S${i + 1}`, label: `Shelter S${i + 1}`, coord: s.coord, svf: s.svf,
      factor: Number.isFinite(s.svf) ? s.svf : 1, habitat: false });
  });
  if (Array.isArray(habitat)) {
    list.push({ id: 'habitat', label: 'Habitat', coord: habitat, svf: null, factor: storm.habitatFactor, habitat: true });
  }
  for (const o of list) {
    o.d = distanceM(coord, o.coord);
    o.walkMin = o.d / SCENARIO.WALK_M_PER_MIN;
    const walk = Math.min(o.walkMin, left);
    o.dose = rate * walk + rate * o.factor * (left - walk);
    const home = o.habitat || !Array.isArray(habitat) ? 0 : distanceM(o.coord, habitat) / SCENARIO.WALK_M_PER_MIN;
    const need = o2PerMin * (o.walkMin + home) + (o.habitat ? 0 : stand * Math.max(0, left - o.walkMin));
    o.o2Short = !o.habitat && o2 + need > 100 - SCENARIO.O2_RESERVE_PCT;
  }
  return list.sort((a, b) => a.dose - b.dose);
}

// Recommended refuge: the lowest storm dose among the ones the O2 allows
export const bestRefuge = (opts) => opts.find((o) => !o.o2Short) ?? opts.find((o) => o.habitat) ?? null;

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
 * @param {number} p.o2PerMin      O2 % used per minute walking the route (route average)
 * @param {number} p.o2StandPerMin O2 % used per minute standing still (sheltered, holding)
 * @param {number} p.doseBasePerMin  mSv per minute outside, quiet Sun
 * @param {object|null} p.storm    {t0, duration, mult, habitatFactor}
 * @param {object|null} p.dust     {t0}
 * @param {object|null} p.refugeChoice  {id, t}: from minute t, go to this refuge instead of the
 *                                 recommended one (ids from refugeOptions: 'S1'.., 'habitat')
 */
export function simulate(p) {
  const { tl, habitat, startMin, endMin, o2PerMin, doseBasePerMin, storm, dust } = p;
  const o2StandPerMin = Number.isFinite(p.o2StandPerMin) ? p.o2StandPerMin : o2PerMin;
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
  const choice = p.refugeChoice && p.refugeChoice.id ? p.refugeChoice : null;
  let choiceDone = false;
  const optionsAt = (t) => refugeOptions({
    coord, shelters, habitat, storm, o2, left: storm.t0 + storm.duration - t,
    o2PerMin, o2StandPerMin, doseBasePerMin,
  });
  // A short-of-O2 shelter is replaced by the habitat (Utku's rule)
  const pick = (opts, o) => {
    if (!o) return null;
    if (!o.o2Short) return o;
    const hab = opts.find((x) => x.habitat);
    return hab ? { ...hab, o2Short: true } : o;
  };

  for (let t = startMin; t <= endMin + 1e-9; t += dt) {
    const stormOn = Boolean(storm) && t >= storm.t0 && t < storm.t0 + storm.duration;

    // EVA starts at T+0, unless a storm is on: then it waits in the habitat
    if (mode === 'pre' && t > 0 && !stormOn) mode = 'route';

    // Storm hits while outside: go to the recommended refuge (lowest storm dose the O2 allows),
    // or to the one the crew picked
    if (storm && !stormHandled && t >= storm.t0 && isOutside(mode)) {
      stormHandled = true;
      const opts = optionsAt(t);
      const chosen = choice && choice.t <= t ? opts.find((o) => o.id === choice.id) : null;
      if (chosen) choiceDone = true;
      refuge = pick(opts, chosen ?? bestRefuge(opts));
      if (refuge) {
        resume = { coord, tau };
        mode = 'to_refuge';
      }
    }
    // The crew switched refuge during the storm: head there from here
    if (choice && !choiceDone && stormHandled && t >= choice.t && (mode === 'to_refuge' || mode === 'sheltered')) {
      choiceDone = true;
      if (refuge?.id !== choice.id) {
        const opts = optionsAt(t);
        const next = pick(opts, opts.find((o) => o.id === choice.id));
        if (next) { refuge = next; mode = 'to_refuge'; }
      }
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
      // Standing still (in a shelter, waiting for a dust devil) costs less than walking
      o2 += (mode === 'sheltered' || mode === 'hold' ? o2StandPerMin : o2PerMin) * dt;
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
    storm, dust, events, steps,
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

// ---------------------------------------------------------------------------
// Mission log: the key events of the simulated walk, [{t, level, text}] sorted by time.
// Built once per plan; the HUD shows the entries up to the current simulation time.
export function missionLog(plan, schedule = [], shadows = []) {
  const steps = plan?.steps;
  if (!Array.isArray(steps) || !steps.length) return [];
  const log = [];
  const add = (t, level, text) => log.push({ t, level, text });
  const arrived = new Set();
  const left = new Set();
  const inShadow = new Set();
  let dustSeen = false;
  let stormSeen = false;
  let prev = steps[0];

  for (const s of steps.slice(1)) {
    if (plan.storm && !stormSeen && s.t >= plan.storm.t0) {
      stormSeen = true;
      add(s.t, 'danger', 'Solar storm alert (replay of 20 May 2024)');
    }
    if (prev.mode === 'pre' && s.mode === 'route') add(s.t, 'info', 'EVA start: left the habitat');
    if (s.mode === 'to_refuge' && s.refuge && (prev.mode !== 'to_refuge' || prev.refuge !== s.refuge)) {
      add(s.t, 'danger', s.refuge.habitat
        ? `Heading back to the habitat${s.refuge.o2Short ? ' (O2 too low to wait out the storm)' : ''}`
        : `Heading to shelter${s.refuge.id ? ` ${s.refuge.id}` : ''}, ${Math.round(s.refuge.d)} m away`);
    }
    if (s.mode === 'sheltered' && prev.mode !== 'sheltered') {
      add(s.t, 'warn', `In shelter${s.refuge?.id ? ` ${s.refuge.id}` : ''} (sky-view ${Number.isFinite(s.refuge?.svf) ? s.refuge.svf.toFixed(2) : '—'})`);
    }
    if (s.mode === 'return' && prev.mode !== 'return') add(s.t, 'info', 'Storm over: walking back to the route');
    if (prev.mode === 'return' && s.mode === 'route') add(s.t, 'info', 'Back on the route');
    if (s.devil && !dustSeen && s.devilDist < SCENARIO.DUST_APPROACH_M) {
      dustSeen = true;
      add(s.t, 'warn', 'Dust devil sighted');
    }
    if (s.mode === 'hold' && prev.mode !== 'hold') add(s.t, 'danger', 'Holding position: dust devil crossing');
    if (prev.mode === 'hold' && s.mode === 'route') add(s.t, 'info', 'Dust devil passed: walk resumed');

    if (s.mode === 'route' || s.mode === 'hold') {
      for (const e of schedule) {
        const id = e.stop.id ?? e.stop.name;
        if (!arrived.has(id) && s.tau >= e.t_min) {
          arrived.add(id);
          add(s.t, 'info', `Arrived at ${e.stop.name || id}`);
        }
        if (arrived.has(id) && !left.has(id) && s.tau > (e.t_leave ?? e.t_min)) {
          left.add(id);
          add(s.t, 'info', `Left ${e.stop.name || id}`);
        }
      }
      // One line per radio shadow (shorter than a minute: not worth a log line)
      shadows.forEach((x, i) => {
        if (!inShadow.has(i) && x.b - x.a >= 1 && s.tau >= x.a && s.tau < x.b) {
          inShadow.add(i);
          add(s.t, 'warn', `Radio shadow for ${Math.round(x.b - x.a)} min: no link to the habitat`);
        }
      });
    }
    if (s.mode === 'home' && prev.mode !== 'home') add(s.t, 'warn', 'Back in the habitat: EVA ended early');
    if (s.mode === 'done' && prev.mode !== 'done') add(s.t, 'info', 'EVA complete: back in the habitat');
    prev = s;
  }
  return log;
}
