// Route trails for the 3D view (Egemen): a thin flat ribbon draped on the terrain, with a soft glow,
// that can be revealed from A to B like a loading bar ("snake"). Display only: the route data and
// every computed value stay as they are; the corners of the grid path are rounded for the eye.
//
// three.js r160 (MIT, https://github.com/mrdoob/three.js), passed in by scene.js.

const PEN_TILT = 0.6;   // radians the pen leans back from vertical

// Chaikin corner cutting on [x, z] points: removes the staircase of a grid path; ends are kept.
export function chaikin(pts, iterations = 2) {
  let p = pts;
  for (let it = 0; it < iterations; it++) {
    if (p.length < 3) return p;
    const out = [p[0]];
    for (let i = 0; i < p.length - 1; i++) {
      const [ax, az] = p[i]; const [bx, bz] = p[i + 1];
      out.push([0.75 * ax + 0.25 * bx, 0.75 * az + 0.25 * bz], [0.25 * ax + 0.75 * bx, 0.25 * az + 0.75 * bz]);
    }
    out.push(p[p.length - 1]);
    p = out;
  }
  return p;
}

// Evenly spaced [x, z] points every `step` metres (keeps the first and last point)
export function resampleXZ(pts, step) {
  if (pts.length < 2) return pts.slice();
  const out = [pts[0]];
  let carry = 0;
  for (let i = 1; i < pts.length; i++) {
    const [ax, az] = pts[i - 1]; const [bx, bz] = pts[i];
    const len = Math.hypot(bx - ax, bz - az);
    let s = step - carry;
    while (s <= len) {
      const f = s / len;
      out.push([ax + (bx - ax) * f, az + (bz - az) * f]);
      s += step;
    }
    carry = len - (s - step);
  }
  const last = pts[pts.length - 1];
  const tail = out[out.length - 1];
  if (tail[0] !== last[0] || tail[1] !== last[1]) out.push(last);
  return out;
}

// A flat ribbon along 3D points (y up), `width` metres wide, built so that drawing the first k
// segments is a prefix of the index buffer: setProgress() reveals it from the start.
function ribbonGeometry(THREE, pts, width) {
  const n = pts.length;
  const pos = new Float32Array(n * 2 * 3);
  const half = width / 2;
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(i - 1, 0)]; const b = pts[Math.min(i + 1, n - 1)];
    let tx = b.x - a.x; let tz = b.z - a.z;
    const l = Math.hypot(tx, tz) || 1;
    tx /= l; tz /= l;
    const nx = -tz * half; const nz = tx * half;
    const p = pts[i];
    pos.set([p.x + nx, p.y, p.z + nz, p.x - nx, p.y, p.z - nz], i * 6);
  }
  const idx = new Uint32Array((n - 1) * 6);
  for (let i = 0; i < n - 1; i++) {
    const a = i * 2; const b = a + 1; const c = a + 2; const d = a + 3;
    idx.set([a, b, c, b, d, c], i * 6);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.computeBoundingSphere();
  return geo;
}

/**
 * pts: THREE.Vector3[] already draped on the terrain. Returns a Group with:
 *   .len (metres), .pointAt(s) -> Vector3, .setProgress(0..1), .hit (mesh for picking),
 *   .head (the pen tip that draws it, or null; scene.js scales it with the camera distance)
 * opts: {color, width, glow (0 = none), opacity, head, headColor, rimColor, hitWidth}
 */
