// 3D scene (Egemen): terrain with HiRISE imagery, the planned route, stops,
// habitat, shelters, Curiosity's traverse, the Sun from sun.json and the
// astronaut from hud:time. Loaded lazily by index.js.
//
// three.js r160 (MIT, https://github.com/mrdoob/three.js), from jsDelivr with a pinned version.
import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.0/+esm';
import { OrbitControls } from 'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/controls/OrbitControls.js/+esm';
import {
  makeFrame, sampleGrid, routeCoords, buildHeights, buildBaseImage, overlayChoices, composeImage, distM,
  strataCanvas, STRATA_STEP_M,
} from './terrain.js';

const EXAGGERATIONS = [1, 2, 3];
// true scale on the real DEM; the flat placeholder needs a boost to show anything
const DEFAULT_EXAGGERATION = { real: 1, placeholder: 2 };
const ROUTE_LIFT_M = 1.5;          // keep lines just above the surface
const ROUTE_STEP_M = 4;            // resample the route for a smooth tube
const PIN_HEIGHT_M = 40;
const FLY_SPEED_M_S = 45;          // fly-through speed along the route
// Bodycam: the HUD astronaut's view (hud:time), looking where they walk; the astronaut figure
// is hidden. A little above true eye height: the terrain grid is ~9 m and the height is
// exaggerated, so a 1.7 m camera would sit in the blur.
const BODY_BACK_M = 6;             // camera this far behind the astronaut's position
const BODY_UP_M = 7;               // and this far above the ground there
const BODY_LOOK_M = 90;            // looks at a point this far ahead
const BODY_CLEAR_M = 4;            // never closer than this to the ground under the camera
const FOCUS_MS = 1400;
const STRATA_ALPHA = 0.62;         // rock-layer tint over the HiRISE image
const fmtElev = (z) => `${Math.round(z)} m`.replace('-', '\u2212');

// ---------------------------------------------------------------- helpers
const css = (name, fallback) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

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

const lmstToMin = (s) => {
  const m = /^(\d{1,2}):(\d{2})/.exec(s || '');
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

function sunRow(sun, eva, utc) {
  const rows = Array.isArray(sun?.rows) ? sun.rows : [];
  if (!rows.length) return null;
  if (utc) {
    const t = Date.parse(utc);
    let best = rows[0]; let bd = Infinity;
    for (const r of rows) { const d = Math.abs(Date.parse(r.utc) - t); if (d < bd) { bd = d; best = r; } }
    return best;
  }
  const start = lmstToMin(eva?.start_lmst);
  if (start == null) return rows.find((r) => r.sun_el > 15) || rows[0];
  let best = null; let bd = Infinity;
  for (const r of rows) {
    const m = lmstToMin(r.lmst);
    if (m == null || r.sun_el <= 0) continue;
    const d = Math.abs(m - start);
    if (d < bd) { bd = d; best = r; }
  }
  return best || rows[0];
}

function labelSprite(text, color) {
  const pad = 14; const font = 600;
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  const family = css('--font-sans', 'sans-serif');
  ctx.font = `${font} 28px ${family}`;
  c.width = Math.ceil(ctx.measureText(text).width) + pad * 2;
  c.height = 48;
  ctx.font = `${font} 28px ${family}`;
  ctx.fillStyle = css('--color-bg', 'black');
  ctx.globalAlpha = 0.78;
  ctx.beginPath();
  ctx.roundRect(0, 0, c.width, c.height, 10);
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.fillStyle = color;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, pad, c.height / 2 + 1);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, sizeAttenuation: false }));
  const hgt = 0.032;
  sp.scale.set((hgt * c.width) / c.height, hgt, 1);
  sp.center.set(0.5, -0.4);
  sp.renderOrder = 10;
  return sp;
}

function skyTexture() {
  const c = document.createElement('canvas');
  c.width = 4; c.height = 256;
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0, css('--color-bg', 'black'));
  g.addColorStop(0.55, css('--color-surface', 'black'));
  g.addColorStop(1, css('--color-dust', 'gray'));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 4, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ---------------------------------------------------------------- scene
