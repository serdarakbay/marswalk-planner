// landing/main.js (Ege): landing page. Every number on the page comes from web/data/;
// a missing file or field hides that number instead of breaking the page.

const FILES = {
  summary: 'data/summary.json',
  safety: 'data/safety/safety.json',
  eva: 'data/eva_window.json',
  radiation: 'data/radiation.json',
  sun: 'data/sun.json',
  stops: 'data/stops.json',
  overlays: 'data/overlays.json',
  layers: 'data/layers.json',
  route: 'data/route.geojson',
  area: 'data/area.json',
  mission: 'data/mission.json', // copied from config/ at deploy time
};

async function loadJSON(url) {
  try {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.warn(`[landing] ${url}: ${err.message}`);
    return null;
  }
}

const num = (v) => Number.isFinite(v);
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else node.setAttribute(k, v);
  }
  node.append(...children.filter((c) => c !== null && c !== undefined && c !== false && c !== ''));
  return node;
}

function fmtDuration(min) {
  const hh = Math.floor(min / 60);
  const mm = Math.round(min % 60);
  return hh ? [`${hh}`, 'h', ` ${String(mm).padStart(2, '0')}`, 'min'] : [`${mm}`, 'min'];
}

function fmtDate(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

// Row of sun.json closest to a UTC time
function sunAt(sun, utc) {
  const rows = sun?.rows;
  if (!Array.isArray(rows) || !rows.length) return null;
  const t = Date.parse(utc);
  if (Number.isNaN(t)) return rows[0];
  return rows.reduce((best, r) => (Math.abs(Date.parse(r.utc) - t) < Math.abs(Date.parse(best.utc) - t) ? r : best), rows[0]);
}

// ---- Header: status strip ----
function renderStatus(d) {
  const strip = document.getElementById('status-strip');
  const items = [];
  if (d.eva?.start_lmst && d.eva?.end_lmst) {
    items.push(h('li', {}, h('span', { class: 'status-label', text: 'EVA window' }),
      h('span', { class: 'status-value', text: `${d.eva.start_lmst}–${d.eva.end_lmst} LMST` })));
  }
  if (d.radiation?.status) {
    const s = d.radiation.status;
    items.push(h('li', { title: d.radiation.message || null },
      h('span', { class: 'status-label', text: 'Radiation' }),
      h('span', { class: `status-dot is-${s}`, 'aria-hidden': 'true' }),
      h('span', { class: 'status-value', text: s })));
  }
  const row = sunAt(d.sun, d.eva?.start_utc);
  if (num(row?.light_time_min)) {
    items.push(h('li', {}, h('span', { class: 'status-label', text: 'Earth delay' }),
      h('span', { class: 'status-value is-earth', text: `${row.light_time_min.toFixed(1)} min one-way` })));
  }
  strip.replaceChildren(...items);
}

// ---- Hero ----
function figure(label, parts) {
  const dd = h('dd');
  for (let i = 0; i < parts.length; i += 2) {
    dd.append(parts[i]);
    if (parts[i + 1]) dd.append(h('small', { text: parts[i + 1] }));
  }
  return h('div', {}, h('dt', { text: label }), dd);
}

function renderHero(d) {
  const s = d.summary || {};
  const list = document.getElementById('hero-figures');
  const items = [];
  if (num(s.distance_m)) items.push(figure('Route length', [(s.distance_m / 1000).toFixed(2), 'km']));
  if (num(s.duration_min)) items.push(figure('Walk duration', fmtDuration(s.duration_min)));
  if (num(s.o2_used_pct)) items.push(figure('Oxygen used', [s.o2_used_pct.toFixed(1), '%']));
  if (num(s.max_slope_deg)) items.push(figure('Steepest slope', [s.max_slope_deg.toFixed(1), '°']));
  list.replaceChildren(...items);

  const b = d.area?.bbox;
  if (b) {
    const lat = (b.north + b.south) / 2;
    const lon = (b.east + b.west) / 2;
    document.getElementById('coord-tag').textContent =
      `${Math.abs(lat).toFixed(2)}°${lat < 0 ? 'S' : 'N'} ${lon.toFixed(2)}°E · Gale Crater · Mount Sharp foothills`;
  }
}

// ---- Plate 01: stops ----
function renderStops(d) {
  const list = document.getElementById('stops');
  if (!Array.isArray(d.stops) || !d.stops.length) { list.closest('.walk').hidden = true; return; }
  list.replaceChildren(...d.stops.map((stop, i) => {
    const science = stop.science || '';
    const questions = science.match(/[^.?!]*\?/g)?.map((q) => q.trim()).join(' ') || science;
    const m = science.match(/sol (\d+) \((\d{4}-\d{2}-\d{2})\)/);
    const photo = (stop.photos || []).find((p) => p.camera === 'MAST_LEFT') || (stop.photos || [])[0];
    const sol = m ? m[1] : photo?.sol;
    const meta = [sol ? `Sol ${sol}` : null, m ? fmtDate(m[2]) : null].filter(Boolean).join(' · ');
    return h('li', { class: 'stop' },
      h('span', { class: 'stop-badge', text: String(i + 1), 'aria-hidden': 'true' }),
      h('h3', { text: stop.name || stop.id }),
      h('p', { class: 'stop-question', text: questions }),
      meta ? h('p', { class: 'stop-meta', text: `Curiosity was here · ${meta}` }) : null,
      photo ? h('figure', {},
        h('img', {
          src: photo.url, loading: 'lazy', width: 640, height: 480,
          alt: `Curiosity ${photo.camera} image at ${stop.name}, sol ${photo.sol}`,
        }),
        h('figcaption', { text: `${photo.camera.replace('_', ' ')}, sol ${photo.sol}. ${photo.credit || 'NASA/JPL-Caltech'}` })) : null);
  }));
}

// ---- Plate 02: safety legend with small data-shaped drawings ----
const SVG_NS = 'http://www.w3.org/2000/svg';
function svg(viewBox, inner) {
  const el = document.createElementNS(SVG_NS, 'svg');
  el.setAttribute('viewBox', viewBox);
  el.setAttribute('class', 'legend-map');
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = inner;
  return el;
}

function legendItem(title, drawing, text, figureText, keys) {
  return h('div', { class: 'legend-item' }, drawing,
    h('div', {},
      h('dt', { text: title }),
      h('dd', {}, text,
        figureText ? h('span', { class: 'legend-figure', text: figureText }) : null,
        keys?.length ? h('ul', { class: 'legend-keys' }, ...keys.map((k) => {
          const swatch = h('i', { 'aria-hidden': 'true' });
          swatch.style.background = k.color;
          return h('li', {}, swatch, k.label);
        })) : null)));
}

function renderLegend(d) {
  const legend = document.getElementById('legend');
  const items = [];
  const ov = (id) => (d.overlays || []).find((o) => o.id === id);

  const slope = ov('slope');
  if (slope?.legend?.length) {
    const c = slope.legend.map((k) => k.color);
    items.push(legendItem('Slope classes',
      svg('0 0 120 90', `<path d="M0 90 L0 70 Q30 64 50 48 T90 20 L120 14 L120 90Z" fill="${c[0]}" opacity=".55"/>
        <path d="M44 52 Q62 38 80 26 L96 18 L120 14 L120 40 Q96 44 70 60Z" fill="${c[1] || c[0]}" opacity=".7"/>
        <path d="M82 24 L120 14 L120 28 Q104 28 90 34Z" fill="${c[2] || c[1] || c[0]}" opacity=".85"/>
        <path d="M0 70 Q30 64 50 48 T90 20 L120 14" fill="none" stroke="var(--ink)" stroke-width="1.2"/>`),
      'The route avoids anything steeper than the limit and slows down on the middle band.',
      null, slope.legend));
  }

  const rings = ov('return_time');
  if (rings?.legend?.length) {
    const timed = rings.legend.filter((k) => /\d/.test(k.label));
    const step = timed[0]?.label.match(/[–-]\s*(\d+)\s*min/)?.[1];
    const n = Math.min(timed.length, 5);
    let circles = '';
    for (let i = n; i >= 1; i--) circles += `<circle cx="60" cy="45" r="${i * 8}" fill="none" stroke="var(--oxide)" stroke-width="1" opacity="${0.3 + 0.12 * (n - i)}"/>`;
    items.push(legendItem('Return rings',
      svg('0 0 120 90', `${circles}<rect x="55" y="40" width="10" height="10" fill="var(--oxide)"/>`),
      'How long it takes to walk back to the habitat from anywhere, with the oxygen that costs.',
      step ? `Rings every ${step} min` : null,
      rings.legend.slice(0, 3)));
  }

  const route = d.safety?.route;
  if (num(d.safety?.offline_min) || Array.isArray(route)) {
    const off = Array.isArray(route) && route.length ? Math.round((route.filter((r) => r.comm_ok === false).length / route.length) * 100) : null;
    const parts = [num(d.safety?.offline_min) ? `${d.safety.offline_min.toFixed(1)} min without a link` : null, num(off) ? `${off}% of the route` : null].filter(Boolean);
    items.push(legendItem('Radio shadow',
      svg('0 0 120 90', `<path d="M0 90 L0 66 L34 62 L58 30 L76 56 L120 60 L120 90Z" fill="var(--sand)" stroke="var(--ink)" stroke-width="1.2"/>
        <line x1="14" y1="62" x2="14" y2="44" stroke="var(--ink)" stroke-width="1.5"/>
        <path d="M14 44 L58 30" stroke="var(--dusk)" stroke-width="1.4"/>
        <path d="M58 30 L100 52" stroke="var(--storm)" stroke-width="1.4" stroke-dasharray="3 3"/>
        <circle cx="100" cy="56" r="3" fill="var(--storm)"/>`),
      'Where the ridge blocks the line of sight between the suit antenna and the habitat.',
      parts.join(' · ') || null));
  }

  const shelters = d.safety?.shelters;
  if (Array.isArray(shelters) && shelters.length) {
    const svf = shelters.map((s) => s.svf).filter(num);
    let dots = '';
    shelters.slice(0, 6).forEach((s, i) => {
      dots += `<circle cx="${18 + i * 18}" cy="${30 + ((i * 23) % 40)}" r="4" fill="var(--clay)" stroke="var(--ink)" stroke-width="1"/>`;
    });
    items.push(legendItem('Shelters',
      svg('0 0 120 90', `<path d="M8 80 C30 60, 50 70, 70 44 S104 26, 114 12" fill="none" stroke="var(--oxide)" stroke-width="1.6"/>${dots}`),
      'Spots where the terrain blocks most of the sky. A lower sky-view factor means better cover from a solar storm.',
      [`${shelters.length} shelters`, svf.length ? `sky-view ${Math.min(...svf).toFixed(2)}–${Math.max(...svf).toFixed(2)}` : null].filter(Boolean).join(' · ')));
  }

  legend.replaceChildren(...items);
  if (!items.length) legend.closest('section').hidden = true;
}

// ---- Plate 03: the storm ----
function renderStorm(d) {
  const r = d.radiation?.replay;
  const body = document.getElementById('storm-body');
  if (!r) { document.getElementById('gauge').hidden = true; return; }
  if (r.date) document.getElementById('storm-date').textContent = fmtDate(r.date);
  if (num(r.event_dose_mGy) && num(r.background_mGy_per_day) && num(r.event_multiplier)) {
    document.getElementById('gauge-base-value').textContent = `${r.background_mGy_per_day} mGy`;
    document.getElementById('gauge-event-value').textContent = `${r.event_dose_mGy} mGy`;
    document.getElementById('gauge-note').textContent =
      `Absorbed dose measured by Curiosity's RAD: the storm day was ${r.event_multiplier} times a normal day. We keep it in mGy (absorbed dose) and do not convert it to mSv.`;
    const base = document.getElementById('gauge-base');
    const event = document.getElementById('gauge-event');
    const fill = () => {
      base.style.width = `${Math.max(1.5, 100 / r.event_multiplier)}%`;
      event.style.width = '100%';
    };
    if (reduceMotion) fill();
    else {
      const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) { fill(); io.disconnect(); } }, { threshold: 0.4 });
      io.observe(body);
    }
  } else {
    document.getElementById('gauge').hidden = true;
  }
}

