// contours.js (Ege): faint contour lines behind the page, traced from the study-area heightmap.
// Minor lines every STEP_M metres, index lines every INDEX_M metres.

import { contours } from 'd3-contour';

const STEP_M = 20;
const INDEX_M = 100;

// GeoJSON MultiPolygon in pixel space -> SVG path data
function pathData(geometry) {
  let d = '';
  for (const polygon of geometry.coordinates) {
    for (const ring of polygon) {
      d += `M${ring.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join('L')}Z`;
    }
  }
  return d;
}

export function drawContours(svg, hm) {
  const { width: w, height: h, z } = hm;
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of z) { if (v < lo) lo = v; if (v > hi) hi = v; }
  const thresholds = [];
  for (let t = Math.ceil(lo / STEP_M) * STEP_M; t <= hi; t += STEP_M) thresholds.push(t);

  // Pad the grid with a ring below the lowest value, so every contour closes inside the
  // map instead of running along its edge; the viewBox then hides the padding.
  const pw = w + 2;
  const ph = h + 2;
  const padded = new Float64Array(pw * ph).fill(lo - 1);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) padded[(y + 1) * pw + x + 1] = z[y * w + x];
  }
  const layers = contours().size([pw, ph]).thresholds(thresholds)(padded);
  svg.setAttribute('viewBox', `2.5 2.5 ${w - 3} ${h - 3}`);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid slice');
  const ns = 'http://www.w3.org/2000/svg';
  const frag = document.createDocumentFragment();
  for (const layer of layers) {
    if (!layer.coordinates.length) continue;
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', pathData(layer));
    if (Math.round(layer.value) % INDEX_M === 0) path.setAttribute('class', 'index');
    frag.append(path);
  }
  svg.replaceChildren(frag);
}
