// 3D scene (Egemen): terrain with HiRISE imagery, the planned route, stops,
// habitat, shelters, Curiosity's traverse, the Sun from sun.json and the
// astronaut from hud:time. Loaded lazily by index.js.
//
// three.js r160 (MIT, https://github.com/mrdoob/three.js), from jsDelivr with a pinned version.
import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.0/+esm';
import { OrbitControls } from 'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/controls/OrbitControls.js/+esm';
import {
  makeFrame, sampleGrid, routeCoords, buildHeights, buildBaseImage, overlayChoices, composeImage, distM,
} from './terrain.js';

const EXAGGERATIONS = [1, 2, 3];
const DEFAULT_EXAGGERATION = 2;
const ROUTE_LIFT_M = 1.5;          // keep lines just above the surface
const ROUTE_STEP_M = 4;            // resample the route for a smooth tube
const PIN_HEIGHT_M = 40;
const FLY_SPEED_M_S = 45;          // fly-through speed along the route
const FOCUS_MS = 1400;

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
  };

  onProgress?.('Building terrain…');
  const heights = await buildHeights(state, frame);
  const { grid } = heights;
  let zBase = 0;
  { let s = 0; for (const z of grid.z) s += z; zBase = s / grid.z.length; }
  let exag = DEFAULT_EXAGGERATION;
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

  function buildMarks() {
    marks.clear();
    pickables.length = 0;

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
      const lab = labelSprite(`${i + 1}  ${stop.name || stop.id}`, colors.sand);
      lab.position.copy(head.position).add(new THREE.Vector3(0, 6, 0));
      marks.add(stick, head, lab);
      pickables.push(head, stick);
    });

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

  function placeAstronaut() {
    const t = hudTime;
    const show = !!(t?.active && Array.isArray(t.coord));
    astro.visible = show;
    shelterLine.visible = false;
    if (!show) return;
    astro.position.copy(posLL(t.coord[0], t.coord[1]));
    if (t.storm && Array.isArray(t.shelter)) {
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

  function overview() {
    const box = new THREE.Box3();
    if (coords.length) for (const c of coords) box.expandByPoint(posLL(c[0], c[1]));
    else box.setFromObject(terrain);
    const center = box.getCenter(new THREE.Vector3());
    const size = Math.max(box.getSize(new THREE.Vector3()).length(), 600);
    return { target: center, pos: center.clone().add(new THREE.Vector3(-0.55 * size, 0.6 * size, 0.85 * size)) };
  }

  function moveTo(pos, target, ms = FOCUS_MS) {
    fly = null;
    if (ms <= 0) { camera.position.copy(pos); controls.target.copy(target); return; }
    tween = { from: camera.position.clone(), to: pos, fromT: controls.target.clone(), toT: target, start: performance.now(), ms };
  }

  function focusStop(stop, { instant = false } = {}) {
    if (!Array.isArray(stop?.coord)) return;
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
    fly = { s: 0 };
    updateButtons();
  }

  // ----- UI
  const info = h('p', { class: 'v3d-info' });
  const flyBtn = h('button', { class: 'v3d-btn v3d-btn--primary', type: 'button', onclick: toggleFly, disabled: !coords.length },
    'Fly along route');
  const resetBtn = h('button', {
    class: 'v3d-btn', type: 'button',
    onclick: () => { const o = overview(); moveTo(o.pos, o.target); updateButtons(); },
  }, 'Reset view');
  const exagBtns = EXAGGERATIONS.map((x) => h('button', {
    class: 'v3d-seg', type: 'button', 'aria-pressed': String(x === exag),
    onclick: () => setExag(x),
  }, `${x}×`));
  const choices = overlayChoices(state);
  const overlaySel = h('select', {
    class: 'v3d-select', 'aria-label': 'Layer draped on the terrain',
    onchange: async (e) => {
      const o = choices[Number(e.target.value)] || null;
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

  const ui = h('div', { class: 'v3d-ui' },
    h('div', { class: 'v3d-top' },
      h('div', { class: 'v3d-title' },
        h('p', { class: 'v3d-kicker' }, '3D terrain'),
        info,
        h('p', { class: heights.real ? 'v3d-src' : 'v3d-src v3d-src--warn' }, heights.label),
        h('p', { class: 'v3d-src' }, `Image: ${base.label}`)),
      legend),
    h('div', { class: 'v3d-bar' },
      flyBtn, resetBtn,
      h('div', { class: 'v3d-group', role: 'group', 'aria-label': 'Vertical exaggeration' },
        h('span', { class: 'v3d-group-label' }, 'Height'), exagBtns),
      overlaySel),
    h('p', { class: 'v3d-hint' }, 'Drag to orbit · right-drag to pan · scroll to zoom · click a stop'));

  function updateButtons() {
    flyBtn.textContent = fly ? 'Stop flight' : 'Fly along route';
    flyBtn.setAttribute('aria-pressed', String(!!fly));
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
  controls.addEventListener('start', () => { tween = null; if (fly) { fly = null; updateButtons(); } });

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
    stop() { running = false; fly = null; updateButtons(); },
    focusStop,
    setTime(detail) {
      hudTime = detail;
      if (detail?.utc) { const r = sunRow(state.sun, state.eva, detail.utc); if (r) setSun(r); }
      placeAstronaut();
    },
  };
}