// ---- Plate 05: sources ----
function renderSources(d) {
  const m = d.mission || {};
  const rad = num(m.rad_base_mSv_per_day) ? m.rad_base_mSv_per_day : d.radiation?.base_mSv_per_day;
  const rows = [
    ['Walking speed: Tobler’s hiking function', null, 'sourced', 'Fastest on a gentle downhill, slower with every step of grade.'],
    ['Suit speed factor', num(m.suit_speed_factor) ? `× ${m.suit_speed_factor}` : null, 'assumed', 'A suited astronaut walks at this share of Tobler’s speed.'],
    ['Metabolic rate: Pandolf load-carriage equation', null, 'sourced', 'Energy cost of walking with a load, on a grade, over rough ground.'],
    ['Scaled to Mars gravity', num(m.gravity_m_s2) ? `${m.gravity_m_s2} m/s²` : null, 'assumed', 'The load and movement terms are scaled from Earth to Mars gravity: a first-order simplification.'],
    ['Body and suit mass', num(m.body_mass_kg) && num(m.suit_load_kg) ? `${m.body_mass_kg} kg + ${m.suit_load_kg} kg` : null, 'assumed', 'A typical adult astronaut and a suit in the range of the Apollo suit with its backpack.'],
    ['Energy per litre of oxygen', num(m.o2_kj_per_l) ? `1 L O₂ ≈ ${m.o2_kj_per_l} kJ` : null, 'sourced', 'The standard indirect-calorimetry value.'],
    ['Oxygen tank size', null, 'derived', num(m.eva_nominal_hours) && num(m.o2_reserve_pct)
      ? `Set so that ${m.eva_nominal_hours} h of flat walking uses everything except the ${m.o2_reserve_pct}% reserve.`
      : 'Calibrated from the nominal EVA length and the reserve.'],
    ['Oxygen reserve', num(m.o2_reserve_pct) ? `${m.o2_reserve_pct}%` : null, 'assumed', 'The point where the HUD tells the crew to head back.'],
    ['Surface dose rate', num(rad) ? `${rad} mSv/day` : null, 'sourced', 'Dose equivalent measured by Curiosity’s RAD at Gale crater.'],
    ['Storm multiplier', num(d.radiation?.replay?.event_multiplier) ? `× ${d.radiation.replay.event_multiplier}` : null, 'derived', 'Storm-day absorbed dose divided by the mean daily absorbed dose, both from RAD.'],
    ['EVA window', num(m.eva_min_sun_el_deg) && num(m.eva_min_temp_c) ? `Sun ≥ ${m.eva_min_sun_el_deg}°, air ≥ ${m.eva_min_temp_c} °C` : null, 'assumed', 'Walk only with the Sun well above the horizon and the air warm enough for the suit.'],
    ['Slope limits', num(m.slope_warn_deg) && num(m.slope_max_deg) ? `warn at ${m.slope_warn_deg}°, impassable above ${m.slope_max_deg}°` : null, 'assumed', 'Team values; the route never crosses the upper limit.'],
  ];
  document.getElementById('sources').replaceChildren(...rows.map(([what, value, tag, note]) => h('li', {},
    h('span', { class: 'what' }, what, value ? h('span', { class: 'value', text: value }) : null),
    h('span', { class: `tag tag-${tag}`, text: tag }),
    h('span', { class: 'note', text: note }))));
}

