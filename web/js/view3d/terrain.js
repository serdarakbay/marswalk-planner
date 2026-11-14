// Terrain for the 3D view (Egemen): local metric frame, height grid and the
// image draped on it. No three.js here, only data and canvases.
//
// Heights, in order of preference:
//   1. state.summary.terrain (Demir): {png, bounds{west,south,east,north}, z_min_m, z_max_m, encoding}
//      encoding 'rg16' (default): z = z_min + (R*256 + G) / 65535 * (z_max - z_min)
//      encoding 'gray8'         : z = z_min + R / 255 * (z_max - z_min)
//   2. Placeholder: a smooth surface through the route elevations (summary.profile),
//      clearly labelled in the UI as a placeholder.
// Image: Mars Trek tiles of the base layer from layers.json (CORS allowed),
// optionally with one overlay PNG from overlays.json / safety.json on top.

export const MARS_RADIUS_M = 3396190;
const M_PER_DEG = (MARS_RADIUS_M * Math.PI) / 180;

const PLACEHOLDER_GRID = 193;      // samples per side for the placeholder surface
const MAX_GRID = 513;              // cap for a real heightmap (keeps the mesh laptop-friendly)
const PLACEHOLDER_SIGMA_M = 160;   // how far a route elevation spreads sideways
const TEXTURE_PX = 2048;
const TILE_PX = 256;
const TILE_ZOOM_MAX = 15;          // ~2.3 m/px at Gale, ~70 tiles for the study area
const TILE_PARALLEL = 8;

// ---------------------------------------------------------------- frame
// x = east (m), z = south (m), origin at the bbox centre. y = up.
export function makeFrame(bbox) {
  const lon0 = (bbox.west + bbox.east) / 2;
  const lat0 = (bbox.south + bbox.north) / 2;
  const mLon = M_PER_DEG * Math.cos((lat0 * Math.PI) / 180);
  const width = (bbox.east - bbox.west) * mLon;
  const depth = (bbox.north - bbox.south) * M_PER_DEG;
  return {
    bbox, width, depth,
    toXZ: (lon, lat) => [(lon - lon0) * mLon, -(lat - lat0) * M_PER_DEG],
  };
}

export function distM([lon1, lat1], [lon2, lat2]) {
  const r = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2
    + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 2 * MARS_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function routeCoords(route) {
  const g = route?.geometry || route?.features?.[0]?.geometry;
  if (!g) return [];
  if (g.type === 'LineString') return g.coordinates;
  if (g.type === 'MultiLineString') return g.coordinates.flat();
  return [];
}

// ---------------------------------------------------------------- grid
// Heights in metres (areoid elevation), row 0 = north, column 0 = west.
function makeGrid(n, frame) {
  return { n, z: new Float32Array(n * n), frame };
}

export function sampleGrid(grid, x, zPos) {
  const { n, frame } = grid;
  const u = Math.min(Math.max((x / frame.width + 0.5) * (n - 1), 0), n - 1);
  const v = Math.min(Math.max((zPos / frame.depth + 0.5) * (n - 1), 0), n - 1);
  const i0 = Math.floor(u); const j0 = Math.floor(v);
  const i1 = Math.min(i0 + 1, n - 1); const j1 = Math.min(j0 + 1, n - 1);
  const fu = u - i0; const fv = v - j0;
  const at = (i, j) => grid.z[j * n + i];
  return (at(i0, j0) * (1 - fu) + at(i1, j0) * fu) * (1 - fv)
       + (at(i0, j1) * (1 - fu) + at(i1, j1) * fu) * fv;
}

function loadImage(url, crossOrigin = false) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    if (crossOrigin) img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`image failed: ${url}`));
    img.src = url;
  });
}

