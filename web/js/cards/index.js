// Stop cards: photo + science note for the selected Marswalk stop, and a
// mission briefing shown while no stop is selected (first-time visitors).
// Owner: Egemen (branch `veri`)
//
// Contract (project rules + docs/contracts.md):
//   export function initCards(state, el)
//   listens to document 'stop:select' (detail = stop from stops.json)
//   stop = {id, name, coord[lon,lat], science, photos[{url, sol, camera, credit}]}
// Reads (never writes) when present:
//   state.images  (images.json, coord = rover position)  -> nearby photos if stop.photos is empty
//   state.route   (route.geojson, properties.t_min[])    -> arrival time at the stop
//   state.eva     (eva_window.json, start_lmst)          -> arrival LMST, EVA band on the chart
//   state.weather (weather.json rows)                    -> temperature at arrival
//   state.summary, state.radiation                       -> briefing: distance, time, O2, radiation
// Dispatches (same events as the header buttons / the map):
//   stop:select (tour buttons), view3d:toggle, hud:toggle (briefing shortcuts)
// Navigation view ("Plan your own route", nav.js + router.js): nav:pick, nav:routes,
//   nav:choose, nav:clear out; nav:point in (a clicked point from the map or the 3D view).
// Every input may be null/missing: the card degrades, it never throws.

import { createNav } from './nav.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const DEFAULT_CREDIT = 'NASA/JPL-Caltech';
const MARS_RADIUS_M = 3396190;          // same sphere as the project CRS
const SOL_PER_DAY = 1.0274912517;        // 1 LMST hour = 1.0275 Earth hours
const NEARBY_MAX_M = 300;                // Curiosity photos within this distance count as "near the stop"
const NEARBY_MAX_PHOTOS = 6;
const ROUTE_SNAP_MAX_M = 150;            // stop must be this close to the route to get an arrival time
const ROUTE_REVISIT_TOL_M = 10;          // vertices this much farther than the nearest still count as "at the stop"
const DWELL_MIN_SHOWN = 2;               // a t_min jump at the stop longer than this is shown as time spent there

function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

function s(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

const lmstToH = (str) => {
  const m = /^(\d{1,2}):(\d{2})/.exec(str || '');
  return m ? Number(m[1]) + Number(m[2]) / 60 : null;
};

function validCoord(c) {
  return Array.isArray(c) && c.length >= 2 && Number.isFinite(Number(c[0])) && Number.isFinite(Number(c[1]));
}

// Great-circle distance in metres between two [lon, lat] points on the Mars sphere.
function distM(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * rad, dLon = (b[0] - a[0]) * rad;
  const q = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * MARS_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(q)));
}

