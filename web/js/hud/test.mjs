// HUD self-tests. Run from the repo root:   node web/js/hud/test.mjs
// No dependencies (node:assert only). Not loaded by the site.
// Part 1 uses small made-up inputs, so it checks the logic itself.
// Part 2 runs on the real files in web/data/ and is skipped for any file that is missing.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  distanceM, effectiveRadiation, evalAlerts, evaDose, nextStop, radiationAt, routeState,
  routeTimeline, shadowIntervals, stopSchedule, sunAt,
} from './model.js';
import { bestRefuge, devilPass, missionLog, refugeGuided, refugeOptions, SCENARIO, simulate } from './scenario.js';
import { createRouter, legRemaining, makeGrid, pathLength } from './terrain.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.resolve(here, '../../data');

let passed = 0;
let failed = 0;
let skipped = 0;
function test(name, fn) {
  try {
    const r = fn();
    if (r === 'skip') { skipped++; console.log(`  -  ${name} (skipped: data file missing)`); return; }
    passed++;
    console.log(`  ✓  ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ✗  ${name}\n       ${err.message.split('\n')[0]}`);
  }
}
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (±${tol})`);

// --- a small synthetic route on the equator: 0.001° steps (~59 m), t_min per vertex ------
// habitat (0,0) -> passes B at x=2 (no dwell) -> A at x=4 (dwell 10 min) -> back to B (dwell 10) -> habitat
const X = [0, 1, 2, 3, 4, 4, 3, 2, 2, 1, 0];
const T = [0, 1, 2, 3, 4, 14, 15, 16, 26, 27, 28];
const synthRoute = {
  type: 'Feature',
  properties: { t_min: T, slope_deg: T.map(() => 5) },
  geometry: { type: 'LineString', coordinates: X.map((x) => [x * 0.001, 0]) },
};
const stopA = { id: 'A', name: 'Stop A', coord: [0.004, 0] };
const stopB = { id: 'B', name: 'Stop B', coord: [0.002, 0] };
const tl = routeTimeline(synthRoute, null);
const base = {
  tl, shelters: [{ coord: [0.002, 0.0005], svf: 0.5 }], habitat: [0, 0],
  startMin: -5, endMin: 300, o2PerMin: 0.2, o2StandPerMin: 0.1, doseBasePerMin: 0.64 / 1440,
};
// The crew picks the terrain shelter (the recommended refuge on this tiny map is the habitat)
const toS1 = { id: 'S1', t: -Infinity };

console.log('\nPart 1: logic (synthetic inputs)');

test('route timeline: length and duration', () => {
  near(tl.total_min, 28, 1e-9, 'total minutes');
  near(tl.d.at(-1), 8 * distanceM([0, 0], [0.001, 0]), 1e-6, 'length');
});

test('stop order uses the longest visit, not a quick pass-by', () => {
  const sch = stopSchedule(tl, [stopB, stopA]);
  assert.deepEqual(sch.map((s) => s.stop.id), ['A', 'B'], 'A (t=4) before B (dwell from t=16)');
  near(sch[1].t_min, 16, 1e-9, 'B arrival');
  near(sch[1].t_leave, 26, 1e-9, 'B departure');
});

test('a stop far from the route is not scheduled', () => {
  const far = { id: 'F', name: 'Far', coord: [0.002, 0.01] };
  const orig = console.warn;
  console.warn = () => {};
  try {
    assert.equal(stopSchedule(tl, [far]).length, 0);
  } finally {
    console.warn = orig;
  }
});

test('next stop: the one being visited, then the next', () => {
  const sch = stopSchedule(tl, [stopA, stopB]);
  assert.equal(nextStop(sch, 10).stop.id, 'A', 'at A during its dwell');
  assert.equal(nextStop(sch, 15).stop.id, 'B', 'B after leaving A');
  assert.equal(nextStop(sch, 27), null, 'nothing after B');
});

test('no scenario: progress = elapsed time, O2 = route rate x duration', () => {
  const plan = simulate({ ...base, storm: null, dust: null });
  near(plan.at(10).tau, 10, 0.3, 'tau at T+10');
  assert.equal(plan.at(-2).mode, 'pre');
  assert.equal(plan.at(40).mode, 'done');
  near(plan.finalO2, 0.2 * 28, 0.1, 'final O2');
});

test('storm: walk to the shelter, wait, walk back, finish; dose below no-shelter', () => {
  const storm = { t0: 5, duration: 30, mult: 38.6, habitatFactor: 0.3 };
  const plan = simulate({ ...base, storm, dust: null, refugeChoice: toS1 });
  const modes = new Set(Array.from({ length: 120 }, (_, i) => plan.at(i).mode));
  for (const m of ['route', 'to_refuge', 'sheltered', 'return', 'done']) assert.ok(modes.has(m), `mode ${m} seen`);
  const e = 40;
  assert.ok(plan.at(e).dose < plan.noShelterDose(e), 'shelter lowers the dose');
  assert.ok(plan.at(e).delay >= 30, 'storm delays the walk by at least its duration');
});

test('storm: standing O2 rate while sheltered', () => {
  const storm = { t0: 5, duration: 30, mult: 1, habitatFactor: 1 };
  const plan = simulate({ ...base, storm, dust: null, refugeChoice: toS1 });
  const a = plan.at(15);
  const b = plan.at(25);
  assert.equal(a.mode, 'sheltered');
  assert.equal(b.mode, 'sheltered');
  near((b.o2 - a.o2) / 10, 0.1, 1e-6, 'O2 per minute in the shelter');
});

test('storm: not enough O2 to wait -> back to the habitat', () => {
  // 800 min at 0.1 %/min standing = 80 % of the tank: more than the 75 % above the reserve
  const storm = { t0: 5, duration: 800, mult: 38.6, habitatFactor: 0.3 };
  const plan = simulate({ ...base, endMin: 900, storm, dust: null, refugeChoice: toS1 });
  const s = plan.at(6);
  assert.equal(s.mode, 'to_refuge');
  assert.ok(s.refuge.habitat && s.refuge.o2Short, 'refuge is the habitat because of O2');
});

test('shelter options: sorted by storm dose; recommended = lowest dose the O2 allows', () => {
  const storm = { t0: 0, duration: 120, mult: 38.6, habitatFactor: 0.3 };
  const q = { coord: [0.002, 0], shelters: base.shelters, habitat: [0, 0], storm, left: 120,
    o2: 0, o2PerMin: 0.2, o2StandPerMin: 0.1, doseBasePerMin: 0.64 / 1440 };
  const opts = refugeOptions(q);
  assert.deepEqual(opts.map((o) => o.id).sort(), ['S1', 'habitat']);
  assert.ok(opts.every((o, i) => i === 0 || o.dose >= opts[i - 1].dose), 'sorted by dose');
  const rate = (0.64 / 1440) * 38.6;
  const s1 = opts.find((o) => o.id === 'S1');
  near(s1.dose, rate * s1.walkMin + rate * 0.5 * (120 - s1.walkMin), 1e-9, 'S1 dose = walk + wait x svf');
  assert.equal(bestRefuge(opts).id, 'habitat', 'habitat x0.3 beats a shelter with svf 0.5');
  // A shelter that blocks almost everything wins; one the O2 cannot afford is never recommended
  const good = refugeOptions({ ...q, shelters: [{ coord: [0.002, 0.0005], svf: 0.05 }] });
  assert.equal(bestRefuge(good).id, 'S1');
  const short = refugeOptions({ ...q, o2: 70, shelters: [{ coord: [0.002, 0.0005], svf: 0.05 }] });
  assert.ok(short.find((o) => o.id === 'S1').o2Short, 'S1 short of O2');
  assert.equal(bestRefuge(short).id, 'habitat');
});

test('storm: goes to the recommended refuge unless the crew picks another', () => {
  const storm = { t0: 5, duration: 30, mult: 38.6, habitatFactor: 0.3 };
  const auto = simulate({ ...base, storm, dust: null });
  assert.equal(auto.at(6).refuge.id, 'habitat', 'auto = lowest dose');
  const picked = simulate({ ...base, storm, dust: null, refugeChoice: toS1 });
  assert.equal(picked.at(6).refuge.id, 'S1', 'crew choice');
  // Switching mid-storm: heading home, then at T+6 the crew picks S1 instead
  const sw = simulate({ ...base, storm, dust: null, refugeChoice: { id: 'S1', t: 6 } });
  assert.equal(sw.at(5.5).refuge.id, 'habitat', 'recommended until the switch');
  assert.equal(sw.at(6.5).refuge.id, 'S1', 'heads to S1 after the switch');
  const modes = new Set(Array.from({ length: 480 }, (_, i) => sw.at(i * 0.25).mode));
  for (const m of ['sheltered', 'return', 'done']) assert.ok(modes.has(m), `mode ${m} seen`);
});

test('storm alert: generic rule hidden while the HUD guides to a refuge', () => {
  const rules = { rules: [{ id: 'storm', metric: 'radiation_status', op: '==', value: 'storm', level: 'danger', text: 'Go to the nearest shelter' }] };
  const shown = (mode) => evalAlerts(rules, { radiation_status: refugeGuided(mode) ? null : 'storm' }).length > 0;
  assert.ok(shown('route'), 'shown while still on the route');
  assert.ok(!shown('to_refuge'), 'hidden while heading to the refuge');
  assert.ok(!shown('sheltered'), 'hidden while sheltered');
});

// --- terrain: a 40 x 40 grid (~9 m cells) with a steep wall across the middle and one gap
const GW = 40;
const gridBounds = { west: 0, south: -0.006, east: 0.006, north: 0 };
const wallZ = new Float32Array(GW * GW);
for (let y = 0; y < GW; y++) for (let x = 0; x < GW; x++) {
  wallZ[y * GW + x] = x === 20 && y < 34 ? 50 : 0;   // 50 m wall at x = 20, gap at the south end
}
const wallGrid = makeGrid(wallZ, GW, GW, gridBounds);
const cell = (x, y) => wallGrid.coordOf(y * GW + x);

test('refuge path: goes around a wall too steep to cross', () => {
  const from = cell(10, 5);
  const to = cell(30, 5);
  const router = createRouter(wallGrid, [{ id: 'S1', coord: to }]);
  const r = router.pathTo(from, 'S1');
  assert.ok(r, 'path found');
  assert.ok(r.length_m > 2 * distanceM(from, to), `detour ${Math.round(r.length_m)} m vs straight ${Math.round(distanceM(from, to))} m`);
  // Every point that crosses x = 20 is in the gap (y >= 34)
  for (const c of r.coords) {
    const i = wallGrid.cellOf(c);
    if (i >= 0 && i % GW === 20) assert.ok(Math.floor(i / GW) >= 34, 'crosses only through the gap');
  }
  near(r.length_m, pathLength(r.coords), 1e-6, 'length');
});

test('refuge path: flat ground is about a straight line; no way through -> null', () => {
  const flat = makeGrid(new Float32Array(GW * GW), GW, GW, gridBounds);
  const a = cell(5, 5);
  const b = cell(15, 12);
  const r = createRouter(flat, [{ id: 'S1', coord: b }]).pathTo(a, 'S1');
  assert.ok(r.length_m < distanceM(a, b) * 1.1, 'close to straight');
  const closed = new Float32Array(wallZ);
  for (let y = 34; y < GW; y++) closed[y * GW + 20] = 50;   // close the gap
  const g = makeGrid(closed, GW, GW, gridBounds);
  assert.equal(createRouter(g, [{ id: 'S1', coord: cell(30, 5) }]).pathTo(cell(10, 5), 'S1'), null);
});

test('storm with terrain: the astronaut walks the path there and back', () => {
  // A route on the west side of the wall; the only shelter is east of it
  const route = {
    type: 'Feature',
    properties: { t_min: [0, 10, 20] },
    geometry: { type: 'LineString', coordinates: [cell(5, 5), cell(10, 5), cell(5, 5)] },
  };
  const rtl = routeTimeline(route, null);
  const shelter = { coord: cell(30, 5), svf: 0.3 };
  const router = createRouter(wallGrid, [{ id: 'S1', coord: shelter.coord }, { id: 'habitat', coord: cell(5, 5) }]);
  const storm = { t0: 10, duration: 60, mult: 38.6, habitatFactor: 1 };
  const plan = simulate({
    tl: rtl, shelters: [shelter], habitat: cell(5, 5), startMin: -1, endMin: 200,
    o2PerMin: 0.2, o2StandPerMin: 0.1, doseBasePerMin: 0.64 / 1440, storm, dust: null, router,
  });
  const go = plan.at(10.5);
  assert.equal(go.refuge.id, 'S1');
  assert.ok(go.leg.coords.length > 2, 'walks a path, not a straight line');
  near(go.refuge.d, go.leg.total, 1e-6, 'option distance = path length');
  // Half way there it is south of the start (going round the wall), not on the straight line
  const half = plan.steps.find((s) => s.mode === 'to_refuge' && s.legS >= go.leg.total / 2);
  assert.ok(half.coord[1] < cell(10, 20)[1], 'detours through the gap in the south');
  const back = plan.steps.find((s) => s.mode === 'return');
  assert.ok(back && back.leg.coords.length > 2, 'returns along the path');
  assert.ok(legRemaining(back.leg, back.legS).length >= 2, 'remaining path for the map');
  assert.ok(plan.steps.some((s) => s.mode === 'done'), 'finishes the route');
});

test('dust devil heading at the astronaut: step aside, wait, walk back, finish later', () => {
  const plan = simulate({ ...base, storm: null, dust: { t0: 3 } });
  const modes = new Set(plan.steps.map((s) => s.mode));
  for (const m of ['evade', 'aside', 'rejoin', 'done']) assert.ok(modes.has(m), `mode ${m} seen`);
  const closest = Math.min(...plan.steps.filter((s) => s.devilDist != null).map((s) => s.devilDist));
  assert.ok(closest >= 100, `keeps clear of the vortex (closest ${Math.round(closest)} m)`);
  const aside = plan.steps.find((s) => s.mode === 'aside');
  const pass = devilPass(aside.coord, plan.steps.find((s) => s.t === aside.t).devil, 225);
  assert.ok(pass.miss >= SCENARIO.DUST_EVADE_M - 1, `aside spot is ${Math.round(pass.miss)} m off the track`);
  assert.ok(plan.at(60).delay > 0, 'finishes later than planned');
  const text = missionLog(plan, [], []).map((x) => x.text).join(' | ');
  for (const w of ['Dust devil sighted', 'Stepping aside', 'Dust devil passed', 'Back on the route']) assert.ok(text.includes(w), `log has "${w}"`);
});

test('dust devil: no walkable spot aside -> hold position, then resume', () => {
  const blocked = { pathTo: () => null, pathBetween: () => null };
  const plan = simulate({ ...base, storm: null, dust: { t0: 3 }, router: blocked });
  const modes = new Set(plan.steps.map((s) => s.mode));
  assert.ok(modes.has('hold') && !modes.has('evade'), 'holds instead of stepping aside');
  assert.equal(plan.at(60).mode, 'done');
});

test('devilPass: ahead / behind, miss distance and side', () => {
  // Devil at the origin moving north (bearing 0); a point 100 m north, 30 m east
  const pt = [30 / (3396190 * Math.PI / 180), 100 / (3396190 * Math.PI / 180)];
  const a = devilPass(pt, [0, 0], 0);
  near(a.along, 100, 0.01, 'along');
  near(a.miss, 30, 0.01, 'miss');
  assert.equal(a.side, 90, 'point is east of the track');
  assert.ok(devilPass(pt, [0, 0], 180).along < 0, 'already past when moving south');
});

test('mission log: start, scenario events and end, in time order', () => {
  const storm = { t0: 5, duration: 30, mult: 38.6, habitatFactor: 0.3 };
  const plan = simulate({ ...base, storm, dust: null, refugeChoice: toS1 });
  const log = missionLog(plan, stopSchedule(tl, [stopA, stopB]), []);
  const text = log.map((x) => x.text).join(' | ');
  for (const w of ['EVA start', 'Solar storm alert', 'Heading to shelter', 'In shelter', 'EVA complete']) {
    assert.ok(text.includes(w), `log has "${w}"`);
  }
  assert.ok(log.every((x, i) => i === 0 || x.t >= log[i - 1].t), 'sorted by time');
});

test('radio shadows: intervals from comm_ok, empty for another route', () => {
  const len = tl.d.at(-1);
  const rows = [0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => ({ d: (len * i) / 8, comm_ok: !(i === 2 || i === 3) }));
  const sh = shadowIntervals(tl, { route: rows });
  assert.equal(sh.length, 1, 'one shadow');
  assert.ok(sh[0].a >= 1 && sh[0].b <= 5, `shadow inside the outbound leg (${sh[0].a}-${sh[0].b})`);
  const stale = rows.map((r) => ({ ...r, d: r.d * 3 }));
  assert.deepEqual(shadowIntervals(tl, { route: stale }), [], 'built for another route');
});

test('radiation: storm replay applied only when on; CME window ends after 48 h', () => {
  const rad = {
    base_mSv_per_day: 0.64, event_multiplier: 1, status: 'elevated', message: 'CME',
    mars_arrivals_in_window: [{ utc: '2026-11-13T12:00:00Z' }],
    replay: { date: '2024-05-20', status: 'storm', event_multiplier: 38.6, message: 'storm' },
  };
  assert.equal(effectiveRadiation(rad, false).status, 'elevated');
  assert.equal(effectiveRadiation(rad, true).event_multiplier, 38.6);
  assert.equal(radiationAt(rad, new Date('2026-11-15T11:59:00Z')).status, 'elevated');
  assert.equal(radiationAt(rad, new Date('2026-11-15T12:01:00Z')).status, 'nominal');
  near(evaDose(rad, {}, 240).mSv, (0.64 * 240) / 1440, 1e-9, '4 h dose');
});

test('alerts: alerts.json rules, danger first, no duplicate radiation alert', () => {
  const rules = { rules: [
    { id: 'slope', metric: 'slope_deg', op: '>=', value: 15, level: 'warn', text: 'Steep' },
    { id: 'storm', metric: 'radiation_status', op: '==', value: 'storm', level: 'danger', text: 'Storm' },
  ] };
  const out = evalAlerts(rules, { slope_deg: 20, radiation_status: 'storm', radiation_message: 'x' });
  assert.deepEqual(out.map((a) => a.id), ['storm', 'slope']);
  const builtin = evalAlerts({ rules: [] }, { radiation_status: 'storm', radiation_message: 'x' });
  assert.equal(builtin[0].id, 'hud-radiation', 'built-in alert when no rule covers radiation');
});

test('missing data never throws', () => {
  assert.equal(sunAt(null, new Date()), null);
  assert.equal(routeTimeline(null, null), null);
  assert.equal(routeState(null, 5), null);
  assert.deepEqual(stopSchedule(null, null), []);
  assert.equal(evaDose(null, null), null);
  assert.deepEqual(shadowIntervals(null, null), []);
  assert.deepEqual(missionLog(null), []);
  assert.deepEqual(evalAlerts(null, {}), []);
});

// --- Part 2: the real data files ------------------------------------------------------------
console.log('\nPart 2: real data (web/data)');
const read = (f) => {
  const p = path.join(DATA, f);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
};
const sun = read('sun.json');
const eva = read('eva_window.json');
const route = read('route.geojson');
const summary = read('summary.json');
const stops = read('stops.json');
const safety = read('safety/safety.json');

test('sun.json: 1 sol at 10 min, LMST as HH:MM, light time 4-24 min', () => {
  if (!sun) return 'skip';
  assert.equal(sun.rows.length, 149);
  assert.ok(sun.rows.every((r) => /^\d{2}:\d{2}$/.test(r.lmst)), 'LMST format');
  assert.ok(sun.rows.every((r) => r.light_time_min == null || (r.light_time_min > 4 && r.light_time_min < 24)), 'light time');
});

test('eva_window.json: inside the sol, Sun above 15° at both ends', () => {
  if (!sun || !eva) return 'skip';
  for (const t of [eva.start_utc, eva.end_utc]) {
    const s = sunAt(sun, new Date(t));
    assert.ok(s.sun_el >= 15 - 0.5, `Sun ${s.sun_el.toFixed(1)}° at ${t}`);
  }
});

test('real route: stops in the order of stops.json, all on the route', () => {
  if (!route || !summary || !stops) return 'skip';
  const rtl = routeTimeline(route, summary);
  const sch = stopSchedule(rtl, stops);
  assert.equal(sch.length, stops.length, 'every stop scheduled');
  assert.deepEqual(sch.map((s) => s.stop.id), stops.map((s) => s.id));
});

test('real route: plan without scenarios matches summary.json O2', () => {
  if (!route || !summary) return 'skip';
  const rtl = routeTimeline(route, summary);
  const plan = simulate({
    tl: rtl, shelters: [], habitat: rtl.coords[0], startMin: -5, endMin: rtl.total_min + 10,
    o2PerMin: summary.o2_used_pct / rtl.total_min, doseBasePerMin: 0.64 / 1440, storm: null, dust: null,
  });
  near(plan.finalO2, summary.o2_used_pct, 0.2, 'O2 used');
});

test('real safety.json: radio shadows add up to a few minutes, shelters within reach', () => {
  if (!route || !summary || !safety) return 'skip';
  const rtl = routeTimeline(route, summary);
  const sh = shadowIntervals(rtl, safety);
  const total = sh.reduce((s, x) => s + (x.b - x.a), 0);
  assert.ok(total > 0 && total < 60, `total without link ${total.toFixed(1)} min`);
  const worst = Math.max(...safety.route.map((r) => r.shelter_min ?? 0));
  assert.ok(worst <= 15, `worst shelter time ${worst} min`);
});

console.log(`\n${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ''}`);
process.exit(failed ? 1 : 0);
