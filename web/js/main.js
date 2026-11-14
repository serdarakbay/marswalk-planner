// main.js (Ege): uygulama girişi. web/data/ dosyalarını tek bir state nesnesine yükler,
// sonra harita, kartlar ve HUD modüllerini başlatır. Eksik dosya ya da modül sayfayı çökertmez.

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
};

async function loadJSON(key, url) {
  try {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.warn(`[state] ${key}: ${url} yüklenemedi (${err.message}); null kalıyor`);
    return null;
  }
}

async function loadState() {
  const entries = await Promise.all(
    Object.entries(DATA_FILES).map(async ([key, url]) => [key, await loadJSON(key, url)]),
  );
  return Object.fromEntries(entries);
}

// Modül yoksa ya da init hata atarsa konsola yazar, diğerleri çalışmaya devam eder
async function startModule(name, path, initName, el) {
  try {
    const mod = await import(path);
    await mod[initName](state, el);
  } catch (err) {
    console.warn(`[${name}] başlatılamadı: ${err.message}`);
  }
}

const state = await loadState();

document.getElementById('hud-toggle').addEventListener('click', () => {
  document.dispatchEvent(new CustomEvent('hud:toggle'));
});

// HUD açılıp kapanınca düğmenin durumunu body[data-mode]'dan güncelle
new MutationObserver(() => {
  document.getElementById('hud-toggle')
    .setAttribute('aria-pressed', String(document.body.dataset.mode === 'hud'));
}).observe(document.body, { attributes: true, attributeFilter: ['data-mode'] });

await Promise.all([
  startModule('cards', './cards/index.js', 'initCards', document.getElementById('cards')),
  startModule('hud', './hud/index.js', 'initHUD', document.getElementById('hud-root')),
]);
