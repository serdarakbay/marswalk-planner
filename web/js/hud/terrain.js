// Terrain grid and walking paths for the storm scenario.
//
// The grid comes from Demir's heightmap (summary.json "terrain": rg16 PNG on the study-area
// lon/lat grid). A path to a refuge avoids slopes steeper than PATH.SLOPE_MAX_DEG and prefers
// gentle ground, like a turn-by-turn route on a map: the astronaut follows the drawn line.
//
// createRouter(grid, targets) runs one Dijkstra per refuge (lazily, then cached), so a path from
// anywhere is just a walk along the "next cell" pointers: cheap enough to call on every render.

const R_MARS = 3396190;
const RAD = Math.PI / 180;

export const PATH = {
  GRID_SIZE: 256,        // cells per side (~9 m on the 2.4 km study area)
  SLOPE_MAX_DEG: 25,     // slope_max_deg in config/mission.json: never walk steeper than this
  SLOPE_WARN_DEG: 15,    // slope_warn_deg: cost doubles at this slope, grows with its square
  SNAP_CELLS: 3,         // look this many cells around a point for walkable ground
};

// --- grid ------------------------------------------------------------------------------------

/**
 * @param {Float32Array} z  elevation in metres, row 0 = north, NaN = NoData
 * @param {number} w, h     cells
 * @param {object} bounds   {west, south, east, north}
 */
export function makeGrid(z, w, h, bounds) {
  const lat0 = (bounds.north + bounds.south) / 2;
  const dx = ((bounds.east - bounds.west) / w) * RAD * R_MARS * Math.cos(lat0 * RAD);
  const dy = ((bounds.north - bounds.south) / h) * RAD * R_MARS;
  return {
    z, w, h, bounds, dx, dy,
    cellOf([lon, lat]) {
      const x = Math.floor(((lon - bounds.west) / (bounds.east - bounds.west)) * w);
      const y = Math.floor(((bounds.north - lat) / (bounds.north - bounds.south)) * h);
      if (x < 0 || y < 0 || x >= w || y >= h) return -1;
      return y * w + x;
    },
    coordOf(i) {
      const x = i % w;
      const y = (i - x) / w;
      return [
        bounds.west + ((x + 0.5) / w) * (bounds.east - bounds.west),
        bounds.north - ((y + 0.5) / h) * (bounds.north - bounds.south),
      ];
    },
  };
}

// rg16 pixels (RGBA bytes) -> elevation; alpha 0 = NoData
export function decodeRg16(px, n, zMin, zMax) {
  const z = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    z[i] = px[i * 4 + 3] === 0 ? NaN : zMin + ((px[i * 4] * 256 + px[i * 4 + 1]) / 65535) * (zMax - zMin);
  }
  return z;
}

// Block average to size x size (NoData cells are skipped; a block of only NoData stays NaN)
export function downsample(full, srcW, srcH, size) {
  const w = Math.min(size, srcW);
  const h = Math.min(size, srcH);
  const z = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor((y * srcH) / h);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * srcH) / h));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor((x * srcW) / w);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * srcW) / w));
      let s = 0;
      let c = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const v = full[yy * srcW + xx];
          if (!Number.isNaN(v)) { s += v; c++; }
        }
      }
      z[y * w + x] = c ? s / c : NaN;
    }
  }
  return { z, w, h };
}

// Browser only: load summary.json "terrain" (Demir's heightmap PNG) into a grid
export async function loadTerrainGrid(terrain, size = PATH.GRID_SIZE) {
  if (!terrain?.png || !terrain?.bounds || terrain.encoding !== 'rg16') return null;
  // onload rather than img.decode(): decode() can stall in a background tab
  const img = await new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error(`could not load ${terrain.png}`));
    im.src = terrain.png;
  });
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const px = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  const full = decodeRg16(px, canvas.width * canvas.height, terrain.z_min_m, terrain.z_max_m);
  const d = downsample(full, canvas.width, canvas.height, size);
  return makeGrid(d.z, d.w, d.h, terrain.bounds);
}

// --- paths -----------------------------------------------------------------------------------

const NEIGH = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

// Cost of one step between neighbouring cells: horizontal metres x slope penalty, or Infinity
function stepCost(grid, i, j, hM) {
  const a = grid.z[i];
  const b = grid.z[j];
  if (Number.isNaN(a) || Number.isNaN(b)) return Infinity;
  const slope = Math.atan(Math.abs(b - a) / hM) / RAD;
  if (slope > PATH.SLOPE_MAX_DEG) return Infinity;
  return hM * (1 + (slope / PATH.SLOPE_WARN_DEG) ** 2);
}