const hToLmst = (hr) => {
  const m = Math.round((((hr % 24) + 24) % 24) * 60);
  return `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};

// Linear interpolation of weather rows at LMST hour t (wraps around midnight).
function tempAt(weather, t) {
  const rows = (weather?.rows || [])
    .map((r) => ({ t: lmstToH(r.lmst), c: Number(r.temp_c) }))
    .filter((r) => r.t != null && Number.isFinite(r.c))
    .sort((a, b) => a.t - b.t);
  if (!rows.length || t == null) return null;
  const ring = [...rows, { t: rows[0].t + 24, c: rows[0].c }]; // close the day
  let tt = ((t % 24) + 24) % 24;
  if (tt < rows[0].t) tt += 24;
  for (let i = 0; i < ring.length - 1; i++) {
    const a = ring[i], b = ring[i + 1];
    if (tt >= a.t && tt <= b.t) return b.t === a.t ? a.c : a.c + ((b.c - a.c) * (tt - a.t)) / (b.t - a.t);
  }
  return rows[rows.length - 1].c;
}

// Photos taken by Curiosity near the stop (images.json coord), closest first.
function nearbyPhotos(stop, images) {
  if (!validCoord(stop.coord) || !Array.isArray(images)) return [];
  return images
    .filter((im) => im && im.url && validCoord(im.coord))
    .map((im) => ({ ...im, distance_m: distM(stop.coord, im.coord) }))
    .filter((im) => im.distance_m <= NEARBY_MAX_M)
    .sort((a, b) => a.distance_m - b.distance_m)
    .slice(0, NEARBY_MAX_PHOTOS);
}

// First LineString with t_min[] in route.geojson (Feature or FeatureCollection).
function routeLine(route) {
  const feats = route?.type === 'FeatureCollection' ? route.features : [route];
  for (const f of feats || []) {
    const c = f?.geometry?.type === 'LineString' ? f.geometry.coordinates : null;
    const t = f?.properties?.t_min;
    if (Array.isArray(c) && Array.isArray(t) && c.length === t.length) return { coords: c, tMin: t, props: f.properties };
  }
  return null;
}

// Arrival at the stop along the planned route: minutes after EVA start, LMST, air temperature.
function arrivalInfo(stop, st) {
  const line = routeLine(st.route);
  if (!line || !validCoord(stop.coord)) return null;
  const ds = line.coords.map((c) => distM(stop.coord, c));
  const bestD = Math.min(...ds);
  if (!(bestD <= ROUTE_SNAP_MAX_M)) return null;
  // A route can pass a stop more than once (e.g. walks past it on the way out and
  // stops there on the way back). Split the vertices about as close as the nearest
  // one into passes (contiguous runs). The visit is the earliest pass that contains
  // the dwell (t_min jumps by the stop time); with no dwell anywhere, the first pass.
  const near = (i) => ds[i] <= bestD + ROUTE_REVISIT_TOL_M;
  const tAt = (i) => Number(line.tMin[i]);
  const passes = [];
  for (let i = 0; i < ds.length; i++) {
    if (!near(i)) continue;
    const run = passes[passes.length - 1];
    if (run && run.hi === i - 1) run.hi = i;
    else passes.push({ lo: i, hi: i });
  }
  if (!passes.length) return null;
  for (const run of passes) {
    // largest single step inside the pass = the dwell (arrive just before it, leave just after)
    run.jump = run.lo;
    run.step = 0;
    for (let i = run.lo + 1; i <= run.hi; i++) {
      const step = tAt(i) - tAt(i - 1);
      if (step > run.step) { run.step = step; run.jump = i; }
    }
    // the vertex nearest to the stop in this pass
    run.best = run.lo;
    for (let i = run.lo; i <= run.hi; i++) if (ds[i] < ds[run.best]) run.best = i;
  }
  passes.sort((a, b) => tAt(a.lo) - tAt(b.lo));
  const visit = passes.find((r) => r.step >= DWELL_MIN_SHOWN) || passes[0];
  const hasDwell = visit.step >= DWELL_MIN_SHOWN;
  const best = visit.best;
  const tArrive = hasDwell ? tAt(visit.jump - 1) : tAt(best);
  const tLeave = hasDwell ? tAt(visit.jump) : tArrive;
  if (!Number.isFinite(tArrive)) return null;
  const dwell = hasDwell ? tLeave - tArrive : 0;
  const start = lmstToH(st.eva?.start_lmst);
  const lmstH = start != null ? start + tArrive / 60 / SOL_PER_DAY : null;
  const slope = Number(line.props?.slope_deg?.[best]);
  return {
    t_min: tArrive,
    dwell_min: dwell,
    leave_t_min: dwell ? tLeave : null,
    lmst_h: lmstH,
    temp_c: lmstH != null ? tempAt(st.weather, lmstH) : null,
    slope_deg: Number.isFinite(slope) ? slope : null,
  };
}

function fmtDuration(min) {
  const m = Math.round(min);
  return m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min` : `${m} min`;
}

function fmtCoord(coord) {
  if (!Array.isArray(coord) || coord.length < 2) return null;
  const [lon, lat] = coord.map(Number);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  return `${Math.abs(lat).toFixed(4)}°${lat < 0 ? 'S' : 'N'}, ${Math.abs(lon).toFixed(4)}°${lon < 0 ? 'W' : 'E'}`;
}

