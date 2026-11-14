// block3d.js (Ege): hero block diagram. The study area as a terrain block standing on the
// page like a paper model: HiRISE image on top, textbook strata on the sides (clay below,
// sulfate above), the planned route, stops and habitat, lit by the Sun at the start of the
// EVA window. Very slow turn, slight tilt with the pointer, closer to the route on scroll.
//
//   const block = await initBlock(container, { hm, layers, route, stops, area, sunDir, colors })
//   block.dispose()

import * as THREE from 'three';

const MARS_R = 3396190;
const WIDTH = 10;              // scene units across the block (west to east)
const BASE = 0.7;              // block thickness below the lowest point, in scene units
const EXAGGERATION = 1.6;      // vertical exaggeration
const TEXTURE_ZOOM = 13;       // Mars Trek zoom for the top image (about 9 tiles)
const TURN_RAD_PER_S = 0.035;  // a full turn takes about three minutes

// Stitch Mars Trek tiles (EPSG4326 scheme) and crop them to the bounds.
// If Mars Trek is unreachable, the same tiles come from the backup cache (fallbackUrl).
async function topTexture(layer, b) {
  try {
    return await stitch(layer.url, layer, b);
  } catch (err) {
    if (!layer.fallbackUrl) throw err;
    return stitch(layer.fallbackUrl, layer, b);
  }
}

async function stitch(template, layer, b) {
  const z = Math.min(TEXTURE_ZOOM, layer.maxNativeZoom ?? TEXTURE_ZOOM);
  const deg = 180 / 2 ** z;
  const x0 = Math.floor((b.west + 180) / deg);
  const x1 = Math.floor((b.east + 180) / deg);
  const y0 = Math.floor((90 - b.north) / deg);
  const y1 = Math.floor((90 - b.south) / deg);
  const tile = 256;
  const mosaic = document.createElement('canvas');
  mosaic.width = (x1 - x0 + 1) * tile;
  mosaic.height = (y1 - y0 + 1) * tile;
  const ctx = mosaic.getContext('2d');
  const jobs = [];
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const url = template.replace('{z}', z).replace('{y}', y).replace('{x}', x);
      jobs.push(new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => { ctx.drawImage(img, (x - x0) * tile, (y - y0) * tile); resolve(); };
        img.onerror = reject;
        img.src = url;
      }));
    }
  }
  const results = await Promise.allSettled(jobs);
  if (!results.some((r) => r.status === 'fulfilled')) throw new Error('no map tiles');

  // Crop the mosaic to the exact bounds
  const sx = ((b.west + 180) / deg - x0) * tile;
  const sy = ((90 - b.north) / deg - y0) * tile;
  const sw = ((b.east - b.west) / deg) * tile;
  const sh = ((b.north - b.south) / deg) * tile;
  const out = document.createElement('canvas');
  out.width = 512;
  out.height = 512;
  out.getContext('2d').drawImage(mosaic, sx, sy, sw, sh, 0, 0, out.width, out.height);
  const texture = new THREE.CanvasTexture(out);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

