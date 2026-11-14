// Demo scenarios for the HUD simulation: solar storm (go to the refuge with the lowest storm
// dose and wait) and a dust devil (hold position until it passes, or step aside off its track
// when it is heading straight at the astronaut).
//
// simulate() steps through the EVA in small time steps and records, for every step, where the
// astronaut is, what they are doing (mode), how far along the planned route they are (tau, in
// route minutes) and the cumulative O2 and dose. With no scenario switched on, the astronaut
// simply follows the planned route, exactly as before.
//
// Modes: pre (in the habitat before the EVA), route (walking the plan), hold (waiting for a dust
// devil to pass), evade (stepping aside off a dust devil's track), aside (waiting there), rejoin
// (walking back to the route), to_target (detour to a science target the crew picked),
// sampling (working there), from_target (back to the route, or home if the rest of the route
// no longer fits), to_refuge (walking to a shelter or the habitat), sheltered, return (back to
// the point where the route was left), home (back inside before the end of the route), done.

import { bearingDeg, distanceM, routeState } from './model.js';
import { legPoint, makeLeg } from './terrain.js';

// Scenario constants. Storm duration and shelter dose factors come from radiation.json (Utku);
// the rest are demo assumptions, shown as such in the UI.
export const SCENARIO = {
  STEP_MIN: 0.25,
  WALK_M_PER_MIN: 50,          // ~3 km/h suited walking on flat ground (docs/story/assumptions.md)
  STORM_URL_START_MIN: 40,     // ?radiation=replay: the storm hits 40 min into the walk
  DUST_URL_START_MIN: 20,      // ?hazard=dustdevil: the dust devil appears 20 min into the walk
  DUST_SPEED_M_PER_MIN: 180,   // 3 m/s, a light Martian afternoon wind (assumption)
  DUST_RADIUS_M: 40,           // visual radius of the vortex (assumption)
  DUST_START_M: 500,           // where the second one appears, upwind of the astronaut
  DUST_TRACK_M: 1000,          // a dust devil dissipates after this distance past its start
  DUST_SECOND_MIN: 12,         // the second dust devil comes this many minutes after the first
  DUST_CROSS_MISS_M: 200,      // the first one crosses the route ahead, at least this far from the astronaut
  DUST_FROM_DEG: 45,           // comes from the NE, moves to the SW
  DUST_APPROACH_M: 400,        // warning distance
  DUST_HOLD_M: 120,            // hold position inside this distance while it approaches
  DUST_CLEAR_M: 160,           // resume once it is this far and moving away
  DUST_EVADE_M: 150,           // its track passes closer than DUST_HOLD_M: step aside to this far from it
  DUST_EVADE_MAX_M: 400,       // longest step-aside walk worth taking (else hold position)
  O2_RESERVE_PCT: 25,          // o2_reserve_pct in config/mission.json: never plan to dip below it
  RETURN_PATH_FACTOR: 1.3,     // walk home is ~30 % longer than the straight line (assumption)
  SHADOW_WARN_MIN: 10,         // warn this many route minutes before a radio shadow
  DETOUR_WORK_MIN: 15,         // time spent sampling at a science target (assumption)
};

const OUTSIDE = new Set(['route', 'hold', 'evade', 'aside', 'rejoin', 'to_target', 'sampling', 'from_target',
  'to_refuge', 'sheltered', 'return']);
const DUST_MODES = new Set(['hold', 'evade', 'aside', 'rejoin']);
export const DETOUR_MODES = new Set(['to_target', 'sampling', 'from_target']);
// Modes in which the astronaut walks a path (leg) rather than the planned route
const LEG_MODES = new Set(['to_refuge', 'return', 'evade', 'rejoin', 'to_target', 'from_target']);
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

// Where a dust devil moving on `bearing` passes a point: `along` metres ahead of it (negative:
// already past), `miss` metres to the side; `side` is the bearing from the track to the point.
export function devilPass(point, devil, bearing) {
  const rad = Math.PI / 180;
  const R = 3396190;
  const x = (point[0] - devil[0]) * rad * R * Math.cos(devil[1] * rad);
  const y = (point[1] - devil[1]) * rad * R;
  const ux = Math.sin(bearing * rad);
  const uy = Math.cos(bearing * rad);
  const cross = ux * y - uy * x;   // > 0: point on the left of the track
  return { along: x * ux + y * uy, miss: Math.abs(cross), side: (bearing + (cross >= 0 ? -90 : 90) + 360) % 360 };
}

