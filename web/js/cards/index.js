// Stop cards: photo + science note for the selected Marswalk stop.
// Owner: Egemen (branch `veri`)
//
// Contract (CLAUDE.md):
//   export function initCards(state, el)
//   listens to document 'stop:select' (detail = stop from stops.json)
//   stop = {id, name, coord[lon,lat], science, photos[{url, sol, camera, credit}]}
// Uses state.weather (weather.json) and state.eva (eva_window.json) when present.
// Every input may be null/missing: the card degrades, it never throws.

const SVG_NS = 'http://www.w3.org/2000/svg';
const DEFAULT_CREDIT = 'NASA/JPL-Caltech';

function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

function s(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

const lmstToH = (str) => {
  const m = /^(\d{1,2}):(\d{2})/.exec(str || '');
  return m ? Number(m[1]) + Number(m[2]) / 60 : null;
};

function fmtCoord(coord) {
  if (!Array.isArray(coord) || coord.length < 2) return null;
  const [lon, lat] = coord.map(Number);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  return `${Math.abs(lat).toFixed(4)}°${lat < 0 ? 'S' : 'N'}, ${Math.abs(lon).toFixed(4)}°${lon < 0 ? 'W' : 'E'}`;
}

// Mastcam / MAHLI / MARDI are MSSS-operated; CLAUDE.md requires the MSSS credit.
function creditFor(photo) {
  if (photo.credit) return photo.credit;
  return /mastcam|mahli|mardi/i.test(photo.camera || '') ? 'NASA/JPL-Caltech/MSSS' : DEFAULT_CREDIT;
}

function photoMeta(photo) {
  return [photo.sol != null ? `Sol ${photo.sol}` : null, photo.camera].filter(Boolean).join(' · ');
}

// ------------------------------------------------------------ weather chart
function weatherChart(weather, eva) {
  const rows = (weather?.rows || [])
    .map((r) => ({ t: lmstToH(r.lmst), c: Number(r.temp_c) }))
    .filter((r) => r.t != null && Number.isFinite(r.c));
  if (rows.length < 2) return null;

  const W = 300, H = 96, L = 30, R = 6, T = 8, B = 18;
  const cs = rows.map((r) => r.c);
  const lo = Math.floor(Math.min(...cs) / 10) * 10;
  let hi = Math.ceil(Math.max(...cs) / 10) * 10 + 0; // +0 turns -0 into 0
  if (hi <= lo) hi = lo + 10;
  const x = (t) => L + (t / 24) * (W - L - R);
  const y = (c) => T + (1 - (c - lo) / (hi - lo)) * (H - T - B);

  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'mm-card__chart', role: 'img',
    'aria-label': `Air temperature over one sol, ${Math.min(...cs)} to ${Math.max(...cs)} °C` });

  // EVA window band
  const e0 = lmstToH(eva?.start_lmst), e1 = lmstToH(eva?.end_lmst);
  if (e0 != null && e1 != null && e1 > e0) {
    svg.append(s('rect', { x: x(e0), y: T, width: x(e1) - x(e0), height: H - T - B, class: 'mm-card__chart-eva' }));
    const lab = s('text', { x: (x(e0) + x(e1)) / 2, y: T + 9, class: 'mm-card__chart-evalabel', 'text-anchor': 'middle' });
    lab.textContent = 'EVA';
    svg.append(lab);
  }
  // grid + labels
  for (const c of [lo, (lo + hi) / 2, hi]) {
    svg.append(s('line', { x1: L, x2: W - R, y1: y(c), y2: y(c), class: 'mm-card__chart-grid' }));
    const t = s('text', { x: L - 4, y: y(c) + 3, 'text-anchor': 'end', class: 'mm-card__chart-tick' });
    t.textContent = `${Math.round(c)}°`;
    svg.append(t);
  }
  for (const hr of [0, 6, 12, 18, 24]) {
    const t = s('text', { x: x(hr), y: H - 5, 'text-anchor': 'middle', class: 'mm-card__chart-tick' });
    t.textContent = String(hr).padStart(2, '0');
    svg.append(t);
  }
  const d = rows.map((r, i) => `${i ? 'L' : 'M'}${x(r.t).toFixed(1)},${y(r.c).toFixed(1)}`).join('');
  svg.append(s('path', { d, class: 'mm-card__chart-line' }));

  const minC = weather.min_c ?? Math.min(...cs);
  const maxC = weather.max_c ?? Math.max(...cs);
  return h('section', { class: 'mm-card__weather' },
    h('div', { class: 'mm-card__weather-head' },
      h('span', { class: 'mm-card__label' }, 'Air temperature, one sol (LMST)'),
      weather.approximate ? h('span', { class: 'mm-card__tag', title: weather.method || '' }, 'approximate') : null),
    svg,
    h('p', { class: 'mm-card__weather-foot' },
      `${Math.round(minC)} °C to ${Math.round(maxC)} °C`,
      weather.source ? ` · ${weather.source}` : ''));
}