// Vertical strata for the block sides: clay at the bottom grading into sulfate at the top
function strataTexture(colors) {
  const c = document.createElement('canvas');
  c.width = 4;
  c.height = 256;
  const ctx = c.getContext('2d');
  const clay = new THREE.Color(colors.clay);
  const sulfate = new THREE.Color(colors.sulfate);
  const paper = new THREE.Color(colors.paper);
  let y = 0;
  let i = 0;
  while (y < c.height) {
    const band = 10 + ((i * 7) % 13);             // uneven bed thickness
    const t = 1 - (y + band / 2) / c.height;      // 0 at the bottom, 1 at the top
    const col = clay.clone().lerp(sulfate, t).lerp(paper, i % 2 ? 0.28 : 0.12);
    ctx.fillStyle = `#${col.getHexString()}`;
    ctx.fillRect(0, y, c.width, band);
    ctx.fillStyle = `rgba(42,32,27,0.18)`;        // thin bedding line
    ctx.fillRect(0, y + band - 1, c.width, 1);
    y += band;
    i++;
  }
  const texture = new THREE.CanvasTexture(c);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export async function initBlock(container, { hm, layers, route, stops, area, sunDir, colors }) {
  const b = hm.bounds;
  const latMid = ((b.north + b.south) / 2) * (Math.PI / 180);
  const mPerUnit = ((b.east - b.west) * (Math.PI / 180) * MARS_R * Math.cos(latMid)) / WIDTH;
  const depth = (((b.north - b.south) * (Math.PI / 180) * MARS_R) / mPerUnit);
  const heightOf = (z) => BASE + ((z - hm.zMin) / mPerUnit) * EXAGGERATION;
  const toX = (lon) => ((lon - b.west) / (b.east - b.west) - 0.5) * WIDTH;
  const toZ = (lat) => ((b.north - lat) / (b.north - b.south) - 0.5) * depth;
  const groundAt = (lon, lat) => heightOf(hm.at(lon, lat) ?? hm.zMin);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  container.append(renderer.domElement);
  renderer.domElement.setAttribute('role', 'img');
  renderer.domElement.setAttribute('aria-label',
    'Block diagram of the study area: HiRISE image draped over the terrain, with the planned route, the stops and the habitat, and clay and sulfate layers on the sides.');

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(colors.paper, 30, 60);

  // Top surface from the heightmap (row 0 = north = -z after the rotation)
  const { width: w, height: h, z } = hm;
  const top = new THREE.PlaneGeometry(WIDTH, depth, w - 1, h - 1);
  top.rotateX(-Math.PI / 2);
  const pos = top.attributes.position;
  for (let i = 0; i < pos.count; i++) pos.setY(i, heightOf(z[i]));
  top.computeVertexNormals();
  const topMat = new THREE.MeshLambertMaterial({ color: colors.sand });
  scene.add(new THREE.Mesh(top, topMat));

  // Sides: one wall per edge, strata mapped by height
  const maxH = heightOf(hm.zMax);
  const strata = strataTexture(colors);
  const wallMat = new THREE.MeshLambertMaterial({ map: strata, side: THREE.DoubleSide });
  const edges = [
    (k) => [k, 0],             // north edge, west to east
    (k) => [w - 1, k],         // east edge, north to south
    (k) => [w - 1 - k, h - 1], // south edge, east to west
    (k) => [0, h - 1 - k],     // west edge, south to north
  ];
  for (const edge of edges) {
    const n = edge === edges[0] || edge === edges[2] ? w : h;
    const verts = [];
    const uvs = [];
    const idx = [];
    for (let k = 0; k < n; k++) {
      const [gx, gy] = edge(k);
      const x = (gx / (w - 1) - 0.5) * WIDTH;
      const zz = (gy / (h - 1) - 0.5) * depth;
      const y = heightOf(z[gy * w + gx]);
      verts.push(x, 0, zz, x, y, zz);
      uvs.push(k / (n - 1), 0, k / (n - 1), y / maxH);
      if (k > 0) {
        const a = (k - 1) * 2;
        idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    scene.add(new THREE.Mesh(g, wallMat));
  }
  const bottom = new THREE.Mesh(
    new THREE.PlaneGeometry(WIDTH, depth).rotateX(Math.PI / 2),
    new THREE.MeshLambertMaterial({ color: colors.line }),
  );
  scene.add(bottom);

  // Route as a thin oxide tube just above the ground
  const coords = route?.geometry?.coordinates ?? route?.features?.[0]?.geometry?.coordinates;
  let routeCenter = new THREE.Vector3(0, maxH * 0.5, 0);
  if (Array.isArray(coords) && coords.length > 1) {
    const pts = coords.map(([lon, lat]) => new THREE.Vector3(toX(lon), groundAt(lon, lat) + 0.05, toZ(lat)));
    const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
    const tube = new THREE.TubeGeometry(curve, Math.min(600, pts.length * 2), 0.065, 8, false);
    scene.add(new THREE.Mesh(tube, new THREE.MeshBasicMaterial({ color: colors.oxide })));
    routeCenter = pts.reduce((acc, p) => acc.add(p), new THREE.Vector3()).multiplyScalar(1 / pts.length);
  }

  // Stops: small pins; habitat: a small block
  const pinMat = new THREE.MeshLambertMaterial({ color: colors.ink });
  const headMat = new THREE.MeshLambertMaterial({ color: colors.sulfate });
  for (const stop of Array.isArray(stops) ? stops : []) {
    if (!Array.isArray(stop.coord)) continue;
    const [lon, lat] = stop.coord;
    const g = groundAt(lon, lat);
    const pin = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.7, 6), pinMat);
    pin.position.set(toX(lon), g + 0.35, toZ(lat));
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.13, 16, 12), headMat);
    head.position.set(toX(lon), g + 0.75, toZ(lat));
    scene.add(pin, head);
  }
  if (Array.isArray(area?.habitat)) {
    const [lon, lat] = area.habitat;
    const hab = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.2, 0.28), new THREE.MeshLambertMaterial({ color: colors.oxide }));
    hab.position.set(toX(lon), groundAt(lon, lat) + 0.1, toZ(lat));
    scene.add(hab);
  }

  // Light: the Sun at the start of the EVA window, plus a soft paper-coloured sky
  scene.add(new THREE.HemisphereLight(colors.paper, colors.sand, 1.5));
  const sun = new THREE.DirectionalLight(0xffffff, 1.9);
  const az = ((sunDir?.az ?? 110) * Math.PI) / 180;
  const el = ((Math.max(sunDir?.el ?? 35, 8)) * Math.PI) / 180;
  sun.position.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)).multiplyScalar(20);
  scene.add(sun);

  // The top image arrives after the first frame; until then the top is plain sand
  const base = (layers || []).find((l) => l.id === 'hirise') || (layers || []).find((l) => l.type === 'base');
  if (base) {
    topTexture(base, b).then((tex) => {
      topMat.map = tex;
      topMat.color.set(0xffffff);
      topMat.needsUpdate = true;
      draw();
    }).catch(() => { /* keep the plain top */ });
  }

  // Camera rig
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
  const target = new THREE.Vector3(0, maxH * 0.3, 0);
  const rig = { theta: -0.6, phi: 0.6, radius: 29, tiltX: 0, tiltY: 0, goalX: 0, goalY: 0, zoom: 0 };

  function place() {
    const phi = rig.phi + rig.tiltY * 0.12;
    const theta = rig.theta + rig.tiltX * 0.3;
    const r = rig.radius * (1 - 0.28 * rig.zoom);
    const look = target.clone().lerp(routeCenter, rig.zoom * 0.7);
    camera.position.set(
      look.x + r * Math.cos(phi) * Math.sin(theta),
      look.y + r * Math.sin(phi),
      look.z + r * Math.cos(phi) * Math.cos(theta),
    );
    camera.lookAt(look);
  }

  function resize() {
    const { clientWidth: cw, clientHeight: ch } = container;
    if (!cw || !ch) return;
    renderer.setSize(cw, ch, false);
    camera.aspect = cw / ch;
    camera.updateProjectionMatrix();
    draw();
  }

  function draw() {
    place();
    renderer.render(scene, camera);
  }

  const onPointer = (e) => {
    const r = container.getBoundingClientRect();
    rig.goalX = ((e.clientX - r.left) / r.width - 0.5) * 2;
    rig.goalY = ((e.clientY - r.top) / r.height - 0.5) * 2;
  };
  const onLeave = () => { rig.goalX = 0; rig.goalY = 0; };
  const onScroll = () => {
    const r = container.getBoundingClientRect();
    rig.zoom = Math.min(1, Math.max(0, -r.top / Math.max(1, r.height)));
  };
  container.addEventListener('pointermove', onPointer);
  container.addEventListener('pointerleave', onLeave);
  window.addEventListener('scroll', onScroll, { passive: true });

  // Render only while the block is on screen and the tab is visible
  let visible = false;
  let raf = 0;
  let last = 0;
  function frame(t) {
    raf = 0;
    if (!visible || document.hidden) return;
    const dt = last ? Math.min(0.05, (t - last) / 1000) : 0;
    last = t;
    rig.theta += TURN_RAD_PER_S * dt;
    rig.tiltX += (rig.goalX - rig.tiltX) * 0.05;
    rig.tiltY += (rig.goalY - rig.tiltY) * 0.05;
    draw();
    raf = requestAnimationFrame(frame);
  }
  const start = () => { if (!raf && visible && !document.hidden) { last = 0; raf = requestAnimationFrame(frame); } };
  const io = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; start(); });
  io.observe(container);
  const onVisibility = () => start();
  document.addEventListener('visibilitychange', onVisibility);
  const ro = new ResizeObserver(resize);
  ro.observe(container);
  resize();

  return {
    dispose() {
      io.disconnect();
      ro.disconnect();
      if (raf) cancelAnimationFrame(raf);
      container.removeEventListener('pointermove', onPointer);
      container.removeEventListener('pointerleave', onLeave);
      window.removeEventListener('scroll', onScroll);
      document.removeEventListener('visibilitychange', onVisibility);
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