// contracts.md uses instrument codes (MAST_LEFT, NAV_LEFT_B, ...); show readable names.
const CAMERA_NAMES = [
  [/^MAST_/i, 'Mastcam'], [/^NAV_/i, 'Navcam'], [/^MAHLI/i, 'MAHLI'], [/^MARDI/i, 'MARDI'],
  [/^FHAZ_/i, 'Front Hazcam'], [/^RHAZ_/i, 'Rear Hazcam'], [/^CHEMCAM/i, 'ChemCam RMI'],
];
function cameraName(photo) {
  if (photo.camera_name) return photo.camera_name;
  const code = photo.camera || '';
  const hit = CAMERA_NAMES.find(([re]) => re.test(code));
  return hit ? hit[1] : code;
}

// Mastcam / MAHLI / MARDI are MSSS-operated; project rules require the MSSS credit.
function creditFor(photo) {
  if (photo.credit) return photo.credit;
  return /mastcam|mahli|mardi/i.test(cameraName(photo)) ? 'NASA/JPL-Caltech/MSSS' : DEFAULT_CREDIT;
}

function photoMeta(photo) {
  return [photo.sol != null ? `Sol ${photo.sol}` : null, cameraName(photo)].filter(Boolean).join(' · ');
}

// ------------------------------------------------------------ weather chart
function weatherChart(weather, eva, arrivalH = null) {
  const rows = (weather?.rows || [])
    .map((r) => ({ t: lmstToH(r.lmst), c: Number(r.temp_c) }))
    .filter((r) => r.t != null && Number.isFinite(r.c));
  if (rows.length < 2) return null;

  const W = 300, H = 100, L = 36, R = 8, T = 10, B = 20;
  const cs = rows.map((r) => r.c);
  const lo = Math.floor(Math.min(...cs) / 10) * 10;
  let hi = Math.ceil(Math.max(...cs) / 10) * 10 + 0; // +0 turns -0 into 0
  if (hi <= lo) hi = lo + 10;
  const x = (t) => L + (t / 24) * (W - L - R);
  const y = (c) => T + (1 - (c - lo) / (hi - lo)) * (H - T - B);

  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'mm-card__chart', role: 'img',
    'aria-label': `Air temperature over one sol, ${Math.min(...cs)} to ${Math.max(...cs)} °C` });

  // EVA window band
  const e0 = lmstToH(eva?.start_lmst), e1 = lmstToH(eva?.end_lmst);
  if (e0 != null && e1 != null && e1 > e0) {
    svg.append(s('rect', { x: x(e0), y: T, width: x(e1) - x(e0), height: H - T - B, class: 'mm-card__chart-eva' }));
    const lab = s('text', { x: (x(e0) + x(e1)) / 2, y: T + 12, class: 'mm-card__chart-evalabel', 'text-anchor': 'middle' });
    lab.textContent = 'EVA';
    svg.append(lab);
  }
  // arrival marker
  if (arrivalH != null) {
    const ax = x(((arrivalH % 24) + 24) % 24);
    svg.append(s('line', { x1: ax, x2: ax, y1: T, y2: H - B, class: 'mm-card__chart-arrival' }));
  }
  // grid + labels
  for (const c of [lo, (lo + hi) / 2, hi]) {
    svg.append(s('line', { x1: L, x2: W - R, y1: y(c), y2: y(c), class: 'mm-card__chart-grid' }));
    const t = s('text', { x: L - 4, y: y(c) + 3, 'text-anchor': 'end', class: 'mm-card__chart-tick' });
    t.textContent = `${Math.round(c)}°`;
    svg.append(t);
  }
  for (const hr of [0, 6, 12, 18, 24]) {
    const t = s('text', { x: x(hr), y: H - 4, 'text-anchor': 'middle', class: 'mm-card__chart-tick' });
    t.textContent = String(hr).padStart(2, '0');
    svg.append(t);
  }
  const d = rows.map((r, i) => `${i ? 'L' : 'M'}${x(r.t).toFixed(1)},${y(r.c).toFixed(1)}`).join('');
  // oxide -> oxide-text gradient along the curve; stop colours are set in cards.css
  const grad = s('linearGradient', { id: 'mm-chart-grad', x1: '0', y1: '0', x2: '1', y2: '0' });
  grad.append(s('stop', { offset: '0', class: 'mm-card__grad-a' }), s('stop', { offset: '1', class: 'mm-card__grad-b' }));
  const defs = s('defs');
  defs.append(grad);
  svg.prepend(defs);
  svg.append(s('path', { d, class: 'mm-card__chart-line' }));

  const minC = weather.min_c ?? Math.min(...cs);
  const maxC = weather.max_c ?? Math.max(...cs);
  return h('section', { class: 'mm-card__weather' },
    h('div', { class: 'mm-card__weather-head' },
      h('span', { class: 'mm-card__label' }, 'Air temperature over one Mars day'),
      weather.approximate ? h('span', { class: 'mm-card__tag', title: weather.method || '' }, 'approximate') : null),
    svg,
    h('p', { class: 'mm-card__weather-foot' },
      e0 != null && e1 != null ? 'Shaded: walk window. Dashed line: you arrive. ' : '',
      `${Math.round(minC)} °C to ${Math.round(maxC)} °C`,
      weather.source ? ` · ${weather.source}` : ''));
}

