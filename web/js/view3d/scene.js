// 3D scene (Egemen): terrain with HiRISE imagery, the planned route, stops,
// habitat, shelters, Curiosity's traverse, the Sun from sun.json and the
// astronaut from hud:time. Loaded lazily by index.js.
//
// three.js r160 (MIT, https://github.com/mrdoob/three.js), from jsDelivr with a pinned version.
import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.0/+esm';
import { OrbitControls } from 'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/controls/OrbitControls.js/+esm';
import {
  makeFrame, sampleGrid, routeCoords, buildHeights, buildBaseImage, overlayChoices, composeImage,
  strataCanvas, STRATA_STEP_M,
} from './terrain.js';
import { chaikin, makeTrail, resampleXZ } from './trail.js';

const EXAGGERATIONS = [1, 2, 3];
// true scale on the real DEM; the flat placeholder needs a boost to show anything
// 2x by default: Mount Sharp's relief reads at a glance; 1x (true scale) is one click away
const DEFAULT_EXAGGERATION = { real: 2, placeholder: 2 };
// Lighting: the Sun from sun.json (real EVA-time angle); without it a low default sun shows relief
const SUN_DEFAULT = { sun_az: 135, sun_el: 30 };
const SUN_INTENSITY = 2.7;
const SKY_INTENSITY = 0.5;         // hemisphere fill: shadows stay readable, never black
const ROUTE_STEP_M = 4;            // trail points every 4 m
const PIN_HEIGHT_M = 40;
const FLY_SPEED_M_S = 45;          // fly-through speed along the route
// Route trails (display only; the route data is not changed)
const TRAIL_LIFT_M = 1.2;          // above the ground (x exaggeration), never buried
const TRAIL_SMOOTH = 2;            // Chaikin passes that round the grid staircase
const TRAIL_W_ON = 4;              // selected route ribbon width (m)
const TRAIL_GLOW = 3.4;            // its glow, as a multiple of that width
const TRAIL_W_OFF = 1.8;           // other routes: thin and faint
const TRAIL_OFF_OPACITY = 0.55;
const TRAIL_W_REF = 2.6;           // planned walk and Curiosity's path (when switched on)
const TRAIL_HIT_M = 30;            // click target width for the faint routes
// The astronaut draws the route: constant speed along it (by distance, not time), easing in and
// out at the ends, leaving the line behind like a pen on paper
const PEN_REVEAL_M_S = 1100;       // when a route is picked or the 3D view opens: a quick sketch
const PEN_FLY_M_S = 60;            // "Fly along your route" at 1x: the camera follows the astronaut
const SPEEDS = [1, 2, 4];          // simulation speed buttons
const PEN_RAMP_S = 0.7;            // time to reach full speed, and to slow down to B
const PEN_REST_MS = 700;           // the astronaut rests on B, then goes; the line stays
const CAM_FOLLOW = 2.2;            // camera smoothing (1/s): higher = tighter
const FLY_BACK_M = 120;            // fly-along camera: behind and above the snake's head
const FLY_UP_M = 80;
// Pen and A / B markers: about 2-3x the line width on screen, kept within limits when zooming
const MARK_SCREEN = 0.0042;        // size as a share of the distance to the camera
const MARK_MIN_M = 2.5;
const MARK_MAX_M = 9;
// Bodycam: the HUD astronaut's view (hud:time), looking where they walk; the astronaut figure
// is hidden. A little above true eye height: the terrain grid is ~9 m and the height is
// exaggerated, so a 1.7 m camera would sit in the blur.
const BODY_BACK_M = 6;             // camera this far behind the astronaut's position
const BODY_UP_M = 7;               // and this far above the ground there
const BODY_LOOK_M = 90;            // looks at a point this far ahead
const BODY_CLEAR_M = 4;            // never closer than this to the ground under the camera
const FOCUS_MS = 1400;
// World beyond the DEM tile (all as multiples of the tile size)
const SKIRT_SCALE = 7;             // ground plane width
const SKIRT_SEGMENTS = 160;
const SKIRT_SETTLE = 0.6;          // edge heights settle to the mean level over this distance
const SKIRT_DROP_M = 3;            // ground beyond sits this much lower, so the DEM covers it
const SKIRT_UNDER_M = 60;          // under the DEM tile: this far below its lowest point
const EDGE_FADE = 0.035;           // share of the image blended into the ground colour at each edge
const FOG_NEAR = 0.85;
const FOG_FAR = 3.2;
const MAX_DIST = 1.5;              // camera never further than this from its target
const OVERVIEW_UP = 0.62;          // opening view, from the south
const OVERVIEW_BACK = 0.72;
const CAMERA_CLEAR_M = 12;         // camera stays this far above the ground (x exaggeration)

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