/**
 * "Can I go there?" for a science target off the route: walk there (around steep ground with
 * q.router), work DETOUR_WORK_MIN, then walk back to the habitat. Allowed only if the O2 left
 * at the habitat stays at or above the reserve and the habitat is reached before the EVA window
 * closes (q.minutesLeft). Router target ids are `T:<id>`.
 * Returns {path, d, walkMin, backMin, totalMin, o2AtReturn, ok, reason: null | 'o2' | 'window'}.
 */
export function detourCheck(q) {
  const { coord, target, habitat } = q;
  if (!Array.isArray(coord) || !Array.isArray(target?.coord)) return null;
  const to = q.router?.pathTo(coord, `T:${target.id}`);
  const path = to ? to.coords : [coord, target.coord];
  const d = to ? to.length_m : distanceM(coord, target.coord);
  const home = !Array.isArray(habitat) ? null : q.router?.pathTo(target.coord, 'habitat');
  const backM = home ? home.length_m : Array.isArray(habitat) ? distanceM(target.coord, habitat) : 0;
  const walkMin = d / SCENARIO.WALK_M_PER_MIN;
  const backMin = backM / SCENARIO.WALK_M_PER_MIN;
  const work = Number.isFinite(q.workMin) ? q.workMin : SCENARIO.DETOUR_WORK_MIN;
  const walkRate = q.o2PerMin || 0;
  const standRate = Number.isFinite(q.o2StandPerMin) ? q.o2StandPerMin : walkRate;
  const o2AtReturn = 100 - ((q.o2 || 0) + walkRate * (walkMin + backMin) + standRate * work);
  const totalMin = walkMin + work + backMin;
  let reason = null;
  if (o2AtReturn < SCENARIO.O2_RESERVE_PCT) reason = 'o2';
  else if (Number.isFinite(q.minutesLeft) && totalMin > q.minutesLeft) reason = 'window';
  return { path, d, walkMin, backMin, totalMin, o2AtReturn, ok: reason == null, reason };
}

/**
 * Storm refuges compared from where the astronaut is now: every terrain shelter plus the habitat,
 * sorted by the storm dose still to come (walk there at the full storm rate, then wait at the
 * shelter's sky-view factor, or the habitat's dose factor, until the storm ends).
 * o2Short: waiting there would take O2 below the reserve (walk there, wait, walk home).
 * With q.router (terrain.js) distances follow the walkable path around steep ground; without
 * it, or where no path exists, they are straight lines.
 * Returns [{id, label, coord, svf, factor, habitat, d, walkMin, dose, o2Short, path}].
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
  const walkTo = (from, o) => {
    const r = q.router?.pathTo(from, o.id);
    return r ? { path: r.coords, d: r.length_m } : { path: [from, o.coord], d: distanceM(from, o.coord) };
  };
  const hab = list.find((o) => o.habitat);
  for (const o of list) {
    const w = walkTo(coord, o);
    o.path = w.path;
    o.d = w.d;
    o.walkMin = o.d / SCENARIO.WALK_M_PER_MIN;
    const walk = Math.min(o.walkMin, left);
    o.dose = rate * walk + rate * o.factor * (left - walk);
    const home = o.habitat || !hab ? 0 : walkTo(o.coord, hab).d / SCENARIO.WALK_M_PER_MIN;
    const need = o2PerMin * (o.walkMin + home) + (o.habitat ? 0 : stand * Math.max(0, left - o.walkMin));
    o.o2Short = !o.habitat && o2 + need > 100 - SCENARIO.O2_RESERVE_PCT;
  }
  return list.sort((a, b) => a.dose - b.dose);
}

// Recommended refuge: the lowest storm dose among the ones the O2 allows
export const bestRefuge = (opts) => opts.find((o) => !o.o2Short) ?? opts.find((o) => o.habitat) ?? null;

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
 * @param {object|null} p.dust     {t0}: two dust devils (afternoon dust devils come in series):
 *                                 the first crosses the route ahead (hold position), the second
 *                                 heads straight at the astronaut DUST_SECOND_MIN later (step aside)
 * @param {Array}  p.detours       [{target: {id, name, coord}, t}]: from minute t, walk to this
 *                                 science target, sample it, then back to the route (or home);
 *                                 one after the other, each once the astronaut is on the route
 * @param {number}      p.evaEndMin  minute the EVA window closes (relative to EVA start)
 * @param {object|null} p.router   terrain.js createRouter(): walkable paths to the refuges (optional)
 * @param {object|null} p.refugeChoice  {id, t}: from minute t, go to this refuge instead of the
 *                                 recommended one (ids from refugeOptions: 'S1'.., 'habitat')
 */