export async function createScene(state, el, { onProgress } = {}) {
  if (!state?.area?.bbox) throw new Error('area.json missing: no bbox for the terrain');
  const frame = makeFrame(state.area.bbox);
  const colors = {
    accent: css('--color-accent', 'orange'),
    sand: css('--color-sand', 'tan'),
    info: css('--color-info', 'skyblue'),
    ok: css('--color-ok', 'green'),
    danger: css('--color-danger', 'red'),
    hud: css('--color-hud', 'cyan'),
    text: css('--color-text', 'white'),
    bg: css('--color-bg', 'black'),
    dust: css('--color-dust', 'gray'),
    // rock-layer colours; fall back to the older palette if base.css has no clay/sulfate yet
    clay: css('--color-clay', '') || css('--color-info', 'skyblue'),
    sulfate: css('--color-sulfate', '') || css('--color-sand', 'tan'),
  };

  onProgress?.('Building terrain…');
  const heights = await buildHeights(state, frame);
  const { grid } = heights;
  let zBase = 0;
  { let s = 0; for (const z of grid.z) s += z; zBase = s / grid.z.length; }
  let exag = heights.real ? DEFAULT_EXAGGERATION.real : DEFAULT_EXAGGERATION.placeholder;
  const yAt = (x, z) => (sampleGrid(grid, x, z) - zBase) * exag;
  const posLL = (lon, lat, lift = 0) => {
    const [x, z] = frame.toXZ(lon, lat);
    return new THREE.Vector3(x, yAt(x, z) + lift, z);
  };

  const base = await buildBaseImage(state, grid, onProgress);
  onProgress?.('Starting 3D…');

  // ----- renderer, camera, controls
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.domElement.className = 'v3d-canvas';

  const scene = new THREE.Scene();
  scene.background = skyTexture();
  scene.fog = new THREE.Fog(new THREE.Color(colors.dust), 3200, 9000);

  const camera = new THREE.PerspectiveCamera(45, 1, 1, 20000);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI * 0.47;
  controls.minDistance = 30;
  controls.maxDistance = 6000;

  // ----- terrain mesh
  const n = grid.n;
  const geo = new THREE.PlaneGeometry(frame.width, frame.depth, n - 1, n - 1);
  geo.rotateX(-Math.PI / 2); // plane row 0 -> north (z = -depth/2), matches the grid
  const texture = new THREE.CanvasTexture(base.canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  const terrain = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: texture, roughness: 1, metalness: 0 }));
  terrain.receiveShadow = true;
  terrain.castShadow = true;
  scene.add(terrain);

  function applyHeights() {
    const p = geo.attributes.position;
    for (let k = 0; k < p.count; k++) p.setY(k, (grid.z[k] - zBase) * exag);
    p.needsUpdate = true;
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
  }
  applyHeights();

  // ----- lights (Sun from sun.json)
  const hemi = new THREE.HemisphereLight(new THREE.Color(colors.sand), new THREE.Color(colors.bg), 0.55);
  scene.add(hemi);
  const sunLight = new THREE.DirectionalLight(0xffffff, 2.2);
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.set(2048, 2048);
  const half = Math.max(frame.width, frame.depth) * 0.75;
  Object.assign(sunLight.shadow.camera, { left: -half, right: half, top: half, bottom: -half, near: 10, far: 12000 });
  sunLight.shadow.bias = -0.0004;
  sunLight.shadow.normalBias = 1.5;
  scene.add(sunLight, sunLight.target);
  let sunInfo = null;
  function setSun(row) {
    sunInfo = row;
    const az = ((row?.sun_az ?? 135) * Math.PI) / 180;
    const el = Math.max(row?.sun_el ?? 35, 2) * (Math.PI / 180);
    const dir = new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
    sunLight.position.copy(dir.multiplyScalar(5000));
    const day = (row?.sun_el ?? 35) > 0;
    sunLight.intensity = day ? 2.2 : 0.05;
    hemi.intensity = day ? 0.55 : 0.18;
    updateInfo();
  }

  // ----- overlays group (rebuilt when the exaggeration changes)
  const marks = new THREE.Group();
  scene.add(marks);
  const pickables = [];
  const coords = routeCoords(state.route);
  let routeCurve = null;
  let routeLen = 0;

  function lineOnTerrain(pts, lift) {
    return pts.map(([lon, lat]) => posLL(lon, lat, lift));
  }

  function resample(path, step) {
    const out = [path[0]];
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1]; const b = path[i];
      const d = distM(a, b);
      const k = Math.max(1, Math.ceil(d / step));
      for (let s = 1; s <= k; s++) out.push([a[0] + ((b[0] - a[0]) * s) / k, a[1] + ((b[1] - a[1]) * s) / k]);
    }
    return out;
  }

  const stopObjs = new Map();   // stop id -> {head, lab, ring, headY}
  let selectedId = null;
  const stopElev = (stop) => {
    const [x, z] = frame.toXZ(stop.coord[0], stop.coord[1]);
    return sampleGrid(grid, x, z);
  };

  function buildMarks() {
    marks.clear();
    pickables.length = 0;
    stopObjs.clear();

    // planned route
    if (coords.length >= 2) {
      const pts = lineOnTerrain(resample(coords, ROUTE_STEP_M), ROUTE_LIFT_M * exag);
      routeCurve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
      routeLen = routeCurve.getLength();
      const tube = new THREE.Mesh(
        new THREE.TubeGeometry(routeCurve, Math.min(pts.length * 2, 4000), 1.3, 6, false),
        new THREE.MeshStandardMaterial({ color: colors.accent, emissive: colors.accent, emissiveIntensity: 0.45 }),
      );
      tube.castShadow = true;
      marks.add(tube);
    }

    // Curiosity traverse (dashed), split at re-entries so no fake jumps are drawn
    const tg = state.traverse?.geometry || state.traverse?.features?.[0]?.geometry;
    if (tg?.coordinates?.length) {
      const parts = [];
      if (tg.type === 'MultiLineString') parts.push(...tg.coordinates);
      else {
        const br = [0, ...(state.traverse.properties?.breaks || []), tg.coordinates.length];
        for (let i = 0; i < br.length - 1; i++) parts.push(tg.coordinates.slice(br[i], br[i + 1]));
      }
      const mat = new THREE.LineDashedMaterial({ color: colors.info, dashSize: 14, gapSize: 9, transparent: true, opacity: 0.9 });
      for (const part of parts) {
        if (part.length < 2) continue;
        const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(lineOnTerrain(resample(part, 6), 2 * exag)), mat);
        line.computeLineDistances();
        marks.add(line);
      }
    }

    // habitat
    const hab = state.area.habitat;
    if (Array.isArray(hab)) {
      const p = posLL(hab[0], hab[1]);
      const dome = new THREE.Mesh(
        new THREE.SphereGeometry(9, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2),
        new THREE.MeshStandardMaterial({ color: colors.text, roughness: 0.4, metalness: 0.2 }),
      );
      dome.position.copy(p);
      dome.castShadow = true;
      marks.add(dome);
      const lab = labelSprite('Habitat', colors.text);
      lab.position.copy(p).add(new THREE.Vector3(0, 14, 0));
      marks.add(lab);
    }

    // shelters
    for (const s of state.safety?.shelters || []) {
      if (!Array.isArray(s.coord)) continue;
      const m = new THREE.Mesh(
        new THREE.ConeGeometry(4, 10, 4),
        new THREE.MeshStandardMaterial({ color: colors.ok, emissive: colors.ok, emissiveIntensity: 0.3 }),
      );
      m.position.copy(posLL(s.coord[0], s.coord[1], 5));
      m.userData.shelter = s;
      marks.add(m);
    }

    // stops
    (Array.isArray(state.stops) ? state.stops : []).forEach((stop, i) => {
      if (!Array.isArray(stop.coord)) return;
      const ground = posLL(stop.coord[0], stop.coord[1]);
      const stick = new THREE.Mesh(
        new THREE.CylinderGeometry(0.8, 0.8, PIN_HEIGHT_M, 6),
        new THREE.MeshStandardMaterial({ color: colors.sand }),
      );
      stick.position.copy(ground).add(new THREE.Vector3(0, PIN_HEIGHT_M / 2, 0));
      const head = new THREE.Mesh(
        new THREE.SphereGeometry(5, 20, 12),
        new THREE.MeshStandardMaterial({ color: colors.sand, emissive: colors.sand, emissiveIntensity: 0.35 }),
      );
      head.position.copy(ground).add(new THREE.Vector3(0, PIN_HEIGHT_M, 0));
      head.userData.stop = stop;
      stick.userData.stop = stop;
      stick.castShadow = true;
      const name = `${i + 1}  ${stop.name || stop.id}`;
      const lab = labelSprite(heights.real ? `${name} · ${fmtElev(stopElev(stop))}` : name, colors.sand);
      lab.position.copy(head.position).add(new THREE.Vector3(0, 6, 0));
      // pulsing ring on the ground, shown only for the selected stop
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(7, 9.5, 48).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ color: colors.accent, transparent: true, depthWrite: false, side: THREE.DoubleSide }),
      );
      ring.position.copy(ground).add(new THREE.Vector3(0, 1.5, 0));
      ring.visible = false;
      marks.add(stick, head, lab, ring);
      pickables.push(head, stick);
      stopObjs.set(stop.id ?? i, { head, lab, ring, headY: head.position.y });
    });
    applySelection();

    marks.add(astro);
    marks.add(shelterLine);
    placeAstronaut();
  }

  // ----- astronaut (from hud:time)
  const astro = new THREE.Group();
  {
    const mat = new THREE.MeshStandardMaterial({ color: colors.hud, emissive: colors.hud, emissiveIntensity: 0.6 });
    const body = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 1.6, 5, 12), mat);
    body.position.y = 2.5;
    const head = new THREE.Mesh(new THREE.SphereGeometry(1.8, 16, 10), mat);
    head.position.y = 6.4;
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.4, 0.4, 120, 6),
      new THREE.MeshBasicMaterial({ color: colors.hud, transparent: true, opacity: 0.35, depthWrite: false }),
    );
    beam.position.y = 60;
    astro.add(body, head, beam);
    astro.scale.setScalar(1.6);
    astro.visible = false;
  }
  const shelterLine = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
    new THREE.LineBasicMaterial({ color: colors.ok }),
  );
  shelterLine.visible = false;
  let hudTime = null;
  const walkDir = new THREE.Vector3(0, 0, -1);   // walking direction (bodycam), smoothed
  let lastAstro = null;
  let astroShown = false;

  function placeAstronaut() {
    const t = hudTime;
    const show = !!(t?.active && Array.isArray(t.coord));
    astroShown = show;
    astro.visible = show && !bodycam;
    shelterLine.visible = false;
    if (!show) { lastAstro = null; return; }
    astro.position.copy(posLL(t.coord[0], t.coord[1]));
    // Walking direction from the last position (ignore tiny moves: standing, sampling)
    if (lastAstro) {
      const step = astro.position.clone().sub(lastAstro).setY(0);
      if (step.length() > 0.5) walkDir.lerp(step.normalize(), 0.35).normalize();
    }
    lastAstro = astro.position.clone();
    // HUD path still to walk (to a shelter, aside from a dust devil, to a science target, back
    // to the route): follows the ground around steep slopes, like the line on the map
    if (Array.isArray(t.refuge_path) && t.refuge_path.length > 1) {
      shelterLine.geometry.setFromPoints(t.refuge_path.map((c) => posLL(c[0], c[1], 6)));
      shelterLine.material.color.set(t.storm ? colors.danger : colors.ok);
      shelterLine.visible = true;
    } else if (t.storm && Array.isArray(t.shelter)) {
      const a = astro.position.clone().add(new THREE.Vector3(0, 6, 0));
      const b = posLL(t.shelter[0], t.shelter[1], 6);
      shelterLine.geometry.setFromPoints([a, b]);
      shelterLine.material.color.set(colors.danger);
      shelterLine.visible = true;
    }
  }

  // ----- camera moves
  let tween = null;   // {from, to, fromT, toT, start, ms}
  let fly = null;     // {s: metres along route}
  let bodycam = false; // camera follows the HUD astronaut

  function overview() {
    // frame the route, the stops and the habitat (they can be far apart); seen from the
    // south, so the walk reads bottom (habitat) to top (stop 1), clear of the info panel
    const box = new THREE.Box3();
    const pts = [...coords, ...(Array.isArray(state.stops) ? state.stops.map((s) => s.coord) : []), state.area.habitat]
      .filter((c) => Array.isArray(c) && Number.isFinite(c[0]) && Number.isFinite(c[1]));
    if (pts.length) for (const c of pts) box.expandByPoint(posLL(c[0], c[1]));
    else box.setFromObject(terrain);
    const center = box.getCenter(new THREE.Vector3());
    const size = Math.max(box.getSize(new THREE.Vector3()).length(), 600);
    return { target: center, pos: center.clone().add(new THREE.Vector3(0.15 * size, 0.55 * size, 0.95 * size)) };
  }

  function moveTo(pos, target, ms = FOCUS_MS) {
    fly = null;
    if (ms <= 0) { camera.position.copy(pos); controls.target.copy(target); return; }
    tween = { from: camera.position.clone(), to: pos, fromT: controls.target.clone(), toT: target, start: performance.now(), ms };
  }

  function applySelection() {
    for (const [id, o] of stopObjs) {
      const on = id === selectedId;
      o.ring.visible = on;
      o.head.material.emissive.set(on ? colors.accent : colors.sand);
      o.head.material.emissiveIntensity = on ? 0.9 : selectedId == null ? 0.35 : 0.15;
      o.lab.material.opacity = on || selectedId == null ? 1 : 0.55;
      o.head.position.y = o.headY;
    }
  }

  function animateSelection(now) {
    const o = stopObjs.get(selectedId);
    if (!o) return;
    const t = now / 1000;
    o.head.position.y = o.headY + Math.sin(t * 3) * 2.5;
    o.head.material.emissiveIntensity = 0.75 + 0.35 * Math.sin(t * 4);
    const f = (t / 1.4) % 1;
    o.ring.scale.setScalar(1 + f * 3);
    o.ring.material.opacity = 0.9 * (1 - f);
  }

  function focusStop(stop, { instant = false } = {}) {
    if (!Array.isArray(stop?.coord)) return;
    const idx = (Array.isArray(state.stops) ? state.stops : []).findIndex((s) => s === stop || (s.id != null && s.id === stop.id));
    selectedId = stop.id ?? (idx >= 0 ? idx : null);
    applySelection();
    if (bodycam) return;   // keep following the astronaut; the stop is highlighted
    const target = posLL(stop.coord[0], stop.coord[1], 10);
    const dir = camera.position.clone().sub(controls.target).setY(0);
    if (dir.lengthSq() < 1) dir.set(-1, 0, 1);
    dir.normalize().multiplyScalar(220);
    moveTo(target.clone().add(dir).add(new THREE.Vector3(0, 140, 0)), target, instant ? 0 : FOCUS_MS);
  }

  function toggleFly() {
    if (fly) { fly = null; updateButtons(); return; }
    if (!routeCurve) return;
    tween = null;
    bodycam = false;
    fly = { s: 0 };
    updateButtons();
  }

  function toggleBodycam() {
    bodycam = !bodycam;
    if (bodycam) { fly = null; tween = null; }
    updateButtons();
  }

  // ----- UI
  const info = h('p', { class: 'v3d-info' });
  const flyBtn = h('button', { class: 'v3d-btn v3d-btn--primary', type: 'button', onclick: toggleFly, disabled: !coords.length },
    'Fly along route');
  const bodyBtn = h('button', {
    class: 'v3d-btn', type: 'button', onclick: toggleBodycam, 'aria-pressed': 'false',
    title: 'Follow the HUD astronaut, looking where they walk (open the HUD with H and press Play)',
  }, 'Bodycam');
  const resetBtn = h('button', {
    class: 'v3d-btn', type: 'button',
    onclick: () => { bodycam = false; const o = overview(); moveTo(o.pos, o.target); updateButtons(); },
  }, 'Reset view');
  const exagBtns = EXAGGERATIONS.map((x) => h('button', {
    class: 'v3d-seg', type: 'button', 'aria-pressed': String(x === exag),
    onclick: () => setExag(x),
  }, `${x}×`));
  const choices = overlayChoices(state);
  let strata = null;
  if (heights.real) {
    strata = strataCanvas(grid, colors.clay, colors.sulfate, colors.text);
    choices.unshift({ id: 'strata', name: 'Rock layers (clay \u2192 sulfate)', canvas: strata.canvas, alpha: STRATA_ALPHA });
  }
  const overlaySel = h('select', {
    class: 'v3d-select', 'aria-label': 'Layer draped on the terrain',
    onchange: async (e) => {
      const o = choices[Number(e.target.value)] || null;
      strataPanel.hidden = o?.id !== 'strata';
      try {
        texture.image = await composeImage(base, o, state.area.bbox);
        texture.needsUpdate = true;
      } catch (err) { console.warn(`[view3d] overlay: ${err.message}`); }
    },
  }, h('option', { value: '-1' }, 'Imagery only'), choices.map((o, i) => h('option', { value: String(i) }, o.name || o.id)));

  const legend = h('ul', { class: 'v3d-legend' },
    h('li', {}, h('span', { class: 'v3d-key v3d-key--route' }), 'Planned route'),
    h('li', {}, h('span', { class: 'v3d-key v3d-key--traverse' }), 'Curiosity traverse'),
    h('li', {}, h('span', { class: 'v3d-key v3d-key--stop' }), 'Stops'),
    h('li', {}, h('span', { class: 'v3d-key v3d-key--shelter' }), 'Shelters'),
    h('li', {}, h('span', { class: 'v3d-key v3d-key--astro' }), 'Astronaut (HUD clock)'),
  );

  const strataPanel = h('div', { class: 'v3d-strata', hidden: true });
  if (strata) {
    const span = strata.hi - strata.lo || 1;
    const pos = (z) => `${Math.min(Math.max(((z - strata.lo) / span) * 100, 0), 100)}%`;
    const stopsOn = (Array.isArray(state.stops) ? state.stops : [])
      .map((s, i) => (Array.isArray(s.coord) ? { n: i + 1, name: s.name, z: stopElev(s) } : null)).filter(Boolean);
    strataPanel.append(
      h('p', { class: 'v3d-kicker' }, 'Rock layers'),
      h('div', { class: 'v3d-strata-bar' },
        stopsOn.map((s) => h('span', { class: 'v3d-strata-stop', style: `left:${pos(s.z)}`, title: `${s.name}: ${fmtElev(s.z)}` }, String(s.n)))),
      h('div', { class: 'v3d-strata-ends' },
        h('span', {}, h('b', {}, 'Older · clay-bearing'), h('br'), `lower, ${fmtElev(strata.lo)}`),
        h('span', {}, h('b', {}, 'Younger · sulfate-bearing'), h('br'), `higher, ${fmtElev(strata.hi)}`)),
      h('p', { class: 'v3d-src' },
        `Mount Sharp's layers lie nearly flat, so walking uphill steps forward in time: from rock formed in a lake to salts left as the water dried up. Colour = DEM elevation (lines every ${STRATA_STEP_M} m), not mapped unit boundaries.`),
    );
  }

  const ui = h('div', { class: 'v3d-ui' },
    h('div', { class: 'v3d-top' },
      h('div', { class: 'v3d-title' },
        h('p', { class: 'v3d-kicker' }, '3D terrain'),
        info,
        h('p', { class: heights.real ? 'v3d-src' : 'v3d-src v3d-src--warn' }, heights.label),
        h('p', { class: 'v3d-src' }, `Image: ${base.label}`),
        strataPanel),
      legend),
    h('div', { class: 'v3d-bar' },
      flyBtn, bodyBtn, resetBtn,
      h('div', { class: 'v3d-group', role: 'group', 'aria-label': 'Vertical exaggeration' },
        h('span', { class: 'v3d-group-label' }, 'Height'), exagBtns),
      overlaySel),
    h('p', { class: 'v3d-hint' }, 'Drag to orbit · right-drag to pan · scroll to zoom · click a stop'));

  function updateButtons() {
    flyBtn.textContent = fly ? 'Stop flight' : 'Fly along route';
    flyBtn.setAttribute('aria-pressed', String(!!fly));
    bodyBtn.textContent = bodycam ? 'Stop bodycam' : 'Bodycam';
    bodyBtn.setAttribute('aria-pressed', String(bodycam));
    exagBtns.forEach((b, i) => b.setAttribute('aria-pressed', String(EXAGGERATIONS[i] === exag)));
  }

  function updateInfo() {
    const bits = [];
    if (sunInfo) bits.push(`Sun ${Math.round(sunInfo.sun_el)}° high, az ${Math.round(sunInfo.sun_az)}°`, `LMST ${sunInfo.lmst}`);
    bits.push(`height ×${exag}`);
    info.textContent = bits.join(' · ');
  }

  function setExag(x) {
    const ratio = x / exag;
    exag = x;
    applyHeights();
    buildMarks();
    // keep the camera at the same height above the (rescaled) ground it looks at
    const dy = controls.target.y * (ratio - 1);
    controls.target.y += dy;
    camera.position.y += dy;
    updateButtons();
    updateInfo();
  }

  el.replaceChildren(renderer.domElement, ui);

  // ----- picking
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  let downAt = null;
  renderer.domElement.addEventListener('pointerdown', (e) => { downAt = [e.clientX, e.clientY]; });
  renderer.domElement.addEventListener('pointerup', (e) => {
    if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 4) return;
    const r = renderer.domElement.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObjects(pickables, false)[0];
    if (hit?.object.userData.stop) {
      document.dispatchEvent(new CustomEvent('stop:select', { detail: hit.object.userData.stop }));
    }
  });
  renderer.domElement.style.cursor = 'grab';
  renderer.domElement.addEventListener('pointermove', (e) => {
    const r = renderer.domElement.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    renderer.domElement.style.cursor = ray.intersectObjects(pickables, false).length ? 'pointer' : 'grab';
  });
  controls.addEventListener('start', () => {
    tween = null;
    if (fly || bodycam) { fly = null; bodycam = false; updateButtons(); }
  });

  // ----- size + loop
  function resize() {
    const w = el.clientWidth || 1; const hgt = el.clientHeight || 1;
    renderer.setSize(w, hgt, false);
    camera.aspect = w / hgt;
    camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(el);

  let running = false;
  let last = performance.now();
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
  function frameLoop(now) {
    if (!running) return;
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    if (tween) {
      const t = Math.min((now - tween.start) / tween.ms, 1);
      const k = ease(t);
      camera.position.lerpVectors(tween.from, tween.to, k);
      controls.target.lerpVectors(tween.fromT, tween.toT, k);
      if (t >= 1) tween = null;
    }
    if (fly && routeCurve) {
      fly.s += FLY_SPEED_M_S * dt;
      if (fly.s >= routeLen) { fly = null; updateButtons(); }
      else {
        const u = fly.s / routeLen;
        const p = routeCurve.getPointAt(u);
        const ahead = routeCurve.getPointAt(Math.min(u + 60 / routeLen, 1));
        const back = p.clone().sub(ahead).setY(0).normalize();
        const want = p.clone().add(back.multiplyScalar(110)).add(new THREE.Vector3(0, 75, 0));
        camera.position.lerp(want, 0.08);
        controls.target.lerp(ahead, 0.12);
      }
    }
    astro.visible = astroShown && !bodycam;
    if (bodycam && astroShown) {
      const at = astro.position;
      const want = at.clone().addScaledVector(walkDir, -BODY_BACK_M).add(new THREE.Vector3(0, BODY_UP_M, 0));
      want.y = Math.max(want.y, yAt(want.x, want.z) + BODY_CLEAR_M);
      const look = at.clone().addScaledVector(walkDir, BODY_LOOK_M);
      look.y = Math.max(yAt(look.x, look.z), at.y - 20) + BODY_UP_M * 0.5;
      camera.position.lerp(want, 0.12);
      controls.target.lerp(look, 0.15);
    }
    animateSelection(now);
    controls.update();
    renderer.render(scene, camera);
    requestAnimationFrame(frameLoop);
  }

  // ----- initial state
  buildMarks();
  setSun(sunRow(state.sun, state.eva, null));
  const o = overview();
  moveTo(o.pos, o.target, 0);
  updateButtons();
  resize();

  return {
    start() {
      if (running) return;
      running = true;
      last = performance.now();
      resize();
      requestAnimationFrame(frameLoop);
    },
    stop() { running = false; fly = null; bodycam = false; updateButtons(); },
    focusStop,
    setTime(detail) {
      hudTime = detail;
      if (detail?.utc) { const r = sunRow(state.sun, state.eva, detail.utc); if (r) setSun(r); }
      placeAstronaut();
    },
  };
}