// Mars daytime sky from the palette: dusty butterscotch at the horizon, a deeper rust overhead.
// (hex palette colours only: THREE.Color does not parse color-mix())
const mixCss = (a, b, t) => new THREE.Color(a).lerp(new THREE.Color(b), t);
function marsSky() {
  const sand = css('--color-sand', '#8A6A2E');
  const paper = css('--color-surface-2', '#EEE4D6');
  const accent = css('--color-accent', '#B4532A');
  const dust = css('--color-dust', '#6B5A4E');
  const horizon = mixCss(paper, sand, 0.45).lerp(new THREE.Color(accent), 0.12);
  const zenith = mixCss(dust, accent, 0.35);
  return { horizon, zenith };
}

function skyTexture({ horizon, zenith }) {
  const c = document.createElement('canvas');
  c.width = 4; c.height = 256;
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0, `#${zenith.getHexString()}`);
  g.addColorStop(0.62, `#${zenith.clone().lerp(horizon, 0.75).getHexString()}`);
  g.addColorStop(1, `#${horizon.getHexString()}`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 4, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Average colour of an image (for the ground beyond the DEM)
function averageColor(canvas) {
  const c = document.createElement('canvas');
  c.width = 16; c.height = 16;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(canvas, 0, 0, 16, 16);
  const px = ctx.getImageData(0, 0, 16, 16).data;
  let r = 0; let g = 0; let b = 0;
  for (let i = 0; i < px.length; i += 4) { r += px[i]; g += px[i + 1]; b += px[i + 2]; }
  const n = px.length / 4;
  return `rgb(${Math.round(r / n)}, ${Math.round(g / n)}, ${Math.round(b / n)})`;
}

// Soften the image edges into that average colour, so the DEM edge has no hard line
function fadeEdges(canvas, color, share) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width; const hgt = canvas.height;
  const bw = Math.round(w * share); const bh = Math.round(hgt * share);
  const band = (x0, y0, x1, y1, x, y, ww, hh) => {
    const g = ctx.createLinearGradient(x0, y0, x1, y1);
    g.addColorStop(0, color);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x, y, ww, hh);
  };
  band(0, 0, bw, 0, 0, 0, bw, hgt);
  band(w, 0, w - bw, 0, w - bw, 0, bw, hgt);
  band(0, 0, 0, bh, 0, 0, w, bh);
  band(0, hgt, 0, hgt - bh, 0, hgt - bh, w, bh);
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
    textInv: css('--color-text-inverse', 'white'),
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
  // World: the DEM tile, a ground beyond it that fades into dusty haze, and a Mars sky
  const sky = marsSky();
  const worldSize = Math.max(frame.width, frame.depth);
  scene.background = skyTexture(sky);
  scene.fog = new THREE.Fog(sky.horizon, worldSize * FOG_NEAR, worldSize * FOG_FAR);

  const camera = new THREE.PerspectiveCamera(45, 1, 1, 20000);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI * 0.47;
  controls.minDistance = 30;
  controls.maxDistance = worldSize * MAX_DIST;

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

  // Ground beyond the DEM (no data there: no relief is invented). It continues the edge heights
  // and settles to the mean level, sits a little lower so the DEM always covers it, in the
  // average colour of the imagery, and disappears into the fog.
  const skirtGeo = new THREE.PlaneGeometry(worldSize * SKIRT_SCALE, worldSize * SKIRT_SCALE, SKIRT_SEGMENTS, SKIRT_SEGMENTS);
  skirtGeo.rotateX(-Math.PI / 2);
  const groundColor = averageColor(base.canvas);
  fadeEdges(base.canvas, groundColor, EDGE_FADE);
  texture.needsUpdate = true;
  const skirt = new THREE.Mesh(skirtGeo, new THREE.MeshStandardMaterial({ color: groundColor, roughness: 1, metalness: 0 }));
  skirt.receiveShadow = true;
  scene.add(skirt);
  const zMean = zBase;
  // lowest DEM point: under the DEM tile the ground plane sits well below it (its coarse grid
  // would otherwise poke through narrow valleys as flat grey patches)
  let zLow = Infinity;
  for (const z of grid.z) if (z < zLow) zLow = z;
  function skirtHeights() {
    const p = skirtGeo.attributes.position;
    const hw = frame.width / 2; const hd = frame.depth / 2;
    for (let k = 0; k < p.count; k++) {
      const x = p.getX(k); const zz = p.getZ(k);
      if (Math.abs(x) < hw && Math.abs(zz) < hd) {
        p.setY(k, (zLow - zBase) * exag - SKIRT_UNDER_M);
        continue;
      }
      const cx = Math.min(Math.max(x, -hw), hw); const cz = Math.min(Math.max(zz, -hd), hd);
      const out = Math.hypot(x - cx, zz - cz);
      const f = Math.min(out / (worldSize * SKIRT_SETTLE), 1);
      const ease = f * f * (3 - 2 * f);
      const z = sampleGrid(grid, cx, cz) * (1 - ease) + zMean * ease;
      p.setY(k, (z - zBase) * exag - SKIRT_DROP_M * exag);
    }
    p.needsUpdate = true;
    skirtGeo.computeVertexNormals();
  }

  function applyHeights() {
    const p = geo.attributes.position;
    for (let k = 0; k < p.count; k++) p.setY(k, (grid.z[k] - zBase) * exag);
    p.needsUpdate = true;
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    skirtHeights();
  }
  applyHeights();

  // ----- lights (Sun from sun.json)
  // sky fill from above (Mars sky), dusty bounce from below: soft, so the Sun's shading carries the relief
  const hemi = new THREE.HemisphereLight(sky.horizon, new THREE.Color(colors.dust), SKY_INTENSITY);
  scene.add(hemi);
  const sunLight = new THREE.DirectionalLight(0xffffff, SUN_INTENSITY);
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
    const az = ((row?.sun_az ?? SUN_DEFAULT.sun_az) * Math.PI) / 180;
    const el = Math.max(row?.sun_el ?? SUN_DEFAULT.sun_el, 2) * (Math.PI / 180);
    const dir = new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
    sunLight.position.copy(dir.multiplyScalar(5000));
    const day = (row?.sun_el ?? SUN_DEFAULT.sun_el) > 0;
    sunLight.intensity = day ? SUN_INTENSITY : 0.05;
    hemi.intensity = day ? SKY_INTENSITY : 0.18;
    updateInfo();
  }

  // ----- overlays group (rebuilt when the exaggeration changes)
  const marks = new THREE.Group();
  scene.add(marks);
  const pickables = [];
  const coords = routeCoords(state.route);
  let plannedTrail = null;     // Demir's planned walk
  let traverseGroup = null;    // Curiosity's path
  const show = { planned: false, traverse: false };   // both off at first, like the 2D map
  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  // [lon, lat] path -> points on the terrain: grid corners rounded (Chaikin), evenly spaced,
  // each at the ground height there plus a small lift. Display only.
  function drape(path) {
    const xz = [];
    for (const c of path) {
      if (!Array.isArray(c)) continue;
      const p = frame.toXZ(c[0], c[1]);
      const prev = xz[xz.length - 1];
      if (!prev || prev[0] !== p[0] || prev[1] !== p[1]) xz.push(p);
    }
    return resampleXZ(chaikin(xz, TRAIL_SMOOTH), ROUTE_STEP_M)
      .map(([x, z]) => new THREE.Vector3(x, yAt(x, z) + TRAIL_LIFT_M * exag, z));
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

    // planned science walk (Demir's route, the one the HUD follows): off until switched on in the key
    plannedTrail = null;
    if (coords.length >= 2) {
      plannedTrail = makeTrail(THREE, drape(coords), { color: colors.sand, width: TRAIL_W_REF, head: true });
      plannedTrail.visible = show.planned;
      marks.add(plannedTrail);
    }

    // Curiosity's path, split at re-entries so no fake jumps are drawn: off until switched on
    traverseGroup = new THREE.Group();
    traverseGroup.visible = show.traverse;
    const tg = state.traverse?.geometry || state.traverse?.features?.[0]?.geometry;
    if (tg?.coordinates?.length) {
      const parts = [];
      if (tg.type === 'MultiLineString') parts.push(...tg.coordinates);
      else {
        const br = [0, ...(state.traverse.properties?.breaks || []), tg.coordinates.length];
        for (let i = 0; i < br.length - 1; i++) parts.push(tg.coordinates.slice(br[i], br[i + 1]));
      }
      for (const part of parts) {
        if (part.length < 2) continue;
        traverseGroup.add(makeTrail(THREE, drape(part), { color: colors.info, width: TRAIL_W_REF }));
      }
    }
    marks.add(traverseGroup);

    // habitat
    const hab = state.area.habitat;
    if (Array.isArray(hab)) {
      const p = posLL(hab[0], hab[1]);
      const dome = new THREE.Mesh(
        new THREE.SphereGeometry(9, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2),
        new THREE.MeshStandardMaterial({ color: colors.textInv, roughness: 0.35, metalness: 0.15 }),   // a light dome, not a black blob
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
    buildNav();
  }

  // ----- your own routes (cards navigation: nav:routes / nav:choose / nav:clear)
  // Fastest = info, safest = ok, alternative = sand: the same colours as the option cards.
  const navGroup = new THREE.Group();
  scene.add(navGroup);
  let nav = null;           // {start, end, options[], chosen}
  let navTrail = null;      // the selected route's trail
  const navHits = [];       // click targets of the other routes
  colors.muted = css('--color-muted-route', colors.dust);

  // A / B: a small disc on the ground with a light rim, and its letter just above; unit size,
  // scaled every frame like the astronaut (markScale)
  const navPins = [];
  function navPin(coord, letter, color) {
    const g = new THREE.Group();
    const mark = new THREE.Group();   // scaled every frame; the letter keeps its own screen size
    const lit = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.35, roughness: 0.5 });
    const dot = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 12), lit);
    const rim = new THREE.Mesh(new THREE.SphereGeometry(1.3, 20, 12), new THREE.MeshBasicMaterial({ color: colors.textInv, side: THREE.BackSide }));
    dot.scale.y = 0.55; rim.scale.y = 0.55;   // a flattened bead, it does not hide the line
    mark.add(rim, dot);
    const lab = labelSprite(letter, color);
    lab.scale.multiplyScalar(0.7);
    g.add(mark, lab);
    g.position.copy(posLL(coord[0], coord[1], TRAIL_LIFT_M * exag));
    g.userData = { mark, lab };
    navPins.push(g);
    return g;
  }
  const markSize = (obj) => Math.min(Math.max(camera.position.distanceTo(obj.position) * MARK_SCREEN, MARK_MIN_M), MARK_MAX_M);
  function markScale(obj) { obj.scale.setScalar(markSize(obj)); }
  function pinScale(pin) {
    const r = markSize(pin);
    pin.userData.mark.scale.setScalar(r);
    pin.userData.lab.position.y = r * 1.4;
  }

  // Only the selected route stands out (oxide, glowing); the others are thin, faint and clickable
  function buildNav() {
    navGroup.clear();
    navTrail = null;
    navHits.length = 0;
    navPins.length = 0;
    if (nav) {
      for (const o of nav.options || []) {
        const c = o.feature?.geometry?.coordinates;
        if (!Array.isArray(c) || c.length < 2) continue;
        if (o.id === nav.chosen) {
          navTrail = makeTrail(THREE, drape(c), {
            color: colors.accent, width: TRAIL_W_ON, glow: TRAIL_GLOW, head: true, headColor: colors.accent, rimColor: colors.textInv,
          });
          navTrail.renderOrder = 6;
          navGroup.add(navTrail);
        } else {
          const t = makeTrail(THREE, drape(c), { color: colors.muted, width: TRAIL_W_OFF, opacity: TRAIL_OFF_OPACITY, hitWidth: TRAIL_HIT_M });
          t.hit.userData.navId = o.id;
          navHits.push(t.hit);
          navGroup.add(t);
        }
      }
      if (Array.isArray(nav.start)) navGroup.add(navPin(nav.start, 'A', colors.text));
      if (Array.isArray(nav.end)) navGroup.add(navPin(nav.end, 'B', colors.accent));
    }
    // a snake already under way carries on over the rebuilt trail; otherwise draw it whole
    if (!snake) activeTrail()?.setProgress(1);
    updateLegend();
  }

  function setNav(detail) {
    nav = detail && Array.isArray(detail.options) ? { ...detail } : null;
    snake = null;
    buildNav();
    updateButtons();
    if (nav?.options?.length) { frameNav(); playSnake(); }
  }

  function chooseNav(id) {
    if (!nav || nav.chosen === id) return;
    nav.chosen = id;
    snake = null;
    buildNav();
    updateButtons();
    playSnake();
  }

  // ----- the astronaut draws the active route from A to B, like a pen line on paper
  // Speed is constant along the way (m/s), with a short ease in and out: distance s(t) follows a
  // trapezoid speed profile, so a long route takes longer but the astronaut always moves the same.
  // The clock (elapsed) runs at the chosen simulation speed, so changing it keeps the position.
  let snake = null;   // {elapsed (s), v, ramp, total (s), follow, doneAt}
  let speed = 1;
  const activeTrail = () => navTrail || (show.planned ? plannedTrail : null);
  function playSnake({ follow = false } = {}) {
    const t = activeTrail();
    if (!t) return;
    if (reducedMotion) { snake = null; t.setProgress(1); return; }
    const v = follow ? PEN_FLY_M_S : PEN_REVEAL_M_S;
    const ramp = Math.min(PEN_RAMP_S, t.len / v);     // a very short route: ramps only
    snake = { elapsed: 0, v, ramp, total: t.len / v + ramp, follow, doneAt: null };
    t.setProgress(0);
  }
  function penDistance(sn, len, tSec) {
    const { v, ramp, total } = sn;
    if (tSec <= 0) return 0;
    if (tSec >= total) return len;
    if (tSec < ramp) return (v * tSec * tSec) / (2 * ramp);
    if (tSec > total - ramp) return len - (v * (total - tSec) ** 2) / (2 * ramp);
    return v * (tSec - ramp / 2);
  }
  function stepSnake(now, dt) {
    if (!snake) return;
    const t = activeTrail();
    if (!t) { snake = null; return; }
    snake.elapsed += dt * (snake.follow ? speed : 1);
    const tSec = snake.elapsed;
    const s = Math.min(penDistance(snake, t.len, tSec), t.len);
    const done = tSec >= snake.total;
    if (done && snake.doneAt == null) snake.doneAt = now;
    t.setProgress(s / t.len, { keepHead: done });
    if (t.head?.visible) {
      markScale(t.head);
      t.head.position.y += t.head.scale.x * 0.7;   // the dot stands on the line, not in the ground
    }
    if (snake.follow) {
      // camera behind and above the astronaut, looking a little ahead; smoothed by time, no shake
      const head = t.pointAt(s);
      const ahead = t.pointAt(Math.min(s + 60, t.len));
      const back = head.clone().sub(ahead).setY(0);
      if (back.lengthSq() < 1e-6) back.copy(camera.position).sub(head).setY(0);
      if (back.lengthSq() < 1e-6) back.set(0, 0, 1);
      back.normalize();
      const want = head.clone().addScaledVector(back, FLY_BACK_M).add(new THREE.Vector3(0, FLY_UP_M, 0));
      const a = 1 - Math.exp(-dt * CAM_FOLLOW);
      camera.position.lerp(want, a);
      controls.target.lerp(done ? head : ahead, Math.min(1, a * 1.6));
    }
    if (done && now - snake.doneAt >= PEN_REST_MS) {
      const wasFlying = snake.follow;
      snake = null;
      t.setProgress(1);
      if (wasFlying) updateButtons();
    }
  }

  function frameNav() {
    if (!nav || bodycam) return;
    const box = new THREE.Box3();
    for (const o of nav.options) for (const c of o.feature?.geometry?.coordinates || []) box.expandByPoint(posLL(c[0], c[1]));
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const size = Math.max(box.getSize(new THREE.Vector3()).length(), 400);
    moveTo(center.clone().add(new THREE.Vector3(0.15 * size, 0.6 * size, 0.9 * size)), center);
  }

  // pick mode: the next click on the terrain becomes a point for the planner
  let pickWhich = null;
  function setPick(which) {
    pickWhich = which === 'start' || which === 'end' ? which : null;
    pickBanner.hidden = !pickWhich;
    if (pickWhich) pickBanner.textContent = `Click the terrain to place ${pickWhich === 'start' ? 'A, the start' : 'B, the destination'} · Esc cancels`;
    renderer.domElement.style.cursor = pickWhich ? 'crosshair' : 'grab';
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
  let bodycam = false; // camera follows the HUD astronaut

  function overview() {
    // the whole DEM tile, from the south, filling the screen
    const center = new THREE.Vector3(0, yAt(0, 0), 0);
    return { target: center, pos: center.clone().add(new THREE.Vector3(0, OVERVIEW_UP * worldSize, OVERVIEW_BACK * worldSize)) };
  }

  // Keep the camera over the world: the target stays on the DEM tile, the camera above the ground
  // and not too far out (the fog and the sky never show their limits)
  const hw = frame.width / 2; const hd = frame.depth / 2;
  function clampCamera() {
    const t = controls.target;
    const tx = Math.min(Math.max(t.x, -hw), hw); const tz = Math.min(Math.max(t.z, -hd), hd);
    if (tx !== t.x || tz !== t.z) {
      camera.position.x += tx - t.x; camera.position.z += tz - t.z;
      t.x = tx; t.z = tz;
    }
    const groundUnder = Math.max(yAt(camera.position.x, camera.position.z), skirtYAt(camera.position.x, camera.position.z));
    const minY = groundUnder + CAMERA_CLEAR_M * Math.max(exag, 1);
    if (camera.position.y < minY) camera.position.y = minY;
  }
  function skirtYAt(x, z) {
    const r = Math.hypot(Math.max(Math.abs(x) - hw, 0), Math.max(Math.abs(z) - hd, 0));
    return r > 0 ? -SKIRT_DROP_M * exag : -Infinity;
  }

  function moveTo(pos, target, ms = FOCUS_MS) {
    if (snake?.follow) { snake = null; activeTrail()?.setProgress(1); }
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

  const flying = () => !!snake?.follow;
  function stopFly() {
    if (!flying()) return;
    snake = null;
    activeTrail()?.setProgress(1);
    updateButtons();
  }
  // The button always (re)starts the drawing from A; pressing it mid-way starts over, never stacks
  function toggleFly() {
    snake = null;
    // no route of your own yet: fly the planned science walk (shown for the flight)
    if (!navTrail && plannedTrail && !show.planned) setShow('planned', true);
    if (!activeTrail()) return;
    tween = null;
    bodycam = false;
    playSnake({ follow: true });
    updateButtons();
  }
  // Bodycam: the camera follows the HUD astronaut, looking where they walk (storm refuge, dust devil
  // step-aside, detours). The HUD drives the position through hud:time; open it with H and press Play.
  function toggleBodycam() {
    bodycam = !bodycam;
    if (bodycam) { stopFly(); tween = null; }
    updateButtons();
  }


  function setShow(key, on) {
    show[key] = on;
    if (key === 'planned' && plannedTrail) { plannedTrail.visible = on; if (on && !navTrail) playSnake(); }
    if (key === 'traverse' && traverseGroup) traverseGroup.visible = on;
    updateLegend();
    updateButtons();
  }

  // ----- UI
  const info = h('p', { class: 'v3d-info' });
  const flyBtn = h('button', { class: 'v3d-btn v3d-btn--primary', type: 'button', onclick: toggleFly },
    'Fly along route');
  const speedBtns = SPEEDS.map((x) => h('button', {
    class: 'v3d-seg', type: 'button', 'aria-pressed': String(x === speed),
    title: `Simulation speed ${x}x (${PEN_FLY_M_S * x} m/s along the route)`,
    onclick: () => { speed = x; updateButtons(); },
  }, `${x}×`));
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
    title: x === 1 ? 'True scale: heights as measured' : `Heights stretched ${x} times to show the relief`,
    'aria-label': x === 1 ? '1 times, true scale' : `${x} times`,
    onclick: () => setExag(x),
  }, x === 1 ? '1× true' : `${x}×`));
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

  // Map key: a small button top-right that opens the legend, the switches and the sources
  const toggleRow = (key, cls, label) => {
    const box = h('input', { type: 'checkbox', onchange: (e) => setShow(key, e.target.checked) });
    box.checked = show[key];
    return { box, li: h('li', {}, h('label', { class: 'v3d-switch' }, box, h('span', { class: `v3d-key ${cls}` }), label)) };
  };
  const plannedRow = coords.length >= 2 ? toggleRow('planned', 'v3d-key--planned', 'Planned science walk') : null;
  const traverseRow = state.traverse ? toggleRow('traverse', 'v3d-key--traverse', "Curiosity rover's path") : null;
  const yourRoute = h('li', { hidden: true }, h('span', { class: 'v3d-key v3d-key--route' }), 'Your route (selected)');
  const otherRoutes = h('li', { hidden: true }, h('span', { class: 'v3d-key v3d-key--other' }), 'Other options (click to pick)');
  const legend = h('ul', { class: 'v3d-legend' },
    yourRoute, otherRoutes,
    plannedRow?.li, traverseRow?.li,
    h('li', {}, h('span', { class: 'v3d-key v3d-key--stop' }), 'Science stops'),
    h('li', {}, h('span', { class: 'v3d-key v3d-key--shelter' }), 'Shelters'),
    h('li', {}, h('span', { class: 'v3d-key v3d-key--astro' }), 'Astronaut (HUD clock)'),
  );
  function updateLegend() {
    yourRoute.hidden = !navTrail;
    otherRoutes.hidden = !navHits.length;
    if (plannedRow) plannedRow.box.checked = show.planned;
    if (traverseRow) traverseRow.box.checked = show.traverse;
  }
  const pickBanner = h('p', { class: 'v3d-pick', hidden: true, role: 'status' });

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

  const keyPanel = h('div', { class: 'v3d-keypanel', id: 'v3d-keypanel', hidden: true },
    h('p', { class: 'v3d-kicker' }, '3D terrain'),
    info,
    legend,
    h('p', { class: heights.real ? 'v3d-src' : 'v3d-src v3d-src--warn' }, heights.label),
    h('p', { class: 'v3d-src' }, `Image: ${base.label}`),
    h('p', { class: 'v3d-src' }, 'Drag to orbit · right-drag to pan · scroll to zoom · click a stop or a faint route'));
  const keyBtn = h('button', {
    class: 'v3d-keybtn', type: 'button', 'aria-expanded': 'false', 'aria-controls': 'v3d-keypanel',
    onclick: () => {
      keyPanel.hidden = !keyPanel.hidden;
      keyBtn.setAttribute('aria-expanded', String(!keyPanel.hidden));
    },
  }, 'Map key');

  const ui = h('div', { class: 'v3d-ui' },
    h('div', { class: 'v3d-top' },
      strataPanel,
      h('div', { class: 'v3d-keywrap' }, keyBtn, keyPanel)),
    h('div', { class: 'v3d-bar' },
      flyBtn,
      bodyBtn,
      h('div', { class: 'v3d-tools' },
        h('div', { class: 'v3d-group', role: 'group', 'aria-label': 'Simulation speed' },
          h('span', { class: 'v3d-group-label' }, 'Speed'), speedBtns),
        h('div', { class: 'v3d-group', role: 'group', 'aria-label': 'Vertical exaggeration' },
          h('span', { class: 'v3d-group-label' }, 'Vertical exaggeration'), exagBtns),
        h('div', { class: 'v3d-calm' }, resetBtn, overlaySel))),
    pickBanner);

  function updateButtons() {
    flyBtn.textContent = flying() ? 'Draw again from A' : navTrail ? 'Fly along your route' : 'Fly along the planned walk';
    flyBtn.disabled = !navTrail && !plannedTrail;
    flyBtn.setAttribute('aria-pressed', String(flying()));
    bodyBtn.textContent = bodycam ? 'Stop bodycam' : 'Bodycam';
    bodyBtn.setAttribute('aria-pressed', String(bodycam));
    speedBtns.forEach((b, i) => b.setAttribute('aria-pressed', String(SPEEDS[i] === speed)));
    // while the astronaut walks, only the main action, the speed and the height stay in the bar
    ui.classList.toggle('is-flying', flying());
    exagBtns.forEach((b, i) => b.setAttribute('aria-pressed', String(EXAGGERATIONS[i] === exag)));
  }

  function updateInfo() {
    const bits = [];
    if (sunInfo) bits.push(`Sun ${Math.round(sunInfo.sun_el)}° high, az ${Math.round(sunInfo.sun_az)}°`, `LMST ${sunInfo.lmst}`);
    bits.push(exag === 1 ? 'true scale' : `heights ×${exag}`);
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
    if (pickWhich) {
      // a stop pin snaps to the stop itself; anywhere else: the terrain under the cursor
      const pin = ray.intersectObjects(pickables, false)[0]?.object.userData.stop;
      const ground = ray.intersectObject(terrain, false)[0]?.point;
      const coord = Array.isArray(pin?.coord) ? pin.coord : ground ? frame.toLonLat(ground.x, ground.z) : null;
      if (coord) {
        const which = pickWhich;
        setPick(null);
        document.dispatchEvent(new CustomEvent('nav:point', { detail: { which, coord } }));
      }
      return;
    }
    const hit = ray.intersectObjects(pickables, false)[0];
    if (hit?.object.userData.stop) {
      document.dispatchEvent(new CustomEvent('stop:select', { detail: hit.object.userData.stop }));
      return;
    }
    const route = navHits.length ? ray.intersectObjects(navHits, false)[0] : null;
    if (route?.object.userData.navId) {
      document.dispatchEvent(new CustomEvent('nav:choose', { detail: { id: route.object.userData.navId } }));
    }
  });
  renderer.domElement.style.cursor = 'grab';
  renderer.domElement.addEventListener('pointermove', (e) => {
    const r = renderer.domElement.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    renderer.domElement.style.cursor = pickWhich ? 'crosshair'
      : ray.intersectObjects(pickables, false).length || (navHits.length && ray.intersectObjects(navHits, false).length) ? 'pointer' : 'grab';
  });
  controls.addEventListener('start', () => {
    tween = null;
    if (flying() || bodycam) { stopFly(); bodycam = false; updateButtons(); }
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
    stepSnake(now, dt);
    for (const p of navPins) pinScale(p);
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
    clampCamera();
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
      playSnake();   // opening the 3D view draws the route from A to B
      requestAnimationFrame(frameLoop);
    },
    stop() { running = false; snake = null; activeTrail()?.setProgress(1); bodycam = false; updateButtons(); },
    focusStop,
    setNav,
    chooseNav,
    setPick,
    setTime(detail) {
      hudTime = detail;
      if (detail?.utc) { const r = sunRow(state.sun, state.eva, detail.utc); if (r) setSun(r); }
      placeAstronaut();
    },
  };
}
