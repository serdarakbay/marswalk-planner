// 3D view (Egemen). Entry point called by main.js: initView3D(state, el).
// Kept light on purpose: the three.js scene (scene.js) is only downloaded the
// first time the 3D button is pressed. Without WebGL this throws, so main.js
// keeps the 3D button hidden (quiet fallback).
//
// Events in : view3d:toggle (header button), stop:select (map / cards), hud:time (HUD clock),
//             nav:routes / nav:choose / nav:clear / nav:pick / nav:cancel (cards navigation)
// Events out: stop:select when a stop pin is clicked in 3D (same detail as the map),
//             nav:point {which, coord} when the terrain is clicked in pick mode
// Writes    : document.body.dataset.view = '3d' | 'map'

function hasWebGL() {
  try {
    const c = document.createElement('canvas');
    return !!(window.WebGLRenderingContext && (c.getContext('webgl2') || c.getContext('webgl')));
  } catch {
    return false;
  }
}

function ensureCss() {
  if (document.querySelector('link[data-view3d-css]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = new URL('../../css/view3d.css', import.meta.url).href;
  link.dataset.view3dCss = '';
  document.head.append(link);
}

export function initView3D(state, el) {
  if (!el) throw new Error('#view3d-root not found');
  if (!hasWebGL()) throw new Error('WebGL is not available; 3D view disabled');
  ensureCss();

  let view = null;          // scene controller, created lazily
  let loading = null;       // promise while scene.js is loading
  let lastTime = null;      // last hud:time detail, replayed when the scene appears
  let pendingStop = null;   // stop selected before the scene existed
  let lastNav = null;       // your own routes from the cards (nav:routes), replayed on load
  let pendingPick = null;   // nav:pick that arrived while the scene was loading

  const status = document.createElement('p');
  status.className = 'v3d-status';
  status.textContent = 'Loading 3D view…';

  async function ensureView() {
    if (view) return view;
    if (!loading) {
      el.replaceChildren(status);
      loading = import('./scene.js')
        .then((mod) => mod.createScene(state, el, {
          onProgress: (msg) => { status.textContent = msg; },
        }))
        .then((v) => {
          view = v;
          if (lastTime) view.setTime(lastTime);
          if (pendingStop) view.focusStop(pendingStop, { instant: true });
          if (lastNav) view.setNav(lastNav);
          if (pendingPick) { view.setPick(pendingPick); pendingPick = null; }
          return v;
        })
        .catch((err) => {
          console.warn(`[view3d] could not start: ${err.message}`);
          status.textContent = '3D view could not be loaded. The 2D map still works.';
          loading = null;
          return null;
        });
    }
    return loading;
  }

  function show() {
    el.hidden = false;
    document.body.dataset.view = '3d';
    ensureView().then((v) => v && v.start());
  }

  function hide() {
    el.hidden = true;
    document.body.dataset.view = 'map';
    if (view) view.stop();
  }

  document.addEventListener('view3d:toggle', () => (el.hidden ? show() : hide()));

  document.addEventListener('stop:select', (e) => {
    if (!e.detail) return;
    if (view) view.focusStop(e.detail);
    else pendingStop = e.detail;
  });

  document.addEventListener('nav:routes', (e) => {
    lastNav = e.detail || null;
    if (view) view.setNav(lastNav);
  });
  document.addEventListener('nav:choose', (e) => {
    const id = e.detail?.id;
    if (lastNav && id) lastNav = { ...lastNav, chosen: id };
    if (view && id) view.chooseNav(id);
  });
  document.addEventListener('nav:clear', () => {
    lastNav = null;
    if (view) view.setNav(null);
  });
  document.addEventListener('nav:pick', (e) => {
    const which = e.detail?.which;
    if (view) view.setPick(which);
    else pendingPick = which;
  });
  document.addEventListener('nav:cancel', () => {
    pendingPick = null;
    if (view) view.setPick(null);
  });

  document.addEventListener('hud:time', (e) => {
    lastTime = e.detail || null;
    if (view && lastTime) view.setTime(lastTime);
  });

  // In HUD mode the visor panels sit on top; hide the 3D chrome (CSS: #view3d-root.is-hud)
  const syncMode = () => el.classList.toggle('is-hud', document.body.dataset.mode === 'hud');
  new MutationObserver(syncMode).observe(document.body, { attributes: true, attributeFilter: ['data-mode'] });
  syncMode();

  el.hidden = true;
  return { show, hide };
}