async function heightmapGrid(terrain, frame) {
  const img = await loadImage(terrain.png);
  const c = document.createElement('canvas');
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const px = ctx.getImageData(0, 0, c.width, c.height).data;
  const zMin = Number(terrain.z_min_m); const zMax = Number(terrain.z_max_m);
  if (!Number.isFinite(zMin) || !Number.isFinite(zMax)) throw new Error('terrain z_min_m / z_max_m missing');
  const gray = terrain.encoding === 'gray8';
  const b = terrain.bounds || frame.bbox;
  const bb = frame.bbox;

  const n = Math.min(MAX_GRID, Math.max(c.width, c.height));
  const grid = makeGrid(n, frame);
  let sum = 0; let cnt = 0;
  const holes = [];
  for (let j = 0; j < n; j++) {
    const lat = bb.north - (j / (n - 1)) * (bb.north - bb.south);
    for (let i = 0; i < n; i++) {
      const lon = bb.west + (i / (n - 1)) * (bb.east - bb.west);
      const pu = ((lon - b.west) / (b.east - b.west)) * (c.width - 1);
      const pv = ((b.north - lat) / (b.north - b.south)) * (c.height - 1);
      const k = j * n + i;
      if (pu < 0 || pv < 0 || pu > c.width - 1 || pv > c.height - 1) { holes.push(k); continue; }
      const o = (Math.round(pv) * c.width + Math.round(pu)) * 4;
      if (px[o + 3] === 0) { holes.push(k); continue; }   // transparent = NoData
      const f = gray ? px[o] / 255 : (px[o] * 256 + px[o + 1]) / 65535;
      const z = zMin + f * (zMax - zMin);
      grid.z[k] = z; sum += z; cnt++;
    }
  }
  const mean = cnt ? sum / cnt : 0;
  for (const k of holes) grid.z[k] = mean;   // NoData shown at mean level (display only)
  return grid;
}

// Route vertices with an elevation from summary.profile (d along the route -> z).
export function routeWithZ(route, summary) {
  const coords = routeCoords(route);
  const prof = Array.isArray(summary?.profile) ? summary.profile.filter((p) => Number.isFinite(p?.z)) : [];
  if (coords.length < 2 || prof.length < 2) return [];
  const cum = [0];
  for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + distM(coords[i - 1], coords[i]));
  const scale = prof[prof.length - 1].d / (cum[cum.length - 1] || 1);
  let k = 0;
  return coords.map((c, i) => {
    const d = cum[i] * scale;
    while (k < prof.length - 2 && prof[k + 1].d < d) k++;
    const a = prof[k]; const b = prof[k + 1];
    const f = b.d > a.d ? Math.min(Math.max((d - a.d) / (b.d - a.d), 0), 1) : 0;
    return { lon: c[0], lat: c[1], z: a.z + f * (b.z - a.z) };
  });
}

function placeholderGrid(frame, pts) {
  const n = PLACEHOLDER_GRID;
  const grid = makeGrid(n, frame);
  if (!pts.length) return grid;
  const xs = pts.map((p) => frame.toXZ(p.lon, p.lat));
  const mean = pts.reduce((s, p) => s + p.z, 0) / pts.length;
  const s2 = 2 * PLACEHOLDER_SIGMA_M ** 2;
  const w0 = 0.02; // pull towards the mean far from the route
  for (let j = 0; j < n; j++) {
    const zPos = (j / (n - 1) - 0.5) * frame.depth;
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1) - 0.5) * frame.width;
      let ws = w0; let zs = w0 * mean;
      for (let k = 0; k < pts.length; k++) {
        const dx = x - xs[k][0]; const dz = zPos - xs[k][1];
        const w = Math.exp(-(dx * dx + dz * dz) / s2);
        ws += w; zs += w * pts[k].z;
      }
      grid.z[j * n + i] = zs / ws;
    }
  }
  return grid;
}

// -> { grid, real, label }
export async function buildHeights(state, frame) {
  const t = state.summary?.terrain;
  if (t?.png) {
    try {
      const grid = await heightmapGrid(t, frame);
      return { grid, real: true, label: t.source || 'DEM heightmap (Demir)' };
    } catch (err) {
      console.warn(`[view3d] heightmap: ${err.message}; using the placeholder surface`);
    }
  }
  const pts = routeWithZ(state.route, state.summary);
  return {
    grid: placeholderGrid(frame, pts),
    real: false,
    label: 'Placeholder relief from route elevations; 1 m DEM heightmap pending',
  };
}

