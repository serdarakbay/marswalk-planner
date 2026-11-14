// main.js (Ege): app entry point. Loads every web/data/ file into a single state object,
// then starts the map, cards and HUD modules. A missing file or module never breaks the page.

const DATA_FILES = {
  area: 'data/area.json',
  layers: 'data/layers.json',
  overlays: 'data/overlays.json',
  route: 'data/route.geojson',
  summary: 'data/summary.json',
  safety: 'data/safety/safety.json',
  stops: 'data/stops.json',
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

// Mission status chips in the header, from whatever data is available
function fmtMin(min) {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return h ? `${h} h ${String(m).padStart(2, '0')} min` : `${m} min`;
}

function renderStatus(s) {
  const chips = [];
  if (s.eva?.start_lmst && s.eva?.end_lmst) {
    chips.push({ label: 'EVA window', value: `${s.eva.start_lmst}–${s.eva.end_lmst} LMST`, title: s.eva.reason });
  }
  if (Number.isFinite(s.summary?.distance_m) && Number.isFinite(s.summary?.duration_min)) {
    chips.push({ label: 'Route', value: `${(s.summary.distance_m / 1000).toFixed(2)} km · ${fmtMin(s.summary.duration_min)}` });
  }
  if (Number.isFinite(s.summary?.o2_used_pct)) {
    chips.push({ label: 'O2 used', value: `${s.summary.o2_used_pct.toFixed(1)}%` });
  }
  if (s.radiation?.status) {
    const level = { nominal: 'ok', elevated: 'warn', storm: 'danger' }[s.radiation.status] || 'info';
    chips.push({ label: 'Radiation', value: s.radiation.status, title: s.radiation.message, level });
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
  startModule('cards', './cards/index.js', 'initCards', document.getElementById('cards')),
  startModule('hud', './hud/index.js', 'initHUD', document.getElementById('hud-root')),
  // The 3D button only appears once Egemen's 3D view has started
  startModule('view3d', './view3d/index.js', 'initView3D', document.getElementById('view3d-root'))
    .then((ok) => { view3dButton.hidden = !ok; }),
]);