// ------------------------------------------------------------ briefing
const RADIATION_TEXT = {
  nominal: ['Normal', 'Background radiation only'],
  elevated: ['Elevated', 'A solar event reached Mars recently'],
  storm: ['Storm', 'Solar storm: stay near a shelter'],
};

const selectStop = (stop) => document.dispatchEvent(new CustomEvent('stop:select', { detail: stop }));

function briefingStat(value, label) {
  return h('div', { class: 'mm-card__stat' },
    h('span', { class: 'mm-card__stat-value' }, value), h('span', { class: 'mm-card__stat-label' }, label));
}

// Map symbols, drawn with the same base.css colours as the map (map/index.js, base.css).
function legendBlock(st) {
  const row = (cls, label, inner = null) => h('li', {}, h('span', { class: `mm-key mm-key--${cls}`, 'aria-hidden': 'true' }, inner), label);
  return h('section', { class: 'mm-brief__legend', 'aria-label': 'Map symbols' },
    h('span', { class: 'mm-card__label' }, 'On the map'),
    h('ul', {},
      Array.isArray(st.area?.habitat) ? row('habitat', 'Habitat: start and finish') : null,
      st.route ? row('route', 'Planned walking route') : null,
      Array.isArray(st.stops) && st.stops.length ? row('stop', 'Science stop (click it)', '1') : null,
      st.safety?.shelters?.length ? row('shelter', 'Shelter from radiation') : null,
      st.traverse ? row('traverse', "Curiosity rover's real path") : null));
}

