// main.js (Ege): app entry point. Loads every web/data/ file into a single state object,
// then starts the map, cards, HUD and 3D modules. A missing file or module never breaks the page.

const DATA_FILES = {
  area: 'data/area.json',
  layers: 'data/layers.json',
  overlays: 'data/overlays.json',
  route: 'data/route.geojson',
  summary: 'data/summary.json',
  safety: 'data/safety/safety.json',
  stops: 'data/stops.json',
  targets: 'data/targets.json',   // science targets off the route (HUD Targets panel)
  geology: 'data/geology.geojson',
  images: 'data/images.json',
  traverse: 'data/traverse.geojson',
  weather: 'data/weather.json',
  sun: 'data/sun.json',
  eva: 'data/eva_window.json',
  donki: 'data/donki.json',
  radiation: 'data/radiation.json',
  alerts: 'data/alerts.json',
  mission: 'data/mission.json',   // copied from config/ at deploy time (git-ignored locally)
};

async function loadJSON(key, url) {
  try {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.warn(`[state] ${key}: ${url} could not be loaded (${err.message}); staying null`);
    return null;
  }
}

async function loadState() {
  const entries = await Promise.all(
    Object.entries(DATA_FILES).map(async ([key, url]) => [key, await loadJSON(key, url)]),
  );
  return Object.fromEntries(entries);
}

// If a module is missing or its init throws, log it and keep the others running.
// Returns true when the module started.
async function startModule(name, path, initName, el) {
  try {
    const mod = await import(path);
    await mod[initName](state, el);
    return true;
  } catch (err) {
    console.warn(`[${name}] failed to start: ${err.message}`);
    return false;
  }
}

const state = await loadState();

// Conditions in the header, from whatever data is available (every item is optional)
function tempAt(weather, lmst) {
  const rows = Array.isArray(weather?.rows) ? weather.rows : [];
  const toMin = (t) => { const m = /^(\d{1,2}):(\d{2})/.exec(t || ''); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
  const want = toMin(lmst);
  if (want == null || !rows.length) return null;
  let best = null; let bd = Infinity;
  for (const r of rows) {
    const d = Math.abs(toMin(r.lmst) - want);
    if (Number.isFinite(r.temp_c) && d < bd) { bd = d; best = r.temp_c; }
  }
  return best;
}

function renderStatus(s) {
  const chips = [];
  if (s.eva?.start_lmst && s.eva?.end_lmst) {
    chips.push({ label: 'EVA window (Mars time)', value: `${s.eva.start_lmst}–${s.eva.end_lmst}`, title: s.eva.reason });
  }
  const t = tempAt(s.weather, s.eva?.start_lmst);
  if (Number.isFinite(t)) {
    chips.push({ label: s.weather?.approximate ? 'Air at start (approx.)' : 'Air at start', value: `${Math.round(t)} °C`, title: s.weather?.source });
  }
  if (s.radiation?.status) {
    const level = { nominal: 'ok', elevated: 'warn', storm: 'danger' }[s.radiation.status] || '';
    const value = s.radiation.status[0].toUpperCase() + s.radiation.status.slice(1);
    chips.push({ label: 'Radiation', value, title: s.radiation.message, level });
  }
  const earth = Array.isArray(s.sun?.rows) ? s.sun.rows.find((r) => Number.isFinite(r.light_time_min)) : null;
  if (earth) {
    chips.push({ label: 'Signal to Earth', value: `${earth.light_time_min.toFixed(1)} min`, title: 'One-way light time, JPL Horizons' });
  }
  const list = document.getElementById('mission-status');
  list.replaceChildren(...chips.map(({ label, value, title, level }) => {
    const li = document.createElement('li');
    li.className = `status-chip${level ? ` is-${level}` : ''}`;
    if (title) li.title = title;
    const k = document.createElement('span');
    k.className = 'status-label';
    k.textContent = label;
    const v = document.createElement('span');
    v.className = 'status-value';
    v.textContent = value;
    li.append(k, v);
    return li;
  }));
}
renderStatus(state);

document.getElementById('hud-toggle').addEventListener('click', () => {
  document.dispatchEvent(new CustomEvent('hud:toggle'));
});

const view3dButton = document.getElementById('view3d-toggle');
view3dButton.addEventListener('click', () => {
  document.dispatchEvent(new CustomEvent('view3d:toggle'));
});

// Keep the header buttons in sync with body[data-mode] (HUD) and body[data-view] (3D)
new MutationObserver(() => {
  document.getElementById('hud-toggle')
    .setAttribute('aria-pressed', String(document.body.dataset.mode === 'hud'));
  view3dButton.setAttribute('aria-pressed', String(document.body.dataset.view === '3d'));
}).observe(document.body, { attributes: true, attributeFilter: ['data-mode', 'data-view'] });

await Promise.all([
  startModule('map', './map/index.js', 'initMap', document.getElementById('map')),
  startModule('sources', './map/sources.js', 'initSources', null),
  startModule('cards', './cards/index.js', 'initCards', document.getElementById('cards')),
  startModule('hud', './hud/index.js', 'initHUD', document.getElementById('hud-root')),
  // The 3D button only appears once Egemen's 3D view has started
  startModule('view3d', './view3d/index.js', 'initView3D', document.getElementById('view3d-root'))
    .then((ok) => { view3dButton.hidden = !ok; }),
]);