// Min-heap of (cost, cell) on typed arrays (fast enough for a 256 x 256 grid in ~50 ms)
function makeHeap(cap) {
  let key = new Float64Array(cap);
  let val = new Int32Array(cap);
  let n = 0;
  return {
    get size() { return n; },
    push(k, v) {
      if (n === key.length) {
        const k2 = new Float64Array(n * 2); k2.set(key); key = k2;
        const v2 = new Int32Array(n * 2); v2.set(val); val = v2;
      }
      let i = n++;
      while (i > 0) {
        const parent = (i - 1) >> 1;
        if (key[parent] <= k) break;
        key[i] = key[parent]; val[i] = val[parent];
        i = parent;
      }
      key[i] = k; val[i] = v;
    },
    // returns the cell; the cost is in heap.top
    pop() {
      const out = val[0];
      this.top = key[0];
      const k = key[--n];
      const v = val[n];
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && key[c + 1] < key[c]) c++;
        if (key[c] >= k) break;
        key[i] = key[c]; val[i] = val[c];
        i = c;
      }
      key[i] = k; val[i] = v;
      return out;
    },
    top: 0,
  };
}

// Dijkstra from the target cell over the grid: cost to the target and the next cell toward
// it, for every cell (costs are symmetric, so this is also the way there). maxCost stops the
// search early for short paths (cells beyond it stay unreachable).
export function costField(grid, target, maxCost = Infinity) {
  const n = grid.w * grid.h;
  const cost = new Float64Array(n).fill(Infinity);
  const next = new Int32Array(n).fill(-1);
  if (target < 0 || target >= n) return { cost, next };
  const diag = Math.hypot(grid.dx, grid.dy);
  cost[target] = 0;
  const heap = makeHeap(n);
  heap.push(0, target);
  while (heap.size) {
    const i = heap.pop();
    const c = heap.top;
    if (c > cost[i]) continue;
    if (c > maxCost) break;
    const x = i % grid.w;
    const y = (i - x) / grid.w;
    for (const [ox, oy] of NEIGH) {
      const nx = x + ox;
      const ny = y + oy;
      if (nx < 0 || ny < 0 || nx >= grid.w || ny >= grid.h) continue;
      const j = ny * grid.w + nx;
      const hM = ox && oy ? diag : ox ? grid.dx : grid.dy;
      const nc = c + stepCost(grid, j, i, hM);
      if (nc < cost[j]) {
        cost[j] = nc;
        next[j] = i;
        heap.push(nc, j);
      }
    }
  }
  return { cost, next };
}

const metres = (a, b) => {
  const lat = ((a[1] + b[1]) / 2) * RAD;
  return Math.hypot((b[0] - a[0]) * RAD * R_MARS * Math.cos(lat), (b[1] - a[1]) * RAD * R_MARS);
};

export function pathLength(coords) {
  let d = 0;
  for (let i = 1; i < coords.length; i++) d += metres(coords[i - 1], coords[i]);
  return d;
}

// Drop points that lie on a straight line (keeps the drawn path light)
function simplify(coords) {
  if (coords.length < 3) return coords;
  const out = [coords[0]];
  for (let i = 1; i < coords.length - 1; i++) {
    const a = out[out.length - 1];
    const b = coords[i];
    const c = coords[i + 1];
    const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(cross) > 1e-14) out.push(b);
  }
  out.push(coords[coords.length - 1]);
  return out;
}

/**
 * @param {object} grid      makeGrid(...)
 * @param {Array}  targets   [{id, coord}]: refuges ('S1'.., 'habitat')
 * @returns {{pathTo(from, id): {coords, length_m} | null}}  null: no walkable way (use a straight line)
 */
export function createRouter(grid, targets) {
  const fields = new Map();
  const byId = new Map(targets.filter((t) => Array.isArray(t?.coord)).map((t) => [t.id, t]));
  function field(id) {
    if (!fields.has(id)) {
      const t = byId.get(id);
      fields.set(id, t ? costField(grid, grid.cellOf(t.coord)) : null);
    }
    return fields.get(id);
  }
  // Follow the field's "next cell" pointers from `from` to the target `to`
  function walk(from, to, f) {
    if (!f || !Array.isArray(from) || !Array.isArray(to)) return null;
    // Start on the nearest reachable cell around the astronaut
    let start = grid.cellOf(from);
    if (start < 0) return null;
    if (!Number.isFinite(f.cost[start])) {
      const x0 = start % grid.w;
      const y0 = (start - x0) / grid.w;
      let best = -1;
      for (let oy = -PATH.SNAP_CELLS; oy <= PATH.SNAP_CELLS; oy++) {
        for (let ox = -PATH.SNAP_CELLS; ox <= PATH.SNAP_CELLS; ox++) {
          const x = x0 + ox;
          const y = y0 + oy;
          if (x < 0 || y < 0 || x >= grid.w || y >= grid.h) continue;
          const j = y * grid.w + x;
          if (Number.isFinite(f.cost[j]) && (best < 0 || f.cost[j] < f.cost[best])) best = j;
        }
      }
      if (best < 0) return null;
      start = best;
    }
    const coords = [from];
    const goal = grid.cellOf(to);
    for (let i = start, guard = 0; i !== goal && i >= 0 && guard < grid.w * grid.h; i = f.next[i], guard++) {
      coords.push(grid.coordOf(i));
    }
    coords.push(to);
    const simple = simplify(coords);
    return { coords: simple, length_m: pathLength(simple) };
  }
  return {
    // Compute the refuge cost fields one at a time in the background (one per timer tick), so
    // the first storm does not freeze the page while they are all built at once
    warm() {
      const ids = [...byId.keys()].filter((id) => !fields.has(id));
      const nextOne = () => {
        const id = ids.shift();
        if (id === undefined) return;
        field(id);
        setTimeout(nextOne, 0);
      };
      setTimeout(nextOne, 0);
    },
    // Path to one of the refuges (cost field cached per refuge)
    pathTo(from, id) {
      const t = byId.get(id);
      return t ? walk(from, t.coord, field(id)) : null;
    },
    // Short path to any point (e.g. stepping aside from a dust devil); searched only up to
    // maxM of cost, so it stays fast. null when the point cannot be reached that way.
    pathBetween(from, to, maxM = 600) {
      const goal = grid.cellOf(to);
      if (goal < 0 || !Number.isFinite(grid.z[goal])) return null;
      return walk(from, to, costField(grid, goal, maxM));
    },
  };
}