function briefingView(st, onNav) {
  const sum = st.summary || {};
  const stops = Array.isArray(st.stops) ? st.stops.filter((x) => x && typeof x === 'object') : [];
  const rad = RADIATION_TEXT[st.radiation?.status] || null;
  const km = Number.isFinite(sum.distance_m) ? `${(sum.distance_m / 1000).toFixed(1)} km` : null;

  const stats = [
    km ? briefingStat(km, 'walking distance') : null,
    Number.isFinite(sum.duration_min) ? briefingStat(fmtDuration(sum.duration_min), 'outside, stops included') : null,
    Number.isFinite(sum.o2_used_pct) ? briefingStat(`${Math.round(sum.o2_used_pct)} %`, 'of the oxygen tank') : null,
    rad ? briefingStat(rad[0], 'radiation today') : null,
  ].filter(Boolean);

  const steps = [
    h('li', { class: 'mm-brief__step mm-brief__step--home' },
      h('span', { class: 'mm-key mm-key--habitat', 'aria-hidden': 'true' }),
      h('span', {}, h('b', {}, 'Leave the habitat'),
        st.eva?.start_lmst ? h('small', {}, `${st.eva.start_lmst} Mars local time`) : null)),
    ...stops.map((stop, i) => {
      let a = null;
      try { a = arrivalInfo(stop, st); } catch { /* no route: no time */ }
      return h('li', { class: 'mm-brief__step' },
        h('button', { class: 'mm-brief__stop', type: 'button', onclick: () => selectStop(stop) },
          h('span', { class: 'mm-key mm-key--stop', 'aria-hidden': 'true' }, String(i + 1)),
          h('span', {}, h('b', {}, stop.name || `Stop ${i + 1}`),
            a ? h('small', {}, `+${fmtDuration(a.t_min)} after leaving`) : null),
          h('span', { class: 'mm-brief__go', 'aria-hidden': 'true' }, '›')));
    }),
    h('li', { class: 'mm-brief__step mm-brief__step--home' },
      h('span', { class: 'mm-key mm-key--habitat', 'aria-hidden': 'true' }),
      h('span', {}, h('b', {}, 'Back home before the window closes'),
        st.eva?.end_lmst ? h('small', {}, `by ${st.eva.end_lmst} Mars local time`) : null)),
  ];

  const has3d = !document.getElementById('view3d-toggle')?.hidden;
  const tools = h('section', { class: 'mm-brief__tools', 'aria-label': 'Other views' },
    h('span', { class: 'mm-card__label' }, 'See it another way'),
    h('button', { class: 'mm-brief__tool', type: 'button', onclick: () => document.dispatchEvent(new CustomEvent('hud:toggle')) },
      h('b', {}, "Astronaut's visor"), h('small', {}, 'Live oxygen, dose and next stop. Press Play to walk; key H')),
    has3d ? h('button', { class: 'mm-brief__tool', type: 'button', onclick: () => document.dispatchEvent(new CustomEvent('view3d:toggle')) },
      h('b', {}, '3D terrain'), h('small', {}, 'Fly along the route over the real Mount Sharp terrain')) : null);

  return h('article', { class: 'mm-brief', 'aria-label': 'Mission briefing' },
    onNav ? h('button', { class: 'mm-card__back', type: 'button', onclick: onNav }, '‹ Route planner') : null,
    h('p', { class: 'mm-card__kicker' }, 'Mission briefing'),
    h('h2', { class: 'mm-card__title' }, 'Plan a safe walk on Mars'),
    h('p', { class: 'mm-brief__lead' },
      'An astronaut leaves the habitat in Gale crater, visits ', String(stops.length || 'a few'),
      ' science stops where the Curiosity rover has been, and must be back before oxygen, daylight or radiation run out.'),
    stats.length ? h('div', { class: 'mm-card__stats' }, stats) : null,
    rad && st.radiation?.status !== 'nominal' ? h('p', { class: 'mm-card__note' }, rad[1]) : null,
    stops.length ? h('button', { class: 'mm-brief__start', type: 'button', onclick: () => selectStop(stops[0]) }, 'Start the tour  →') : null,
    onNav && st.summary?.terrain?.png ? h('button', { class: 'mm-brief__nav', type: 'button', onclick: onNav },
      h('span', { class: 'mm-brief__nav-icon', 'aria-hidden': 'true' }, 'A→B'),
      h('span', {}, h('b', {}, 'Plan your own route'), h('small', {}, 'Pick a start and a destination: fastest and safest way'))) : null,
    h('section', { class: 'mm-brief__walk', 'aria-label': 'The walk, step by step' },
      h('span', { class: 'mm-card__label' }, 'The walk, step by step'),
      h('ol', {}, steps)),
    legendBlock(st),
    tools);
}