// ---------------------------------------------------------------- images
function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// Shaded relief in Mars tones, used under the imagery and as the fallback.
function reliefCanvas(grid) {
  const { n } = grid;
  const c = document.createElement('canvas');
  c.width = n; c.height = n;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(n, n);
  let lo = Infinity; let hi = -Infinity;
  for (const z of grid.z) { if (z < lo) lo = z; if (z > hi) hi = z; }
  const span = hi - lo || 1;
  const cell = grid.frame.width / (n - 1);
  const tmp = document.createElement('canvas').getContext('2d');
  const rgb = (v) => { tmp.fillStyle = v; tmp.fillRect(0, 0, 1, 1); return tmp.getImageData(0, 0, 1, 1).data; };
  const dark = rgb(cssVar('--color-dust') || 'gray');
  const light = rgb(cssVar('--color-sand') || 'tan');
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const k = j * n + i;
      const zx = grid.z[j * n + Math.min(i + 1, n - 1)] - grid.z[j * n + Math.max(i - 1, 0)];
      const zy = grid.z[Math.min(j + 1, n - 1) * n + i] - grid.z[Math.max(j - 1, 0) * n + i];
      const shade = Math.min(Math.max(0.75 + (-zx + zy) / (4 * cell), 0.35), 1.1);
      const f = (grid.z[k] - lo) / span;
      for (let ch = 0; ch < 3; ch++) img.data[k * 4 + ch] = Math.min(255, (dark[ch] + f * (light[ch] - dark[ch])) * shade);
      img.data[k * 4 + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

// Stitch Mars Trek tiles (EPSG:4326 scheme, {z}/{y}/{x}) for the bbox into one canvas.
async function trekCanvas(layer, bbox, onProgress) {
  const z = Math.min(TILE_ZOOM_MAX, Number(layer.maxNativeZoom) || TILE_ZOOM_MAX);
  const d = 180 / 2 ** z;
  const x0 = Math.floor((bbox.west + 180) / d); const x1 = Math.floor((bbox.east + 180) / d - 1e-12);
  const y0 = Math.floor((90 - bbox.north) / d); const y1 = Math.floor((90 - bbox.south) / d - 1e-12);
  const c = document.createElement('canvas');
  c.width = TEXTURE_PX; c.height = TEXTURE_PX;
  const ctx = c.getContext('2d');
  const sx = TEXTURE_PX / (bbox.east - bbox.west);
  const sy = TEXTURE_PX / (bbox.north - bbox.south);
  const jobs = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) jobs.push([x, y]);
  let done = 0; let ok = 0;
  const run = async () => {
    while (jobs.length) {
      const [x, y] = jobs.shift();
      const url = layer.url.replace('{z}', z).replace('{y}', y).replace('{x}', x);
      try {
        const img = await loadImage(url, true);
        const west = x * d - 180; const north = 90 - y * d;
        ctx.drawImage(img, (west - bbox.west) * sx, (bbox.north - north) * sy, d * sx + 0.5, d * sy + 0.5);
        ok++;
      } catch { /* missing tile: relief stays visible there */ }
      done++;
      onProgress?.(`Loading HiRISE imagery… ${done}/${done + jobs.length}`);
    }
  };
  await Promise.all(Array.from({ length: TILE_PARALLEL }, run));
  return { canvas: c, ok, total: done, tilePx: TILE_PX };
}

function drawInBounds(ctx, img, bounds, bbox, size) {
  const sx = size / (bbox.east - bbox.west); const sy = size / (bbox.north - bbox.south);
  ctx.drawImage(img, (bounds.west - bbox.west) * sx, (bbox.north - bounds.north) * sy,
    (bounds.east - bounds.west) * sx, (bounds.north - bounds.south) * sy);
}

// Base image: relief underneath, Trek imagery on top where tiles exist.
export async function buildBaseImage(state, grid, onProgress) {
  const bbox = state.area.bbox;
  const c = document.createElement('canvas');
  c.width = TEXTURE_PX; c.height = TEXTURE_PX;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(reliefCanvas(grid), 0, 0, TEXTURE_PX, TEXTURE_PX);
  const layers = Array.isArray(state.layers) ? state.layers : [];
  const base = layers.find((l) => l.id === 'hirise') || layers.find((l) => l.type === 'base');
  let label = 'Shaded relief';
  if (base?.url) {
    try {
      const t = await trekCanvas(base, bbox, onProgress);
      if (t.ok) { ctx.drawImage(t.canvas, 0, 0); label = `${base.name || base.id} · ${base.attribution || 'NASA Mars Trek'}`; }
    } catch (err) {
      console.warn(`[view3d] imagery: ${err.message}`);
    }
  }
  return { canvas: c, label };
}

// Overlay choices: overlays.json + safety.json overlays (same schema).
export function overlayChoices(state) {
  const list = [];
  for (const o of [...(state.overlays || []), ...(state.safety?.overlays || [])]) {
    if (o?.png && o?.bounds) list.push(o);
  }
  return list;
}

const overlayCache = new Map();
// overlay = an overlays.json entry {png, bounds} or a generated one {canvas, alpha}
export async function composeImage(base, overlay, bbox, alpha = 0.7) {
  if (!overlay) return base.canvas;
  const c = document.createElement('canvas');
  c.width = base.canvas.width; c.height = base.canvas.height;
  const ctx = c.getContext('2d');
  ctx.drawImage(base.canvas, 0, 0);
  ctx.globalAlpha = overlay.alpha ?? alpha;
  if (overlay.canvas) {
    ctx.drawImage(overlay.canvas, 0, 0, c.width, c.height);
    return c;
  }
  let img = overlayCache.get(overlay.png);
  if (!img) { img = await loadImage(overlay.png); overlayCache.set(overlay.png, img); }
  drawInBounds(ctx, img, overlay.bounds, bbox, c.width);
  return c;
}

// ---------------------------------------------------------------- rock layers
// Mount Sharp's strata lie nearly flat, so elevation is a proxy for position in
// the layer stack: lower = older (clay-bearing), higher = younger (sulfate-bearing).
// This colours the DEM elevation only; it does not draw mapped unit boundaries.
const STRATA_PX = 1024;
export const STRATA_STEP_M = 20;     // one line every 20 m of elevation
const STRATA_LIFT = 0.35;            // how far the colours move towards a light page colour
const STRATA_MAJOR_M = 100;          // stronger line every 100 m

export function elevationRange(grid) {
  const s = Array.from(grid.z).sort((a, b) => a - b);
  return { lo: s[Math.floor(s.length * 0.02)], hi: s[Math.floor(s.length * 0.98)] };
}

export function strataCanvas(grid, lowColor, highColor, lineColor) {
  const { frame } = grid;
  const { lo, hi } = elevationRange(grid);
  const span = hi - lo || 1;
  const tmp = document.createElement('canvas').getContext('2d');
  const rgb = (v) => { tmp.fillStyle = v; tmp.fillRect(0, 0, 1, 1); return tmp.getImageData(0, 0, 1, 1).data; };
  const a = rgb(lowColor); const b = rgb(highColor); const ln = rgb(lineColor);
  // On a light page the clay / sulfate tones turn muddy once shaded in 3D:
  // lift them towards the page colour (hue stays from the palette).
  const page = rgb(getComputedStyle(document.documentElement).getPropertyValue('--color-bg').trim() || 'black');
  if ((page[0] + page[1] + page[2]) / 3 > 160) {
    for (const c of [a, b]) for (let ch = 0; ch < 3; ch++) c[ch] += STRATA_LIFT * (page[ch] - c[ch]);
  }

  const n = STRATA_PX;
  const z = new Float32Array(n * n);
  for (let j = 0; j < n; j++) {
    const zPos = (j / (n - 1) - 0.5) * frame.depth;
    for (let i = 0; i < n; i++) z[j * n + i] = sampleGrid(grid, (i / (n - 1) - 0.5) * frame.width, zPos);
  }
  const c = document.createElement('canvas');
  c.width = n; c.height = n;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(n, n);
  const band = (v, step) => Math.floor(v / step);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const k = j * n + i;
      const v = z[k];
      const f = Math.min(Math.max((v - lo) / span, 0), 1);
      let r = a[0] + f * (b[0] - a[0]); let g = a[1] + f * (b[1] - a[1]); let bl = a[2] + f * (b[2] - a[2]);
      const right = z[j * n + Math.min(i + 1, n - 1)]; const down = z[Math.min(j + 1, n - 1) * n + i];
      const major = band(v, STRATA_MAJOR_M) !== band(right, STRATA_MAJOR_M) || band(v, STRATA_MAJOR_M) !== band(down, STRATA_MAJOR_M);
      const minor = band(v, STRATA_STEP_M) !== band(right, STRATA_STEP_M) || band(v, STRATA_STEP_M) !== band(down, STRATA_STEP_M);
      const w = major ? 0.6 : minor ? 0.28 : 0;
      r += w * (ln[0] - r); g += w * (ln[1] - g); bl += w * (ln[2] - bl);
      img.data[k * 4] = r; img.data[k * 4 + 1] = g; img.data[k * 4 + 2] = bl; img.data[k * 4 + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return { canvas: c, lo, hi };
}
