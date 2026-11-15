// HUD self-tests. Run from the repo root:   node web/js/hud/test.mjs
// No dependencies (node:assert only). Not loaded by the site.
// Part 1 uses small made-up inputs, so it checks the logic itself.
// Part 2 runs on the real files in web/data/ and is skipped for any file that is missing.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  distanceM, effectiveRadiation, evalAlerts, evaDose, nextStop, radiationAt, routeO2, routeState,
  routeTimeline, shadowIntervals, stopSchedule, sunAt,
  routeO2Left, walkO2PerMin,
  tempAt,
} from './model.js';
import {
  bestRefuge, detourCheck, devilPass, missionLog, previewPhoto, refugeGuided, refugeOptions, SCENARIO, simulate, stopPreview,
} from './scenario.js';
import { createRouter, legRemaining, makeGrid, pathLength, slopeAt, steepestOnPath, zAt } from './terrain.js';

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

// Same route with Demir's per-vertex O2 (route.geojson o2_pct): walking 0.3 %/min, standing 0.1 %/min
const O2_WALK = 0.3;
const O2_STAND = 0.1;
const synthO2 = T.map((_, i) => 0);
for (let i = 1; i < T.length; i++) {
  const dwell = X[i] === X[i - 1];
  synthO2[i] = synthO2[i - 1] + (T[i] - T[i - 1]) * (dwell ? O2_STAND : O2_WALK);
}
const tlO2 = routeTimeline({ ...synthRoute, properties: { ...synthRoute.properties, o2_pct: synthO2 } }, null);

test('route O2: o2_pct read and interpolated by route minute', () => {
  assert.ok(Array.isArray(tlO2.o2), 'tl.o2 present');
  assert.equal(tl.o2, null, 'no o2_pct: tl.o2 is null');
  near(routeO2(tlO2, 4), 4 * O2_WALK, 1e-9, 'at A (walked 4 min)');
  near(routeO2(tlO2, 9), 4 * O2_WALK + 5 * O2_STAND, 1e-9, 'half way through the dwell at A');
  assert.equal(routeO2(tl, 9), null, 'no o2_pct: null');
  const broken = routeTimeline({ ...synthRoute, properties: { ...synthRoute.properties, o2_pct: [1, 2] } }, null);
  assert.equal(broken.o2, null, 'o2_pct of the wrong length is ignored');
});

test('route O2: plain walk follows o2_pct, not the per-minute rate', () => {
  const plan = simulate({ ...base, tl: tlO2, o2PerMin: 0.9 });
  near(plan.finalO2, synthO2.at(-1), 1e-6, 'O2 used = last o2_pct');
});

test('route O2: off the route (to a shelter) the walking rate applies', () => {
  const plan = simulate({ ...base, tl: tlO2, o2PerMin: 0.5, refugeChoice: toS1,
    storm: { t0: 2, duration: 40, mult: 10, habitatFactor: 0.3 } });
  const i = plan.steps.findIndex((x, k) => k > 0 && x.mode === 'to_refuge' && plan.steps[k - 1].mode === 'to_refuge');
  assert.ok(i > 0, 'walks to the shelter');
  near(plan.steps[i].o2 - plan.steps[i - 1].o2, 0.5 * SCENARIO.STEP_MIN, 1e-9, 'O2 per step on the way to the shelter');
});

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