// ---- Visor screenshot or placeholder ----
function setupVisor() {
  const img = document.getElementById('hud-shot');
  const ph = document.getElementById('hud-placeholder');
  const fail = () => { img.hidden = true; ph.hidden = false; };
  if (img.complete && img.naturalWidth === 0) fail();
  img.addEventListener('error', fail);
}

// ---- Navigation: compact header, active section, mobile menu ----
function setupNav() {
  const header = document.getElementById('site-header');
  const toggle = document.getElementById('nav-toggle');
  const links = document.getElementById('nav-links');
  const onScroll = () => header.classList.toggle('is-compact', window.scrollY > 24);
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  const close = () => { links.classList.remove('is-open'); toggle.setAttribute('aria-expanded', 'false'); };
  toggle.addEventListener('click', () => {
    const open = !links.classList.contains('is-open');
    links.classList.toggle('is-open', open);
    toggle.setAttribute('aria-expanded', String(open));
  });
  links.addEventListener('click', (e) => { if (e.target.closest('a')) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });

  const anchors = [...links.querySelectorAll('ul a')];
  const byId = new Map(anchors.map((a) => [a.getAttribute('href').slice(1), a]));
  const targets = [...byId.keys()].map((id) => document.getElementById(id)).filter(Boolean);
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      anchors.forEach((a) => a.removeAttribute('aria-current'));
      byId.get(e.target.id)?.setAttribute('aria-current', 'true');
    }
  }, { rootMargin: '-45% 0px -50% 0px' });
  targets.forEach((t) => io.observe(t));
}