// ------------------------------------------------------------ card
export function initCards(state, el) {
  if (!el) {
    console.error('[cards] initCards: no container element');
    return { show() {}, hide() {} };
  }
  const st = state || {};

  let current = null; // {stop, photos, index}

  // While no stop is open, #cards shows the mission briefing instead of the card.
  const card = h('article', { class: 'mm-card', 'aria-live': 'polite', tabindex: '-1' });
  const isOpen = () => card.isConnected;
  const stops = () => (Array.isArray(st.stops) ? st.stops : []);
  let brief = null;
  let nav = null;            // navigation view (nav.js), created on first use
  const navOpen = () => !!nav?.el.isConnected;

  function showNav() {
    try {
      nav ||= createNav(st, { onBriefing: () => showBriefing(), onActivate: () => { if (!navOpen()) showNav(); } });
      card.remove();
      current = null;
      el.replaceChildren(nav.el);
      nav.open();
      el.scrollTop = 0;
    } catch (err) {
      console.error('[cards] navigation failed', err);
    }
  }

  function showBriefing() {
    if (navOpen()) nav.close();
    try {
      brief = briefingView(st, showNav);
      el.replaceChildren(brief);
      el.scrollTop = 0;
    } catch (err) {
      console.error('[cards] briefing failed', err);
      el.replaceChildren(); // falls back to base.css's "Select a stop" hint
    }
  }

  // closing a stop card (or the briefing) goes back to the route planner, the main view
  function hide() {
    card.remove();
    current = null;
    showNav();
  }

  // index of the open stop in stops.json order (= the number on the map)
  function stopIndex(stop) {
    return stops().findIndex((x) => x === stop || (x?.id != null && x.id === stop?.id));
  }

  function tourNav() {
    const i = stopIndex(current.stop);
    if (i < 0) return null;
    const next = stops()[i + 1];
    return h('nav', { class: 'mm-card__tour', 'aria-label': 'Tour' },
      i > 0 ? h('button', { class: 'mm-card__tour-btn', type: 'button', onclick: () => selectStop(stops()[i - 1]) },
        h('small', {}, '‹ Previous'), h('b', {}, stops()[i - 1].name || `Stop ${i}`)) : h('span'),
      next
        ? h('button', { class: 'mm-card__tour-btn mm-card__tour-btn--next', type: 'button', onclick: () => selectStop(next) },
          h('small', {}, 'Next stop ›'), h('b', {}, next.name || `Stop ${i + 2}`))
        : h('button', { class: 'mm-card__tour-btn mm-card__tour-btn--next', type: 'button', onclick: hide },
          h('small', {}, 'Tour done ›'), h('b', {}, 'Back to the route planner')));
  }

  function setPhoto(i) {
    if (!current || !current.photos.length) return;
    const n = current.photos.length;
    current.index = ((i % n) + n) % n;
    render();
  }

  function photoBlock() {
    const { photos, index } = current;
    if (!photos.length) {
      return h('div', { class: 'mm-card__nophoto' }, 'No Curiosity photos linked to this stop yet.');
    }
    const p = photos[index];
    const img = h('img', {
      class: 'mm-card__img', src: p.url, alt: `${photoMeta(p) || 'Curiosity image'} near ${current.stop.name || 'this stop'}`,
      loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer',
    });
    const frame = h('a', { class: 'mm-card__frame', href: p.url, target: '_blank', rel: 'noopener', title: 'Open full image' }, img);
    img.addEventListener('error', () => {
      console.error('[cards] image failed to load:', p.url);
      frame.replaceChildren(h('div', { class: 'mm-card__nophoto' }, 'Image unavailable'));
    });

    const nav = photos.length > 1 ? [
      h('button', { class: 'mm-card__nav mm-card__nav--prev', type: 'button', 'aria-label': 'Previous photo', onclick: () => setPhoto(index - 1) }, '‹'),
      h('button', { class: 'mm-card__nav mm-card__nav--next', type: 'button', 'aria-label': 'Next photo', onclick: () => setPhoto(index + 1) }, '›'),
    ] : [];

    const thumbs = photos.length > 1 ? h('div', { class: 'mm-card__thumbs', role: 'tablist' },
      photos.map((q, i) => h('button', {
        class: 'mm-card__thumb' + (i === index ? ' is-active' : ''), type: 'button', role: 'tab',
        'aria-selected': i === index ? 'true' : 'false', 'aria-label': photoMeta(q) || `Photo ${i + 1}`,
        onclick: () => setPhoto(i),
      }, h('img', { src: q.url, alt: '', loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer' })))) : null;

    return h('figure', { class: 'mm-card__figure' },
      current.nearby ? h('p', { class: 'mm-card__note' }, 'Photos Curiosity took near this stop') : null,
      h('div', { class: 'mm-card__stage' }, frame, ...nav),
      h('figcaption', { class: 'mm-card__caption' },
        h('span', { class: 'mm-card__meta' }, photoMeta(p), photos.length > 1 ? `  ${index + 1}/${photos.length}` : ''),
        p.distance_m != null ? h('span', { class: 'mm-card__dist' }, `≈${Math.round(p.distance_m)} m from this stop`) : null,
        h('span', { class: 'mm-card__credit' }, `Image: ${creditFor(p)}`)),
      thumbs);
  }

  function arrivalBlock(a) {
    if (!a) return null;
    const stat = (value, label) => h('div', { class: 'mm-card__stat' },
      h('span', { class: 'mm-card__stat-value' }, value), h('span', { class: 'mm-card__stat-label' }, label));
    return h('section', { class: 'mm-card__arrival', 'aria-label': 'Arrival at this stop' },
      h('span', { class: 'mm-card__label' }, 'When you get here'),
      h('div', { class: 'mm-card__stats' },
        stat(a.t_min < 0.5 ? 'Start' : `+${fmtDuration(a.t_min)}`, 'after leaving the habitat'),
        a.lmst_h != null ? stat(hToLmst(a.lmst_h), 'Mars local time (LMST)') : null,
        a.temp_c != null ? stat(`${Math.round(a.temp_c)} °C`, 'air temperature') : null,
        a.slope_deg != null ? stat(`${Math.round(a.slope_deg)}°`, 'ground slope') : null),
      a.dwell_min ? h('p', { class: 'mm-card__note mm-card__dwell' },
        `${fmtDuration(a.dwell_min)} at this stop, leave at +${fmtDuration(a.leave_t_min)}`) : null);
  }

  function render() {
    if (!current) return;
    const { stop } = current;
    const coord = fmtCoord(stop.coord);
    let arrival = null;
    try { arrival = arrivalInfo(stop, st); } catch (err) { console.error('[cards] arrival failed', err); }
    // replaceChildren() would print "null" for missing blocks, so drop them first
    const idx = stopIndex(stop);
    card.replaceChildren(...[
      h('button', { class: 'mm-card__back', type: 'button', onclick: hide }, '‹ Route planner'),
      h('header', { class: 'mm-card__head' },
        h('div', {},
          h('p', { class: 'mm-card__kicker' }, idx >= 0 ? `Stop ${idx + 1} of ${stops().length}` : 'Stop'),
          h('h2', { class: 'mm-card__title' }, stop.name || 'Unnamed stop'),
          coord ? h('p', { class: 'mm-card__coord' }, coord) : null),
        h('button', { class: 'mm-card__close', type: 'button', 'aria-label': 'Close card and show the route planner', onclick: hide }, '×')),
      arrivalBlock(arrival),
      photoBlock(),
      stop.science ? h('section', { class: 'mm-card__science' },
        h('span', { class: 'mm-card__label' }, 'Science'),
        h('p', {}, stop.science)) : null,
      weatherChart(st.weather, st.eva, arrival?.lmst_h ?? null),
      tourNav(),
    ].filter(Boolean));
  }

  function show(stop) {
    if (!stop || typeof stop !== 'object') {
      console.error('[cards] stop:select without a stop object', stop);
      return;
    }
    let photos = (Array.isArray(stop.photos) ? stop.photos : []).filter((p) => p && p.url);
    let nearby = false;
    if (!photos.length) {
      photos = nearbyPhotos(stop, st.images);
      nearby = photos.length > 0;
    }
    if (navOpen()) nav.close();
    const sameStop = current && current.stop.id === stop.id && stop.id != null;
    current = { stop, photos, nearby, index: sameStop ? Math.min(current.index, Math.max(0, photos.length - 1)) : 0 };
    try {
      render();
      if (!isOpen()) el.replaceChildren(card);
      el.scrollTop = 0;
    } catch (err) {
      console.error('[cards] render failed', err);
    }
  }

  showNav();
  // the 3D button appears only once that module has started: refresh the shortcuts then
  const b3d = document.getElementById('view3d-toggle');
  if (b3d) {
    new MutationObserver(() => {
      if (navOpen()) nav.open();
      else if (!isOpen() && brief?.isConnected) showBriefing();
    }).observe(b3d, { attributes: true, attributeFilter: ['hidden'] });
  }

  document.addEventListener('stop:select', (ev) => show(ev.detail));
  document.addEventListener('keydown', (ev) => {
    if (!isOpen() || ev.defaultPrevented) return;
    const t = ev.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    if (ev.key === 'Escape') hide();
    else if (ev.key === 'ArrowLeft') setPhoto((current?.index ?? 0) - 1);
    else if (ev.key === 'ArrowRight') setPhoto((current?.index ?? 0) + 1);
  });

  return { show, hide };
}