export function makeTrail(THREE, pts, opts = {}) {
  const { color = '#ffffff', width = 4, glow = 0, opacity = 1, head = false, hitWidth = 0 } = opts;
  const headColor = opts.headColor || color;
  const shaftColor = opts.rimColor || '#ffffff';
  const group = new THREE.Group();
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + pts[i].distanceTo(pts[i - 1]));
  const len = cum[cum.length - 1];
  const segs = Math.max(pts.length - 1, 0);
  const common = { transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 };

  const lines = [];
  if (glow > 0) {
    const g = new THREE.Mesh(ribbonGeometry(THREE, pts, width * glow),
      new THREE.MeshBasicMaterial({ color, opacity: 0.22 * opacity, ...common }));
    g.renderOrder = 4;
    lines.push(g);
  }
  const core = new THREE.Mesh(ribbonGeometry(THREE, pts, width),
    new THREE.MeshBasicMaterial({ color, opacity, ...common }));
  core.renderOrder = 5;
  lines.push(core);
  group.add(...lines);

  let hit = null;
  if (hitWidth > 0) {
    hit = new THREE.Mesh(ribbonGeometry(THREE, pts, hitWidth),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, colorWrite: false }));
    group.add(hit);
  }

  // The head: a small pen tip that draws the line. Unit size (scene.js scales it); its local origin
  // is the very tip, which sits on the end of the drawn line; the pen leans back along the way.
  let dot = null;
  if (head) {
    dot = new THREE.Group();
    const lit = (c) => new THREE.MeshStandardMaterial({ color: c, emissive: c, emissiveIntensity: 0.3, roughness: 0.5 });
    const nibGeo = new THREE.ConeGeometry(0.42, 1.5, 18).rotateX(Math.PI).translate(0, 0.75, 0);   // tip at 0
    const shaftGeo = new THREE.CylinderGeometry(0.42, 0.42, 2.6, 18).translate(0, 1.5 + 1.3, 0);
    const nib = new THREE.Mesh(nibGeo, lit(headColor));
    const shaft = new THREE.Mesh(shaftGeo, lit(shaftColor));
    const pen = new THREE.Group();
    pen.add(nib, shaft);
    pen.rotation.x = -PEN_TILT;   // leans back (towards -z of the head group = where it came from)
    dot.add(pen);
    dot.visible = false;
    group.add(dot);
  }

  // Exact line end: the last drawn segment is stretched to the pen tip (its far vertices moved
  // there), so the line comes out of the tip with no gap; restored on the next frame.
  const origPos = lines.map((l) => l.geometry.attributes.position.array.slice());
  let edited = -1;
  function restore() {
    if (edited < 0) return;
    lines.forEach((l, n) => {
      const a = l.geometry.attributes.position.array;
      for (let c = 0; c < 6; c++) a[edited * 6 + c] = origPos[n][edited * 6 + c];
      l.geometry.attributes.position.needsUpdate = true;
    });
    edited = -1;
  }
  function stretch(i, f) {
    const j = i + 1;
    lines.forEach((l, n) => {
      const a = l.geometry.attributes.position.array; const o = origPos[n];
      for (let c = 0; c < 6; c++) a[j * 6 + c] = o[i * 6 + c] + (o[j * 6 + c] - o[i * 6 + c]) * f;
      l.geometry.attributes.position.needsUpdate = true;
    });
    edited = j;
  }

  function pointAt(s) {
    if (!pts.length) return new THREE.Vector3();
    if (s <= 0) return pts[0].clone();
    if (s >= len) return pts[pts.length - 1].clone();
    let lo = 0; let hi = cum.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cum[m] < s) lo = m; else hi = m; }
    const f = (s - cum[lo]) / (cum[hi] - cum[lo] || 1);
    return pts[lo].clone().lerp(pts[hi], f);
  }

  // f in 0..1 of the length. 1 draws everything; the pen shows while 0 < f < 1, or at the end
  // too with {keepHead: true} (it rests on B for a moment before it goes)
  const up = new THREE.Vector3(0, 1, 0);
  function setProgress(f, { keepHead = false } = {}) {
    const k = Math.min(Math.max(f, 0), 1);
    const s = k * len;
    restore();
    let count;
    if (k >= 1 || segs === 0) count = segs * 6;
    else {
      let i = 0; let hi = cum.length - 1;
      while (hi - i > 1) { const m = (i + hi) >> 1; if (cum[m] <= s) i = m; else hi = m; }
      const fr = (s - cum[i]) / (cum[i + 1] - cum[i] || 1);
      stretch(i, fr);
      count = (i + 1) * 6;
    }
    for (const l of lines) l.geometry.setDrawRange(0, count);
    if (dot) {
      dot.visible = (k > 0 && k < 1) || (keepHead && k >= 1);
      if (dot.visible) {
        const tip = pointAt(s);
        dot.position.copy(tip);
        // face the way of travel (from a little behind the tip), so the pen leans back along the line
        const from = pointAt(Math.max(s - 6, 0));
        const dir = tip.clone().sub(from).setY(0);
        if (dir.lengthSq() > 1e-6) dot.rotation.set(0, Math.atan2(dir.x, dir.z), 0);
      }
    }
  }

  group.userData = { len };
  Object.assign(group, { len, pointAt, setProgress, hit, head: dot });
  return group;
}