// ---- Elevation ruler: the scroll position as a climb through the strata ----
function setupRuler(hm, d) {
  const ruler = document.getElementById('ruler');
  const track = ruler.querySelector('.ruler-track');
  const marker = document.getElementById('ruler-marker');
  const lo = hm.zMin;
  const hi = hm.zMax;
  const yOf = (z) => `${((hi - z) / (hi - lo)) * 100}%`;
  const parts = [];
  for (let t = Math.ceil(lo / 100) * 100; t <= hi; t += 100) {
    const tick = h('span', { class: 'ruler-tick', text: `${t}` });
    tick.style.top = yOf(t);
    parts.push(tick);
  }
  // Clay below the transition stop, sulfate above it (from the stops' own elevations)
  const transition = (d.stops || []).find((s) => /transition/i.test(s.name || ''));
  const zt = transition && Array.isArray(transition.coord) ? hm.at(...transition.coord) : null;
  if (num(zt)) {
    const clay = h('span', { class: 'ruler-zone clay' });
    clay.style.top = yOf(zt);
    clay.style.bottom = '0';
    const sulfate = h('span', { class: 'ruler-zone sulfate' });
    sulfate.style.top = '0';
    sulfate.style.bottom = `${100 - parseFloat(yOf(zt))}%`;
    const clayLabel = h('span', { class: 'ruler-zone-label', text: 'Clay-bearing' });
    clayLabel.style.bottom = '8px';
    const sulfLabel = h('span', { class: 'ruler-zone-label', text: 'Sulfate-bearing' });
    sulfLabel.style.top = '8px';
    parts.push(clay, sulfate, clayLabel, sulfLabel);
  }
  track.prepend(...parts);
  const unit = h('span', { class: 'ruler-tick', text: 'm' });
  unit.style.top = '-14px';
  track.append(unit);

  const onScroll = () => {
    const max = document.documentElement.scrollHeight - window.innerHeight;
    const p = max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0;
    marker.style.top = `${(1 - p) * 100}%`; // start low in the clay, climb into the sulfate
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
  ruler.hidden = false;
}

// ---- Hero block: 3D or poster ----
function webglAvailable() {
  try {
    const c = document.createElement('canvas');
    return Boolean(c.getContext('webgl2') || c.getContext('webgl'));
  } catch { return false; }
}

async function setupBlock(hm, d) {
  const poster = document.getElementById('block-poster');
  const figureEl = poster.closest('figure');
  let posterFailed = poster.complete && poster.naturalWidth === 0;
  let wantPoster = false;
  // Without 3D and without a poster image, drop the block and let the text take the row
  const update = () => { poster.hidden = !wantPoster || posterFailed; figureEl.classList.toggle('no-block', wantPoster && posterFailed); };
  poster.addEventListener('error', () => { posterFailed = true; update(); });
  poster.addEventListener('load', () => { posterFailed = false; update(); });
  const showPoster = () => { wantPoster = true; update(); };
  const small = window.matchMedia('(max-width: 767px)').matches;
  if (!hm || reduceMotion || small || !webglAvailable()) { showPoster(); return; }
  try {
    const { initBlock } = await import('./block3d.js');
    const css = getComputedStyle(document.documentElement);
    const colors = Object.fromEntries(['paper', 'sand', 'line', 'ink', 'oxide', 'clay', 'sulfate']
      .map((k) => [k, css.getPropertyValue(`--${k}`).trim()]));
    const row = sunAt(d.sun, d.eva?.start_utc);
    await initBlock(document.getElementById('block-canvas'), {
      hm, layers: d.layers, route: d.route, stops: d.stops, area: d.area,
      sunDir: row ? { az: row.sun_az, el: row.sun_el } : null, colors,
    });
  } catch (err) {
    console.warn('[landing] 3D block failed, showing the poster', err);
    showPoster();
  }
}

// ---- Start ----
setupNav();
setupVisor();
const entries = await Promise.all(Object.entries(FILES).map(async ([k, url]) => [k, await loadJSON(url)]));
const data = Object.fromEntries(entries);

renderStatus(data);
renderHero(data);
renderStops(data);
renderLegend(data);
renderStorm(data);
renderSources(data);

let hm = null;
try {
  const { loadHeightmap } = await import('./heightmap.js');
  hm = await loadHeightmap(data.summary?.terrain, { size: 256 });
} catch (err) {
  console.warn('[landing] heightmap unavailable', err.message);
}

if (hm) {
  try { setupRuler(hm, data); } catch (err) { console.warn('[landing] ruler failed', err); }
  import('./contours.js')
    .then(({ drawContours }) => drawContours(document.getElementById('contours'), hm))
    .catch((err) => console.warn('[landing] contours failed', err));
}
setupBlock(hm, data);