// --- following a path ------------------------------------------------------------------------

// A leg of the walk along a polyline: cumulative metres for interpolation
export function makeLeg(coords) {
  const cum = [0];
  for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + metres(coords[i - 1], coords[i]));
  return { coords, cum, total: cum[cum.length - 1], s: 0 };
}

export function legPoint(leg, s) {
  const { coords, cum } = leg;
  if (s <= 0) return coords[0];
  if (s >= leg.total) return coords[coords.length - 1];
  let k = 1;
  while (k < cum.length - 1 && cum[k] < s) k++;
  const f = (s - cum[k - 1]) / (cum[k] - cum[k - 1] || 1);
  const a = coords[k - 1];
  const b = coords[k];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
}

// What is still ahead on the leg, from s to its end (for the map line)
export function legRemaining(leg, s) {
  const out = [legPoint(leg, s)];
  for (let i = 1; i < leg.coords.length; i++) if (leg.cum[i] > s) out.push(leg.coords[i]);
  return out;
}

// --- slope from the grid ---------------------------------------------------------------------

// Elevation at a point (bilinear between cell centres); null outside the grid or on NoData
export function zAt(grid, [lon, lat]) {
  const b = grid.bounds;
  const fx = ((lon - b.west) / (b.east - b.west)) * grid.w - 0.5;
  const fy = ((b.north - lat) / (b.north - b.south)) * grid.h - 0.5;
  if (fx < 0 || fy < 0 || fx > grid.w - 1 || fy > grid.h - 1) return null;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(x0 + 1, grid.w - 1);
  const y1 = Math.min(y0 + 1, grid.h - 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const z = (x, y) => grid.z[y * grid.w + x];
  const v = (z(x0, y0) * (1 - tx) + z(x1, y0) * tx) * (1 - ty) + (z(x0, y1) * (1 - tx) + z(x1, y1) * tx) * ty;
  return Number.isNaN(v) ? null : v;
}

// Terrain slope at a point (steepest direction, degrees), from the elevation one cell either
// side east-west and north-south: the same kind of slope as Demir's slope map
export function slopeAt(grid, coord) {
  const [lon, lat] = coord;
  const dLon = (grid.bounds.east - grid.bounds.west) / grid.w;
  const dLat = (grid.bounds.north - grid.bounds.south) / grid.h;
  const e = zAt(grid, [lon + dLon, lat]);
  const w = zAt(grid, [lon - dLon, lat]);
  const n = zAt(grid, [lon, lat + dLat]);
  const s = zAt(grid, [lon, lat - dLat]);
  if (e == null || w == null || n == null || s == null) return null;
  const gx = (e - w) / (2 * grid.dx);
  const gy = (n - s) / (2 * grid.dy);
  return Math.atan(Math.hypot(gx, gy)) / RAD;
}

// Steepest stretch along a path, in the walking direction (what the astronaut actually climbs
// or descends; the path finder keeps it under PATH.SLOPE_MAX_DEG): {deg, at_m} or null
export function steepestOnPath(grid, coords, stepM = 10) {
  if (!Array.isArray(coords) || coords.length < 2) return null;
  const leg = makeLeg(coords);
  let best = null;
  let prev = zAt(grid, coords[0]);
  for (let s = stepM; s <= leg.total + 1e-9; s += stepM) {
    const z = zAt(grid, legPoint(leg, s));
    if (z != null && prev != null) {
      const deg = Math.atan(Math.abs(z - prev) / stepM) / RAD;
      if (!best || deg > best.deg) best = { deg, at_m: s - stepM / 2 };
    }
    prev = z;
  }
  return best;
}