test('slope from the grid: a 10 % ramp is ~5.7°, steepest stretch found on a path', () => {
  // Elevation rises 0.1 m per metre eastwards
  const ramp = new Float32Array(GW * GW);
  const g0 = makeGrid(ramp, GW, GW, gridBounds);
  for (let y = 0; y < GW; y++) for (let x = 0; x < GW; x++) ramp[y * GW + x] = 0.1 * x * g0.dx;
  near(slopeAt(g0, cell(20, 20)), Math.atan(0.1) * 180 / Math.PI, 0.01, 'ramp slope');
  near(zAt(g0, cell(10, 3)), 0.1 * 10 * g0.dx, 1e-3, 'elevation at a cell centre');
  // Walking north on the ramp is flat; walking east climbs 10 %
  near(steepestOnPath(g0, [cell(5, 5), cell(5, 30)]).deg, 0, 0.01, 'along the contour');
  near(steepestOnPath(g0, [cell(5, 5), cell(30, 5)]).deg, Math.atan(0.1) * 180 / Math.PI, 0.05, 'up the ramp');
  assert.equal(slopeAt(g0, [1, 1]), null, 'outside the grid');
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

test('detour check: O2 at the habitat after walk + sampling + walk home; reserve and EVA window', () => {
  const target = { id: 'X', name: 'Sulfate', coord: [0.004, 0.003] };
  const q = { coord: [0.002, 0], target, habitat: [0, 0], o2: 10, o2PerMin: 0.2, o2StandPerMin: 0.1, minutesLeft: 300 };
  const c = detourCheck(q);
  near(c.walkMin, distanceM([0.002, 0], target.coord) / 50, 1e-9, 'walk there');
  near(c.backMin, distanceM(target.coord, [0, 0]) / 50, 1e-9, 'walk home');
  near(c.o2AtReturn, 100 - (10 + 0.2 * (c.walkMin + c.backMin) + 0.1 * SCENARIO.DETOUR_WORK_MIN), 1e-9, 'O2 at return');
  assert.ok(c.ok, 'allowed');
  assert.equal(detourCheck({ ...q, o2: 74 }).reason, 'o2', 'reserve would break');
  assert.equal(detourCheck({ ...q, minutesLeft: 10 }).reason, 'window', 'EVA window closes first');
});

test('detour: walk to the target, sample, back to the route, finish later', () => {
  const target = { id: 'X', name: 'Sulfate', coord: [0.003, 0.002] };
  const plan = simulate({ ...base, storm: null, dust: null, detours: [{ target, t: 5 }], evaEndMin: 480 });
  const modes = plan.steps.map((s) => s.mode);
  for (const m of ['to_target', 'sampling', 'from_target', 'done']) assert.ok(modes.includes(m), `mode ${m} seen`);
  const sampling = plan.steps.filter((s) => s.mode === 'sampling');
  near(sampling.length * SCENARIO.STEP_MIN, SCENARIO.DETOUR_WORK_MIN, SCENARIO.STEP_MIN, 'sampling time');
  near(distanceM(sampling[0].coord, target.coord), 0, 1, 'samples at the target');
  near((sampling[8].o2 - sampling[4].o2) / 1, 0.1, 1e-6, 'standing O2 rate while sampling');
  assert.ok(plan.at(100).delay > SCENARIO.DETOUR_WORK_MIN, 'route finishes later');
  const text = missionLog(plan, [], []).map((x) => x.text).join(' | ');
  for (const w of ['Detour to Sulfate', 'Sampling at Sulfate', 'back to the route', 'Back on the route']) assert.ok(text.includes(w), `log has "${w}"`);
});

test('detour: not allowed -> ignored; rest of the route too long after sampling -> home', () => {
  const far = { id: 'F', name: 'Far', coord: [0.03, 0.03] };
  const plan = simulate({ ...base, storm: null, dust: null, detours: [{ target: far, t: 5 }], evaEndMin: 60 });
  assert.ok(!plan.steps.some((s) => s.mode === 'to_target'), 'EVA window rule blocks it');
  // Allowed (home fits), but after sampling the rest of the route would end past the window
  const near1 = { id: 'N', name: 'Near', coord: [0.003, 0.001] };
  const tight = simulate({ ...base, storm: null, dust: null, detours: [{ target: near1, t: 5 }], evaEndMin: 30 });
  const back = tight.steps.find((s) => s.mode === 'from_target');
  assert.ok(back && back.detour.home && back.detour.homeReason === 'window', 'heads home');
  assert.equal(tight.steps.at(-1).mode, 'home');
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

test('arrival preview: the site view (Navcam) from 5 min before arriving until leaving, on the route only', () => {
  const photos = [
    { url: 'https://example.test/mahli.jpg', camera: 'MAHLI', camera_name: 'MAHLI', credit: 'NASA/JPL-Caltech/MSSS' },
    { url: 'https://example.test/mast.jpg', camera: 'MAST_LEFT', camera_name: 'Mastcam', credit: 'NASA/JPL-Caltech/MSSS' },
    { url: 'https://example.test/nav.jpg', camera: 'NAV_LEFT_B', camera_name: 'Navcam', credit: 'NASA/JPL-Caltech' },
  ];
  assert.equal(previewPhoto({ photos }).camera_name, 'Navcam', 'Navcam first');
  assert.equal(previewPhoto({ photos: [photos[0], photos[1]] }).camera_name, 'Mastcam', 'then Mastcam');
  assert.equal(previewPhoto({ photos: [photos[0]] }).camera_name, 'MAHLI', 'else whatever there is');
  assert.equal(previewPhoto({ photos: [{ sol: 1 }] }), null, 'a photo without a URL does not count');
  assert.equal(previewPhoto({}), null);

  const entry = { stop: { ...stopB, photos }, t_min: 16, t_leave: 26 };
  const lead = SCENARIO.STOP_PREVIEW_MIN;
  assert.equal(stopPreview(entry, 16 - lead - 0.5), null, 'too early');
  near(stopPreview(entry, 16 - lead).eta_min, lead, 1e-9, 'starts 5 min before');
  assert.equal(stopPreview(entry, 20).eta_min, 0, 'stays while at the stop');
  assert.equal(stopPreview(entry, 26.5), null, 'gone after leaving');
  for (const mode of ['to_refuge', 'sheltered', 'hold', 'evade', 'to_target', 'home']) {
    assert.equal(stopPreview(entry, 15, mode), null, `hidden in mode ${mode}`);
  }
  assert.equal(stopPreview({ stop: stopB, t_min: 16, t_leave: 26 }, 15), null, 'no photo, no preview');
  assert.equal(stopPreview(null, 15), null);
});

test('mission log: "Approaching" once per stop with a photo, before its arrival, not while at the stop before', () => {
  const photos = [{ url: 'https://example.test/mast.jpg', camera_name: 'Mastcam' }];
  const plan = simulate({ ...base, storm: null, dust: null });
  const sch = stopSchedule(tl, [{ ...stopA, photos }, { ...stopB, photos }]);
  const log = missionLog(plan, sch, []);
  const at = (w) => log.filter((x) => x.text.startsWith(w));
  assert.equal(at('Approaching Stop A').length, 1);
  assert.equal(at('Approaching Stop B').length, 1);
  assert.ok(at('Approaching Stop A')[0].t < at('Arrived at Stop A')[0].t, 'A: approaching before arrived');
  assert.ok(at('Approaching Stop B')[0].t >= at('Left Stop A')[0].t - 1e-9, 'B: not announced while still at A');
  assert.ok(at('Approaching Stop B')[0].t < at('Arrived at Stop B')[0].t, 'B: approaching before arrived');
  assert.ok(log.every((x, i) => i === 0 || x.t >= log[i - 1].t), 'sorted by time');
  const plain = missionLog(plan, stopSchedule(tl, [stopA, stopB]), []);
  assert.equal(plain.filter((x) => x.text.startsWith('Approaching')).length, 0, 'no photos, no line');
});

test('air temperature: interpolated by LMST, across midnight, null without data', () => {
  const w = { rows: [{ lmst: '00:00', temp_c: -70 }, { lmst: '12:00', temp_c: -10 }, { lmst: '23:00', temp_c: -60 }] };
  near(tempAt(w, 6 * 60), -40, 1e-9, 'halfway between midnight and noon');
  near(tempAt(w, 12 * 60), -10, 1e-9, 'on a row');
  near(tempAt(w, 23.5 * 60), -65, 1e-9, 'between 23:00 and the next midnight');
  near(tempAt(w, 1440 + 6 * 60), -40, 1e-9, 'minutes past one sol wrap');
  assert.equal(tempAt({}, 600), null);
  assert.equal(tempAt(w, null), null);
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

test('real stops: every stop has a credited photo for the arrival preview, due 5 min before it', () => {
  if (!route || !summary || !stops) return 'skip';
  const sch = stopSchedule(routeTimeline(route, summary), stops);
  for (const e of sch) {
    const photo = previewPhoto(e.stop);
    assert.ok(photo, `${e.stop.id} has a photo`);
    assert.ok(/^https:\/\//.test(photo.url), `${e.stop.id} photo is an https URL`);
    assert.ok(photo.credit, `${e.stop.id} photo has a credit`);
    assert.ok(stopPreview(e, e.t_min - SCENARIO.STOP_PREVIEW_MIN + 0.1), `${e.stop.id} preview due before arriving`);
  }
});

test('real targets.json: off the route stops, inside the area, one of the three units', () => {
  const targets = read('targets.json');
  const area = read('area.json');
  if (!targets || !stops || !area) return 'skip';
  assert.ok(Array.isArray(targets) && targets.length >= 3, 'at least a few targets');
  assert.equal(new Set(targets.map((t) => t.id)).size, targets.length, 'ids are unique');
  assert.ok(new Set(targets.map((t) => t.unit)).size > 1, 'more than one unit, so the filter is useful');
  const b = area.bbox;
  for (const t of targets) {
    assert.ok(['clay', 'transition', 'sulfate'].includes(t.unit), `${t.id} unit`);
    assert.ok(t.coord[0] >= b.west && t.coord[0] <= b.east && t.coord[1] >= b.south && t.coord[1] <= b.north, `${t.id} inside the bbox`);
    const d = Math.min(...stops.map((st) => distanceM(t.coord, st.coord)));
    assert.ok(d >= 150, `${t.id} is ${Math.round(d)} m from a stop: a place of its own`);
    assert.ok(t.name && t.note, `${t.id} has a name and a note`);
  }
});

test('O2 rates for the panel: walking rate for the way home, rest of the route from o2_pct', () => {
  near(walkO2PerMin({ o2_used_pct: 5.6, o2_walk_pct_per_min: 0.3 }, tl), 0.3, 1e-9, 'walking-only rate when given');
  near(walkO2PerMin({ o2_used_pct: 5.6 }, tl), 0.2, 1e-9, 'else the route average');
  assert.equal(walkO2PerMin({}, tl), null);
  near(routeO2Left(tl, { o2_used_pct: 5.6 }, 14), 2.8, 1e-9, 'even spread without o2_pct');
  const o2 = T.map((t, i) => (i < 5 ? t * 0.5 : 2 + (t - 4) * 0.05));
  const tlO2 = routeTimeline({ ...synthRoute, properties: { ...synthRoute.properties, o2_pct: o2 } }, null);
  near(routeO2Left(tlO2, { o2_used_pct: 5.6 }, 2), o2.at(-1) - 1, 1e-9, 'from the per-vertex values');
  assert.equal(routeO2Left(tlO2, {}, 99), 0, 'nothing left after the end');
});

test('real weather.json: air in the EVA window between REMS min and max', () => {
  const weather = read('weather.json');
  if (!weather || !eva) return 'skip';
  for (const hm of [eva.start_lmst, eva.end_lmst]) {
    const c = tempAt(weather, Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5)));
    assert.ok(c >= weather.min_c - 0.5 && c <= weather.max_c + 0.5, `${hm}: ${c} °C`);
  }
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

test('real route: with the walking rate off the route, the plain plan still matches summary.json O2', () => {
  if (!route || !summary || !Number.isFinite(summary.o2_walk_pct_per_min)) return 'skip';
  const rtl = routeTimeline(route, summary);
  if (!rtl.o2) return 'skip';
  const plan = simulate({
    tl: rtl, shelters: [], habitat: rtl.coords[0], startMin: -5, endMin: rtl.total_min + 10,
    o2PerMin: summary.o2_walk_pct_per_min, o2StandPerMin: summary.o2_standing_pct_per_min,
    doseBasePerMin: 0.64 / 1440, storm: null, dust: null,
  });
  near(plan.finalO2, summary.o2_used_pct, 0.2, 'O2 used');
});

test('real route: ?hazard=dustdevil demo shows a hold, then a step-aside, never closer than 120 m', () => {
  if (!route || !summary) return 'skip';
  const rtl = routeTimeline(route, summary);
  const plan = simulate({
    tl: rtl, shelters: [], habitat: rtl.coords[0], startMin: -5, endMin: rtl.total_min + 60,
    o2PerMin: summary.o2_used_pct / rtl.total_min, doseBasePerMin: 0.64 / 1440, storm: null,
    dust: { t0: SCENARIO.DUST_URL_START_MIN },
  });
  const modes = plan.steps.map((s) => s.mode);
  const hold = modes.indexOf('hold');
  const evade = modes.indexOf('evade');
  assert.ok(hold >= 0 && evade > hold, 'first dust devil: hold; second: step aside');
  const closest = Math.min(...plan.steps.filter((s) => s.devilDist != null).map((s) => s.devilDist));
  assert.ok(closest >= SCENARIO.DUST_HOLD_M, `closest ${Math.round(closest)} m`);
  assert.equal(plan.steps.at(-1).mode, 'done');
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