// ------------------------------------------------------------ card
export function initCards(state, el) {
  if (!el) {
    console.error('[cards] initCards: no container element');
    return { show() {}, hide() {} };
  }
  const st = state || {};
  el.classList.add('mm-cards');

  let current = null; // {stop, photos, index}

  const card = h('article', { class: 'mm-card', hidden: true, 'aria-live': 'polite', tabindex: '-1' });
  el.append(card);

  function hide() {
    card.hidden = true;
    current = null;
  }

  function setPhoto(i) {
    if (!current || !current.photos.length) return;
    const n = current.photos.length;
    current.index = ((i % n) + n) % n;
    render();
  }

  function photoBlock() {
    const { photos, index } = current;
    if (!photos.length) {
      return h('div', { class: 'mm-card__nophoto' }, 'No Curiosity photos linked to this stop yet.');
    }
    const p = photos[index];
    const img = h('img', {
      class: 'mm-card__img', src: p.url, alt: `${photoMeta(p) || 'Curiosity image'} near ${current.stop.name || 'this stop'}`,
      loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer',
    });
    const frame = h('a', { class: 'mm-card__frame', href: p.url, target: '_blank', rel: 'noopener', title: 'Open full image' }, img);
    img.addEventListener('error', () => {
      console.error('[cards] image failed to load:', p.url);
      frame.replaceChildren(h('div', { class: 'mm-card__nophoto' }, 'Image unavailable'));
    });

    const nav = photos.length > 1 ? [
      h('button', { class: 'mm-card__nav mm-card__nav--prev', type: 'button', 'aria-label': 'Previous photo', onclick: () => setPhoto(index - 1) }, '‹'),
      h('button', { class: 'mm-card__nav mm-card__nav--next', type: 'button', 'aria-label': 'Next photo', onclick: () => setPhoto(index + 1) }, '›'),
    ] : [];

    const thumbs = photos.length > 1 ? h('div', { class: 'mm-card__thumbs', role: 'tablist' },
      photos.map((q, i) => h('button', {
        class: 'mm-card__thumb' + (i === index ? ' is-active' : ''), type: 'button', role: 'tab',
        'aria-selected': i === index ? 'true' : 'false', 'aria-label': photoMeta(q) || `Photo ${i + 1}`,
        onclick: () => setPhoto(i),
      }, h('img', { src: q.url, alt: '', loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer' })))) : null;

    return h('figure', { class: 'mm-card__figure' },
      h('div', { class: 'mm-card__stage' }, frame, ...nav),
      h('figcaption', { class: 'mm-card__caption' },
        h('span', { class: 'mm-card__meta' }, photoMeta(p), photos.length > 1 ? `  ${index + 1}/${photos.length}` : ''),
        h('span', { class: 'mm-card__credit' }, `Image: ${creditFor(p)}`)),
      thumbs);
  }

  function render() {
    if (!current) return;
    const { stop } = current;
    const coord = fmtCoord(stop.coord);
    card.replaceChildren(
      h('header', { class: 'mm-card__head' },
        h('div', {},
          h('p', { class: 'mm-card__kicker' }, stop.id != null ? `Stop ${stop.id}` : 'Stop'),
          h('h2', { class: 'mm-card__title' }, stop.name || 'Unnamed stop'),
          coord ? h('p', { class: 'mm-card__coord' }, coord) : null),
        h('button', { class: 'mm-card__close', type: 'button', 'aria-label': 'Close card', onclick: hide }, '×')),
      photoBlock(),
      stop.science ? h('section', { class: 'mm-card__science' },
        h('span', { class: 'mm-card__label' }, 'Science'),
        h('p', {}, stop.science)) : null,
      weatherChart(st.weather, st.eva),
    );
  }

  function show(stop) {
    if (!stop || typeof stop !== 'object') {
      console.error('[cards] stop:select without a stop object', stop);
      return;
    }
    const photos = (Array.isArray(stop.photos) ? stop.photos : []).filter((p) => p && p.url);
    const sameStop = current && current.stop.id === stop.id && stop.id != null;
    current = { stop, photos, index: sameStop ? current.index : 0 };
    try {
      render();
      card.hidden = false;
    } catch (err) {
      console.error('[cards] render failed', err);
    }
  }

  document.addEventListener('stop:select', (ev) => show(ev.detail));
  document.addEventListener('keydown', (ev) => {
    if (card.hidden || ev.defaultPrevented) return;
    const t = ev.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    if (ev.key === 'Escape') hide();
    else if (ev.key === 'ArrowLeft') setPhoto((current?.index ?? 0) - 1);
    else if (ev.key === 'ArrowRight') setPhoto((current?.index ?? 0) + 1);
  });

  return { show, hide };
}
