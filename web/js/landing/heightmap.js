// heightmap.js (Ege): decodes Demir's heightmap PNG (summary.json "terrain" block).
// Encoding "rg16": z = z_min_m + (R * 256 + G) / 65535 * (z_max_m - z_min_m); alpha 0 = NoData.
//
//   const hm = await loadHeightmap(terrain, { size: 256 })
//   hm.width, hm.height, hm.z (Float32Array, row 0 = north), hm.zMin, hm.zMax, hm.bounds
//   hm.at(lon, lat) -> elevation in metres (bilinear), or null outside the bounds

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`could not load ${src}`));
    img.src = src;
  });
}

export async function loadHeightmap(terrain, { size = 256 } = {}) {
  if (!terrain?.png || !terrain?.bounds || terrain.encoding !== 'rg16') {
    throw new Error('summary.json has no rg16 terrain block');
  }
  const img = await loadImage(terrain.png);
  const srcW = img.naturalWidth;
  const srcH = img.naturalHeight;

  // Read the full-resolution pixels: resampling the PNG itself would mix the R and G bytes
  const canvas = document.createElement('canvas');
  canvas.width = srcW;
  canvas.height = srcH;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const px = ctx.getImageData(0, 0, srcW, srcH).data;

  const zMin = terrain.z_min_m;
  const zMax = terrain.z_max_m;
  const full = new Float32Array(srcW * srcH);
  let sum = 0;
  let n = 0;
  for (let i = 0; i < full.length; i++) {
    if (px[i * 4 + 3] === 0) { full[i] = NaN; continue; }
    full[i] = zMin + ((px[i * 4] * 256 + px[i * 4 + 1]) / 65535) * (zMax - zMin);
    sum += full[i];
    n++;
  }
  const fill = n ? sum / n : zMin;

  // Downsample by averaging blocks to at most size x size
  const w = Math.min(size, srcW);
  const h = Math.min(size, srcH);
  const z = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor((x * srcW) / w);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * srcW) / w));
      const y0 = Math.floor((y * srcH) / h);
      const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * srcH) / h));
      let s = 0;
      let c = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const v = full[yy * srcW + xx];
          if (!Number.isNaN(v)) { s += v; c++; }
        }
      }
      z[y * w + x] = c ? s / c : fill;
    }
  }

  const b = terrain.bounds;
  const at = (lon, lat) => {
    if (lon < b.west || lon > b.east || lat < b.south || lat > b.north) return null;
    const fx = ((lon - b.west) / (b.east - b.west)) * (w - 1);
    const fy = ((b.north - lat) / (b.north - b.south)) * (h - 1);
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const x1 = Math.min(x0 + 1, w - 1);
    const y1 = Math.min(y0 + 1, h - 1);
    const tx = fx - x0;
    const ty = fy - y0;
    const top = z[y0 * w + x0] * (1 - tx) + z[y0 * w + x1] * tx;
    const bottom = z[y1 * w + x0] * (1 - tx) + z[y1 * w + x1] * tx;
    return top * (1 - ty) + bottom * ty;
  };

  return { width: w, height: h, z, zMin, zMax, bounds: b, at };
}
