// Route planner inside #cards (Egemen): the app's main view. A start (default: the habitat)
// and a destination, both any point on the map; the fastest, the safest and an alternative
// route are computed in the browser from the DEM (router.js, same walking model as arazi/).
//
// Events out: nav:pick   {which: 'start'|'end'}            next map / 3D click sets this point
//             nav:routes {start, end, roundTrip, options[], chosen}   routes to draw (map, 3D)
//             nav:choose {id}                               the option the user picked
//             nav:clear                                     no destination any more
// Events in : nav:point  {which, coord: [lon, lat]}          a clicked or dragged point (map, 3D)
//             nav:choose {id}                               an alternative clicked on the map
// The planned route (route.geojson) is never changed; these are extra routes.

import { buildGrid, planRoutes, missionValue } from './router.js';

const OPTION_COLOR = { fastest: 'fast', safest: 'safe', alternative: 'alt' }; // .mm-nav__key--*
const RECOMMENDED = 'safest';

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
  }
  el.append(...kids.flat().filter((x) => x != null && x !== false));
  return el;
}

const emit = (name, detail) => document.dispatchEvent(new CustomEvent(name, { detail }));

function fmtDuration(min) {
  const hh = Math.floor(min / 60); const mm = Math.round(min % 60);
  return hh ? `${hh} h ${String(mm).padStart(2, '0')} min` : `${mm} min`;
}
const fmtKm = (m) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`);
const fmtLL = ([lon, lat]) => `${Math.abs(lat).toFixed(4)}°${lat < 0 ? 'S' : 'N'} ${lon.toFixed(4)}°E`;

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`image failed: ${url}`));
    img.src = url;
  });
}

// Heightmap pixels + radio-shadow mask on the same grid -> router grid
async function loadGrid(st) {
  const t = st.summary?.terrain;
  if (!t?.png) throw new Error('No DEM heightmap (summary.terrain) yet');
  const img = await loadImage(t.png);
  const W = img.naturalWidth; const H = img.naturalHeight;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, W, H).data;

  let shadow = null;
  const ov = (st.safety?.overlays || []).find((o) => o?.id === 'comm_shadow' && o.png && o.bounds);
  if (ov) {
    try {
      const sImg = await loadImage(ov.png);
      ctx.clearRect(0, 0, W, H);
      ctx.imageSmoothingEnabled = false;
      const b = t.bounds; const ob = ov.bounds;
      const sx = (W - 1) / (b.east - b.west); const sy = (H - 1) / (b.north - b.south);
      ctx.drawImage(sImg, (ob.west - b.west) * sx, (b.north - ob.north) * sy,
        (ob.east - ob.west) * sx + 1, (ob.north - ob.south) * sy + 1);
      const px = ctx.getImageData(0, 0, W, H).data;
      shadow = new Uint8Array(W * H);
      for (let k = 0; k < shadow.length; k++) shadow[k] = px[k * 4 + 3] > 0 ? 1 : 0;
    } catch (err) {
      console.warn(`[cards] nav: radio shadow not used (${err.message})`);
    }
  }
  return buildGrid({ width: W, height: H, data }, t, shadow, st);
}

// Suggestions in the From / To lists: the habitat and the shelters (safety.json)
function places(st) {
  const list = [];
  if (Array.isArray(st.area?.habitat)) list.push({ id: 'habitat', name: 'Habitat', coord: st.area.habitat });
  (st.safety?.shelters || []).forEach((s, i) => {
    if (Array.isArray(s?.coord)) list.push({ id: `shelter:${i}`, name: `Shelter ${i + 1}`, coord: s.coord });
  });
  return list;
}

const ICON_PICK = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M12 2a7 7 0 0 0-7 7c0 5 7 13 7 13s7-8 7-13a7 7 0 0 0-7-7zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5z" fill="currentColor"/></svg>';

export function createNav(st, { onBriefing, onActivate } = {}) {
  const el = h('article', { class: 'mm-nav', 'aria-label': 'Route planner' });
  const base = places(st);
  const point = { start: base[0]?.coord || null, end: null };   // [lon, lat]
  const label = { start: base[0]?.name || null, end: null };
  let roundTrip = true;
  let grid = null; let gridLoading = null;
  let result = null; let chosen = null; let busy = false; let picking = null; let error = null;
  let runId = 0;

  function nameFor(coord) {
    const hit = base.find((p) => p.coord[0] === coord[0] && p.coord[1] === coord[1]);
    return hit ? hit.name : fmtLL(coord);
  }

  function broadcast() {
    emit('nav:routes', { start: point.start, end: point.end, roundTrip, options: result?.options || [], chosen });
  }

  async function compute() {
    const id = ++runId;
    result = null; chosen = null; error = null;
    if (!point.start || !point.end) {
      busy = false;
      if (!point.end) emit('nav:clear');
      broadcast();
      render();
      return;
    }
    busy = true; render();
    broadcast();   // pins first, routes when ready
    try {
      if (!grid) grid = await (gridLoading ||= loadGrid(st));
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));   // let "Finding routes…" paint
      if (id !== runId) return;
      const res = planRoutes(grid, point.start, point.end, st, { roundTrip });
      if (res.error) error = res.error;
      else {
        result = { options: res.options };
        chosen = res.options.find((o) => o.id === RECOMMENDED)?.id || res.options[0]?.id || null;
      }
    } catch (err) {
      console.error('[cards] route planner failed', err);
      error = 'Routes are not available: the elevation data could not be loaded.';
      gridLoading = null;
    }
    if (id !== runId) return;
    busy = false;
    broadcast();
    render();
  }

  function setPoint(which, coord, name = null) {
    point[which] = coord;
    label[which] = coord ? name || nameFor(coord) : null;
    compute();
  }

  function pick(which) {
    picking = picking === which ? null : which;
    emit(picking ? 'nav:pick' : 'nav:cancel', picking ? { which } : undefined);
    render();
  }

  function clearDestination() {
    picking = null;
    emit('nav:cancel');
    setPoint('end', null);
  }

  // a click / drag on the map or in 3D
  document.addEventListener('nav:point', (e) => {
    const { which, coord } = e.detail || {};
    if (!(which === 'start' || which === 'end') || !Array.isArray(coord)) return;
    picking = null;
    onActivate?.();
    setPoint(which, coord);
  });
  document.addEventListener('nav:cancel', () => { if (picking) { picking = null; render(); } });
  document.addEventListener('nav:choose', (e) => {
    const id = e.detail?.id;
    if (!id || id === chosen || !result?.options.some((o) => o.id === id)) return;
    chosen = id;
    render();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || e.defaultPrevented || document.body.dataset.mode === 'hud') return;
    const t = e.target;
    if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
    if (picking) { picking = null; emit('nav:cancel'); render(); return; }
    if (point.end && el.isConnected) clearDestination();
  });

  function choose(id) {
    chosen = id;
    emit('nav:choose', { id });
    render();
  }

  // ---------------------------------------------------------------- view
  function field(which) {
    const letter = which === 'start' ? 'A' : 'B';
    const value = point[which] ? label[which] : null;
    const list = h('select', {
      class: 'mm-nav__suggest', 'aria-label': `Suggestions for ${which === 'start' ? 'the start' : 'the destination'}`,
      onchange: (e) => {
        const p = base.find((x) => x.id === e.target.value);
        if (p) setPoint(which, p.coord, p.name);
        e.target.value = '';
      },
    }, h('option', { value: '' }, 'Shelters…'), base.map((p) => h('option', { value: p.id }, p.name)));
    return h('div', { class: `mm-nav__row${picking === which ? ' is-picking' : ''}` },
      h('span', { class: `mm-nav__pin mm-nav__pin--${which}`, 'aria-hidden': 'true' }, letter),
      h('div', { class: 'mm-nav__field' },
        h('small', {}, which === 'start' ? 'From' : 'To'),
        h('span', { class: value ? 'mm-nav__value' : 'mm-nav__value is-empty' },
          picking === which ? 'Click the map…' : value || 'Click anywhere on the map')),
      list,
      h('button', {
        class: 'mm-nav__icon' + (picking === which ? ' is-on' : ''), type: 'button',
        'aria-pressed': String(picking === which),
        title: `Choose ${which === 'start' ? 'the start' : 'the destination'} on the map`,
        'aria-label': `Choose ${which === 'start' ? 'the start' : 'the destination'} on the map`,
        onclick: () => pick(which),
      }, svg(ICON_PICK)));
  }

  function stat(value, name, cls = '') {
    return h('div', { class: `mm-nav__stat ${cls}` }, h('b', {}, value), h('small', {}, name));
  }

  function badges(o) {
    const s = o.summary;
    const list = [];
    const reserve = missionValue(st, 'o2_reserve_pct');
    if (s.o2_used_pct != null && 100 - s.o2_used_pct < reserve) list.push(['bad', `O₂ below ${reserve} % reserve`]);
    if (s.steep_m > 0) list.push(['warn', `Steep ground ${fmtKm(s.steep_m)}`]);
    if (s.comm_off_min > 0) list.push(['warn', `No radio ${s.comm_off_min} min`]);
    else list.push(['ok', 'Radio link all the way']);
    for (const w of o.warnings) if (/EVA limit/.test(w)) list.push(['bad', w]);
    return h('div', { class: 'mm-nav__badges' }, list.map(([k, t]) => h('span', { class: `mm-nav__badge is-${k}` }, t)));
  }

  function optionRow(o) {
    const s = o.summary;
    const on = o.id === chosen;
    return h('li', {},
      h('button', {
        class: `mm-nav__opt${on ? ' is-on' : ''}`, type: 'button', 'aria-pressed': String(on), onclick: () => choose(o.id),
      },
      h('span', { class: `mm-nav__key mm-nav__key--${OPTION_COLOR[o.id] || 'alt'}`, 'aria-hidden': 'true' }),
      h('span', { class: 'mm-nav__opt-name' }, h('b', {}, o.label), h('small', {}, o.note)),
      h('span', { class: 'mm-nav__opt-time' }, h('b', {}, fmtDuration(s.duration_min)), h('small', {}, fmtKm(s.distance_m)))));
  }

  function summaryBlock() {
    const o = result.options.find((x) => x.id === chosen);
    if (!o) return null;
    const s = o.summary;
    return h('section', { class: 'mm-nav__sum', 'aria-label': `${o.label} route` },
      h('div', { class: 'mm-nav__stats' },
        stat(fmtKm(s.distance_m), 'distance'),
        stat(fmtDuration(s.duration_min), 'duration'),
        s.o2_used_pct != null ? stat(`${Math.round(s.o2_used_pct)} %`, s.o2_exact ? 'O₂ used' : 'O₂ used (est.)') : null,
        stat(`${s.dose_mSv.toFixed(2)} mSv`, 'radiation dose'),
        stat(`${Math.round(s.max_slope_deg)}°`, 'max slope', s.max_slope_deg > missionValue(st, 'slope_warn_deg') ? 'is-warn' : '')),
      badges(o));
  }

  function statusBlock() {
    if (busy) {
      return h('div', { class: 'mm-nav__loading', role: 'status' },
        h('span', {}, 'Finding routes on the DEM…'), h('i'), h('i'), h('i'));
    }
    if (error) return h('p', { class: 'mm-nav__status is-bad', role: 'alert' }, error);
    if (!point.end) {
      return h('div', { class: 'mm-nav__empty' },
        h('b', {}, 'Where do you want to walk?'),
        h('span', {}, 'Click any point on the map. Drag the pins to adjust, Esc clears.'));
    }
    return null;
  }

  function render() {
    const has3d = !document.getElementById('view3d-toggle')?.hidden;
    el.replaceChildren(...[
      h('header', { class: 'mm-nav__head' },
        h('h2', { class: 'mm-nav__title' }, 'Route planner'),
        point.end ? h('button', { class: 'mm-nav__clear', type: 'button', onclick: clearDestination, title: 'Clear the destination (Esc)' }, 'Clear') : null),
      h('div', { class: 'mm-nav__form' },
        field('start'),
        h('button', {
          class: 'mm-nav__swap', type: 'button', 'aria-label': 'Swap start and destination', title: 'Swap start and destination',
          disabled: !point.end,
          onclick: () => {
            [point.start, point.end] = [point.end, point.start];
            [label.start, label.end] = [label.end, label.start];
            compute();
          },
        }, '⇅'),
        field('end'),
        h('label', { class: 'mm-nav__check' },
          h('input', { type: 'checkbox', checked: roundTrip, onchange: (e) => { roundTrip = e.target.checked; compute(); } }),
          'Round trip: come back to the start')),
      statusBlock(),
      result ? h('ol', { class: 'mm-nav__opts', 'aria-label': 'Route options' }, result.options.map(optionRow)) : null,
      result ? summaryBlock() : null,
      result && has3d ? h('button', {
        class: 'mm-nav__go', type: 'button',
        onclick: () => { if (document.getElementById('view3d-root')?.hidden) emit('view3d:toggle'); emit('nav:choose', { id: chosen }); },
      }, 'Fly over it in 3D') : null,
      h('footer', { class: 'mm-nav__foot' },
        h('p', {},
          'Routes are computed in your browser from the USGS 1 m DEM (4.6 m grid): walking speed from slope, ',
          `nothing steeper than ${missionValue(st, 'slope_max_deg')}°, radio shadow from the habitat antenna.`),
        onBriefing ? h('button', { class: 'mm-nav__link', type: 'button', onclick: onBriefing }, 'About this walk and the science stops') : null),
    ].filter(Boolean));
  }

  return {
    el,
    open() { render(); broadcast(); },
    close() { if (picking) { picking = null; emit('nav:cancel'); } },
  };
}

function svg(markup) {
  const t = document.createElement('template');
  t.innerHTML = markup;
  return t.content.firstChild;
}