export function simulate(p) {
  const { tl, habitat, startMin, endMin, o2PerMin, doseBasePerMin, storm, dust } = p;
  const o2StandPerMin = Number.isFinite(p.o2StandPerMin) ? p.o2StandPerMin : o2PerMin;
  const dt = SCENARIO.STEP_MIN;
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
  const devils = [];         // [{id, t0, start, bearing, trackM, prevDist, evadeTried}]
  let clearedAt = null;
  const choice = p.refugeChoice && p.refugeChoice.id ? p.refugeChoice : null;
  let choiceDone = false;
  let leg = null;   // the path being walked (to the refuge, aside, or back to the route)
  let evade = null;  // stepping aside from a dust devil: {from: {coord, tau}, leg}
  let detour = null; // science detour: {from: {coord, tau}, target, workLeft, home}
  const detours = [...(p.detours || [])].filter((x) => x?.target).sort((a, b) => a.t - b.t);
  let detourIdx = 0;
  const optionsAt = (t) => refugeOptions({
    coord, shelters: p.shelters || [], habitat, storm, o2, left: storm.t0 + storm.duration - t,
    o2PerMin, o2StandPerMin, doseBasePerMin, router: p.router,
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
      const fromRoute = evade && DUST_MODES.has(mode) ? evade.from
        : detour && DETOUR_MODES.has(mode) && !detour.home ? detour.from : null;
      evade = null;
      detour = null;
      const opts = optionsAt(t);
      const chosen = choice && choice.t <= t ? opts.find((o) => o.id === choice.id) : null;
      if (chosen) choiceDone = true;
      refuge = pick(opts, chosen ?? bestRefuge(opts));
      if (refuge) {
        // After the storm, back to the route (not to the side spot of a dust devil step-aside)
        resume = fromRoute ?? { coord, tau };
        mode = 'to_refuge';
        leg = makeLeg(refuge.path ?? [coord, refuge.coord]);
      }
    }
    // The crew switched refuge during the storm: head there from here
    if (choice && !choiceDone && stormHandled && t >= choice.t && (mode === 'to_refuge' || mode === 'sheltered')) {
      choiceDone = true;
      if (refuge?.id !== choice.id) {
        const opts = optionsAt(t);
        const next = pick(opts, opts.find((o) => o.id === choice.id));
        if (next) { refuge = next; mode = 'to_refuge'; leg = makeLeg(next.path ?? [coord, next.coord]); }
      }
    }

    // Science detour the crew picked: go if the "can I go?" rule allows it from here
    if (detourIdx < detours.length && t >= detours[detourIdx].t && (mode === 'route' || mode === 'hold')) {
      const next = detours[detourIdx++];
      const chk = detourCheck({
        coord, target: next.target, habitat, router: p.router, o2, o2PerMin, o2StandPerMin,
        minutesLeft: Number.isFinite(p.evaEndMin) ? p.evaEndMin - t : null,
      });
      if (chk?.ok) {
        detour = { from: { coord, tau }, target: next.target, workLeft: SCENARIO.DETOUR_WORK_MIN, home: false, d: chk.d };
        leg = makeLeg(chk.path);
        mode = 'to_target';
      }
    }

    // Dust devils appear upwind (NE) and move downwind (SW) at DUST_SPEED_M_PER_MIN.
    // 1st: crosses the route ahead, timed to reach it when the astronaut would, but at least
    //      DUST_CROSS_MISS_M from where the astronaut is now: holding position is enough.
    // 2nd: heads straight at the astronaut: they step aside.
    const bearingSW = (SCENARIO.DUST_FROM_DEG + 180) % 360;
    if (dust && devils.length === 0 && t >= dust.t0 && isOutside(mode)) {
      let best = null;
      for (let k = 3; k <= 10; k += 0.5) {
        const q = mode === 'route' ? routeState(tl, Math.min(total, tau + k)).coord
          : offset(coord, bearingSW + 90, SCENARIO.DUST_CROSS_MISS_M);
        const startM = k * SCENARIO.DUST_SPEED_M_PER_MIN;
        const start = offset(q, SCENARIO.DUST_FROM_DEG, startM);
        const miss = devilPass(coord, start, bearingSW).miss;
        if (!best || (best.miss < SCENARIO.DUST_CROSS_MISS_M && miss > best.miss)) best = { start, startM, miss };
        if (miss >= SCENARIO.DUST_CROSS_MISS_M) break;
      }
      devils.push({ id: 1, t0: t, start: best.start, bearing: bearingSW, trackM: best.startM + SCENARIO.DUST_TRACK_M / 2, prevDist: null, evadeTried: false });
    }
    if (dust && devils.length === 1 && t >= dust.t0 + SCENARIO.DUST_SECOND_MIN && isOutside(mode)) {
      devils.push({ id: 2, t0: t, start: offset(coord, SCENARIO.DUST_FROM_DEG, SCENARIO.DUST_START_M), bearing: bearingSW, trackM: SCENARIO.DUST_TRACK_M, prevDist: null, evadeTried: false });
    }
    for (const d of devils) {
      const travelled = (t - d.t0) * SCENARIO.DUST_SPEED_M_PER_MIN;
      d.now = travelled <= d.trackM ? offset(d.start, d.bearing, travelled) : null;
      d.dist = d.now ? distanceM(coord, d.now) : null;
      d.approaching = d.dist != null && d.prevDist != null && d.dist < d.prevDist;
    }
    const active = devils.filter((d) => d.now);
    // The one shown and named in the HUD: the nearest
    const near = active.reduce((a, d) => (!a || d.dist < a.dist ? d : a), null);
    const devilNow = near?.now ?? null;
    const devilDist = near?.dist ?? null;
    const approaching = Boolean(near?.approaching);
    // Safe to move on: every dust devil is gone, or far enough and moving away
    const allClear = active.every((d) => d.dist > SCENARIO.DUST_CLEAR_M && !d.approaching);

    // A dust devil heading straight at the astronaut (its track passes closer than DUST_HOLD_M):
    // step aside, perpendicular to its track, on walkable ground, and wait there
    for (const d of active) {
      if (d.evadeTried || !(mode === 'route' || mode === 'hold')) continue;
      const pass = devilPass(coord, d.now, d.bearing);
      if (!(pass.along > 0 && pass.miss < SCENARIO.DUST_HOLD_M)) continue;
      d.evadeTried = true;
      const sides = [
        { bearing: pass.side, m: SCENARIO.DUST_EVADE_M - pass.miss },
        { bearing: (pass.side + 180) % 360, m: SCENARIO.DUST_EVADE_M + pass.miss },
      ];
      let way = null;
      for (const sd of sides) {
        const target = offset(coord, sd.bearing, sd.m);
        const r = p.router ? p.router.pathBetween(coord, target, SCENARIO.DUST_EVADE_MAX_M * 2) : null;
        const w = r ? r.coords : p.router ? null : [coord, target];
        if (w && (!r || r.length_m <= SCENARIO.DUST_EVADE_MAX_M)) { way = w; break; }
      }
      if (way) {
        evade = { from: { coord, tau }, leg: makeLeg(way) };
        leg = evade.leg;
        mode = 'evade';
      }
      break;
    }

    // A dust devil that would cross the route where the astronaut is walking to: stop and let it
    // pass (it misses the spot where the astronaut stands, so there is no need to step aside)
    let crossing = false;
    if (mode === 'route' || mode === 'hold') {
      for (const d of active) {
        const pass = devilPass(coord, d.now, d.bearing);
        if (pass.along <= 0 || pass.miss < SCENARIO.DUST_HOLD_M) continue;
        // If the walk went on: where would the astronaut and the dust devil be, minute by minute,
        // until it has passed? Too close at any time -> wait here.
        const until = (pass.along + SCENARIO.DUST_CLEAR_M) / SCENARIO.DUST_SPEED_M_PER_MIN;
        for (let k = 0; k <= until && !crossing; k += 0.25) {
          const there = routeState(tl, Math.min(total, tau + k)).coord;
          const it = offset(d.now, d.bearing, k * SCENARIO.DUST_SPEED_M_PER_MIN);
          if (distanceM(there, it) < SCENARIO.DUST_HOLD_M) crossing = true;
        }
      }
    }

    switch (mode) {
      case 'route':
        if (crossing || (devilDist != null && devilDist < SCENARIO.DUST_HOLD_M && approaching)) {
          mode = 'hold';
        } else {
          tau = Math.min(total, tau + dt);
          if (tau >= total) mode = 'done';
        }
        break;
      case 'hold':
        if (allClear && !crossing) {
          mode = 'route';
          clearedAt = t;
        }
        break;
      case 'evade':
        leg.s += SCENARIO.WALK_M_PER_MIN * dt;
        coord = legPoint(leg, leg.s);
        if (leg.s >= leg.total) mode = 'aside';
        break;
      case 'aside':
        if (allClear) {
          mode = 'rejoin';
          leg = makeLeg([...evade.leg.coords].reverse());
        }
        break;
      case 'rejoin':
        leg.s += SCENARIO.WALK_M_PER_MIN * dt;
        coord = legPoint(leg, leg.s);
        if (leg.s >= leg.total) {
          mode = 'route';
          tau = evade.from.tau;
          evade = null;
          clearedAt = t;
        }
        break;
      case 'to_target':
        leg.s += SCENARIO.WALK_M_PER_MIN * dt;
        coord = legPoint(leg, leg.s);
        if (leg.s >= leg.total) mode = 'sampling';
        break;
      case 'sampling':
        detour.workLeft -= dt;
        if (detour.workLeft <= 1e-9) {
          // Back to the route if the rest of it still fits (O2 reserve, EVA window); else home
          const back = p.router?.pathTo(detour.from.coord, `T:${detour.target.id}`);
          const backCoords = back ? [...back.coords].reverse() : [coord, detour.from.coord];
          const backMin = makeLeg(backCoords).total / SCENARIO.WALK_M_PER_MIN;
          const restMin = total - detour.from.tau;
          const o2End = o2 + o2PerMin * (backMin + restMin);
          const late = Number.isFinite(p.evaEndMin) && t + backMin + restMin > p.evaEndMin;
          if (o2End > 100 - SCENARIO.O2_RESERVE_PCT || late || !habitat) {
            const home = habitat ? p.router?.pathTo(coord, 'habitat') : null;
            detour.home = Boolean(habitat);
            detour.homeReason = o2End > 100 - SCENARIO.O2_RESERVE_PCT ? 'o2' : 'window';
            leg = makeLeg(home ? home.coords : [coord, habitat ?? detour.from.coord]);
          } else {
            leg = makeLeg(backCoords);
          }
          mode = 'from_target';
        }
        break;
      case 'from_target':
        leg.s += SCENARIO.WALK_M_PER_MIN * dt;
        coord = legPoint(leg, leg.s);
        if (leg.s >= leg.total) {
          if (detour.home) mode = 'home';
          else { mode = 'route'; tau = detour.from.tau; }
        }
        break;
      case 'to_refuge': {
        leg.s += SCENARIO.WALK_M_PER_MIN * dt;
        coord = legPoint(leg, leg.s);
        if (leg.s >= leg.total) mode = refuge.habitat ? 'home' : 'sheltered';
        break;
      }
      case 'sheltered':
        if (!stormOn) {
          mode = 'return';
          // Back the same walkable way: the path from the route to the refuge, reversed
          const back = p.router?.pathTo(resume.coord, refuge.id);
          leg = makeLeg(back ? [...back.coords].reverse() : [coord, resume.coord]);
        }
        break;
      case 'return': {
        leg.s += SCENARIO.WALK_M_PER_MIN * dt;
        coord = legPoint(leg, leg.s);
        if (leg.s >= leg.total) { mode = 'route'; tau = resume.tau; }
        break;
      }
      default:
        break;
    }
    if (mode === 'route' || mode === 'hold' || mode === 'done') coord = routeState(tl, tau).coord;
    if (mode === 'pre' || mode === 'home') coord = mode === 'home' ? (refuge?.coord ?? habitat ?? coord) : (habitat ?? tl.coords[0]);

    if (isOutside(mode)) {
      // Standing still (in a shelter, waiting for a dust devil) costs less than walking
      o2 += (mode === 'sheltered' || mode === 'hold' || mode === 'aside' || mode === 'sampling' ? o2StandPerMin : o2PerMin) * dt;
      const factor = mode === 'sheltered' ? refuge.factor : 1;
      dose += doseBasePerMin * (stormOn ? storm.mult : 1) * factor * dt;
    }
    for (const d of devils) d.prevDist = d.dist;

    steps.push({
      t, mode, tau, coord, stormOn,
      refuge: refuge && (mode === 'to_refuge' || mode === 'sheltered' || mode === 'home') ? refuge : null,
      detour: detour && DETOUR_MODES.has(mode) ? { target: detour.target, home: detour.home, homeReason: detour.homeReason, workLeft: detour.workLeft, d: detour.d } : null,
      resume: mode === 'return' ? resume : null,
      // the path being walked and how far along it (for the line on the map)
      leg: LEG_MODES.has(mode) ? leg : null,
      legS: LEG_MODES.has(mode) ? leg.s : null,
      o2, dose,
      devil: devilNow, devilDist, approaching, devilId: near?.id ?? null,
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
    const kind = DUST_MODES.has(s.mode) ? 'hold' : s.mode === 'sheltered' ? 'sheltered' : DETOUR_MODES.has(s.mode) ? 'detour' : null;
    if (kind !== runKind) {
      if (runKind) events.push({ kind: runKind, a: runStart, b: s.t });
      runKind = kind;
      runStart = s.t;
    }
  }
  if (runKind) events.push({ kind: runKind, a: runStart, b: steps[steps.length - 1].t });
  for (const d of devils) events.push({ kind: 'dust', a: d.t0, b: d.t0 + d.trackM / SCENARIO.DUST_SPEED_M_PER_MIN });

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
    // Position and route progress between two steps (smooth motion for the map and 3D view);
    // at a change of mode it snaps to the nearest step
    posAt(e) {
      if (!Number.isFinite(e) || !steps.length) return null;
      const x = Math.min(steps.length - 1, Math.max(0, (e - startMin) / dt));
      const a = steps[Math.floor(x)];
      const b = steps[Math.min(steps.length - 1, Math.floor(x) + 1)];
      const f = x - Math.floor(x);
      if (a === b || a.mode !== b.mode) return { coord: (f < 0.5 ? a : b).coord, tau: (f < 0.5 ? a : b).tau };
      return {
        coord: [a.coord[0] + (b.coord[0] - a.coord[0]) * f, a.coord[1] + (b.coord[1] - a.coord[1]) * f],
        tau: a.tau + (b.tau - a.tau) * f,
      };
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
  const dustSeen = new Set();
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
    if (s.devil && !dustSeen.has(s.devilId) && (s.devilDist < SCENARIO.DUST_APPROACH_M || DUST_MODES.has(s.mode))) {
      dustSeen.add(s.devilId);
      add(s.t, 'warn', dustSeen.size > 1 ? 'Another dust devil sighted' : 'Dust devil sighted');
    }
    if (s.mode === 'hold' && prev.mode !== 'hold') add(s.t, 'danger', 'Holding position: dust devil crossing the route ahead');
    if (s.mode === 'evade' && prev.mode !== 'evade') {
      add(s.t, 'danger', `Stepping aside: dust devil heading this way (${Math.round(s.leg?.total ?? 0)} m walk)`);
    }
    if (s.mode === 'aside' && prev.mode !== 'aside') add(s.t, 'warn', 'Clear of its track: waiting for it to pass');
    if (s.mode === 'rejoin' && prev.mode !== 'rejoin') add(s.t, 'info', 'Dust devil passed: back to the route');
    if (prev.mode === 'rejoin' && s.mode === 'route') add(s.t, 'info', 'Back on the route');
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
    if (s.mode === 'to_target' && prev.mode !== 'to_target' && s.detour) {
      add(s.t, 'info', `Detour to ${s.detour.target.name || s.detour.target.id}, ${Math.round(s.detour.d)} m away`);
    }
    if (s.mode === 'sampling' && prev.mode !== 'sampling' && s.detour) {
      add(s.t, 'info', `Sampling at ${s.detour.target.name || s.detour.target.id}`);
    }
    if (s.mode === 'from_target' && prev.mode !== 'from_target' && s.detour) {
      add(s.t, s.detour.home ? 'warn' : 'info', s.detour.home
        ? `Sampling done: heading home (${s.detour.homeReason === 'o2' ? 'O2 for the rest of the route is short' : 'EVA window closes'})`
        : 'Sampling done: back to the route');
    }
    if (prev.mode === 'from_target' && s.mode === 'route') add(s.t, 'info', 'Back on the route');
    if (s.mode === 'home' && prev.mode !== 'home') add(s.t, 'warn', 'Back in the habitat: EVA ended early');
    if (s.mode === 'done' && prev.mode !== 'done') add(s.t, 'info', 'EVA complete: back in the habitat');
    prev = s;
  }
  return log;
}
