// map/index.js (Ege): full-screen Leaflet map, Mars Trek base layers, layer popover,
// Curiosity traverse, planned route and stops. Clicking a stop dispatches 'stop:select'.
// Route planner (cards/nav.js): a click on the map sets the destination (or the point being
// picked); pins A and B are draggable; the routes from 'nav:routes' are drawn here, the selected
// one in oxide with a glow, the others grey and clickable ('nav:choose').
//
//   export function initMap(state, el)   // el = #map; the layer popover is drawn into #panel
//
// Any file in state may be null; missing layers are skipped quietly.

/* global L */
import { MARS_CRS, MARS_RADIUS_M, coordsToLatLng, toBounds, toLatLng } from './geo.js';
import { initProfile } from './profile.js';
import { loadHeightmap } from '../landing/heightmap.js';

const MAX_ZOOM = 19;

// Read a base.css variable: Leaflet paths take a colour value, not a CSS class
function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function tileLayer(layer) {
  const tl = L.tileLayer(layer.url, {
    maxNativeZoom: layer.maxNativeZoom,
    maxZoom: MAX_ZOOM,
    bounds: layer.bounds ? toBounds(layer.bounds) : undefined,
    attribution: layer.attribution,
    noWrap: true,
  });
  // If Trek is unreachable, fall back once to the backup tile cache (web/tiles/)
  if (layer.fallbackUrl) {
    tl.on('tileerror', ({ tile, coords }) => {
      if (tile.dataset.fallback) return;
      tile.dataset.fallback = '1';
      tile.src = L.Util.template(layer.fallbackUrl, coords);
    });
  }
  return tl;
}

// Tile and image layers have setOpacity; GeoJSON layers use setStyle (polygon fill at half strength)
function setLayerOpacity(layer, value) {
  if (layer.setOpacity) layer.setOpacity(value);
  else layer.setStyle?.({ opacity: value, fillOpacity: value * 0.5 });
}

// Geologic units (geology.geojson): one colour per unit from the base.css palette
const GEOLOGY_COLORS = ['--color-sand', '--color-info', '--color-ok', '--color-warn', '--color-dust', '--color-danger'];

function geologyLayer(geology, pane) {
  const units = [...new Set((geology.features || []).map((f) => f.properties?.unit).filter(Boolean))];
  const colorOf = Object.fromEntries(units.map((u, i) => [u, cssVar(GEOLOGY_COLORS[i % GEOLOGY_COLORS.length])]));
  const layer = L.geoJSON(geology, {
    coordsToLatLng,
    pane,
    style: (f) => {
      const c = colorOf[f.properties?.unit] || cssVar('--color-text-muted');
      return { color: c, weight: 1.5, opacity: 0.8, fillColor: c, fillOpacity: 0.4 };
    },
    onEachFeature: (f, l) => {
      const p = f.properties || {};
      const title = [p.name, p.unit && `(${p.unit})`].filter(Boolean).join(' ');
      if (title) l.bindTooltip(p.note ? `${title}<br><small>${p.note}</small>` : title, { sticky: true });
    },
  });
  const legend = units.map((u) => {
    const f = geology.features.find((x) => x.properties?.unit === u);
    return { color: colorOf[u], label: f?.properties?.name ? `${u} · ${f.properties.name}` : u };
  });
  return { layer, legend };
}

// Shelters (safety.json shelters[{coord, svf}]): svf = sky-view factor, lower = better cover
function shelterLayer(shelters) {
  const group = L.featureGroup();
  for (const s of shelters) {
    if (!Array.isArray(s?.coord)) continue;
    const svf = Number.isFinite(s.svf) ? ` · sky-view ${s.svf.toFixed(2)}` : '';
    L.circleMarker(toLatLng(s.coord), {
      radius: 5, color: cssVar('--color-bg'), weight: 2, fillColor: cssVar('--color-ok'), fillOpacity: 1,
    }).bindTooltip(`Shelter${svf}`).addTo(group);
  }
  return group;
}

// Planetocentric lat / east-positive lon, same convention as area.json
function fmtLatLon(ll) {
  const lat = `${Math.abs(ll.lat).toFixed(4)}°${ll.lat < 0 ? 'S' : 'N'}`;
  const lon = `${(((ll.lng % 360) + 360) % 360).toFixed(4)}°E`;
  return `${lat}  ${lon}`;
}

// Cursor position in the bottom-left corner
function coordsControl(map) {
  const ctl = L.control({ position: 'bottomleft' });
  ctl.onAdd = () => {
    const box = L.DomUtil.create('div', 'leaflet-control map-coords');
    box.setAttribute('aria-hidden', 'true'); // decorative; screen readers skip it
    box.textContent = 'Move over the map';
    map.on('mousemove', (e) => { box.textContent = fmtLatLon(e.latlng); });
    map.on('mouseout', () => { box.textContent = fmtLatLon(map.getCenter()); });
    return box;
  };
  return ctl.addTo(map);
}

// Elevation and slope at a point, from Demir's heightmap (summary.json "terrain"), loaded on first
// use. Slope: steepest direction from the elevation one pixel either side (~4.6 m), like the slope
// layer. The "steep" / "too steep" notes use slope_warn_deg / slope_max_deg from mission.json.
function terrainProbe(terrain, mission) {
  if (!terrain?.png) return async () => null;
  const warnDeg = Number.isFinite(mission?.slope_warn_deg) ? mission.slope_warn_deg : null;
  const maxDeg = Number.isFinite(mission?.slope_max_deg) ? mission.slope_max_deg : null;
  let hm = null;
  return async (lon, lat) => {
    try {
      hm = hm ?? await loadHeightmap(terrain, { size: 512 });
    } catch (err) {
      console.error('[map] heightmap failed', err);
      return null;
    }
    const z = hm.at(lon, lat);
    if (z == null) return null;
    const dLon = (hm.bounds.east - hm.bounds.west) / hm.width;
    const dLat = (hm.bounds.north - hm.bounds.south) / hm.height;
    const mLat = (dLat * Math.PI / 180) * MARS_RADIUS_M;
    const mLon = (dLon * Math.PI / 180) * MARS_RADIUS_M * Math.cos(lat * Math.PI / 180);
    const ze = hm.at(lon + dLon, lat);
    const zw = hm.at(lon - dLon, lat);
    const zn = hm.at(lon, lat + dLat);
    const zs = hm.at(lon, lat - dLat);
    let slope = null;
    if ([ze, zw, zn, zs].every((v) => v != null)) {
      slope = Math.atan(Math.hypot((ze - zw) / (2 * mLon), (zn - zs) / (2 * mLat))) * 180 / Math.PI;
    }
    let note = '';
    if (slope != null && maxDeg != null && slope > maxDeg) note = ' (too steep to walk)';
    else if (slope != null && warnDeg != null && slope >= warnDeg) note = ' (steep)';
    return { z, slope, note };
  };
}

// Lat/lon grid that picks a round step for the current zoom
const GRID_STEPS = [10, 5, 2, 1, 0.5, 0.2, 0.1, 0.05, 0.02, 0.01, 0.005, 0.002, 0.001, 0.0005];

// Labels sit just inside the top edge (under the header) and the right edge; pixel margins keep
// them clear of the header, the route planner (left), the overview map and the layers button.
const GRID_LABEL_INSET = { top: 64, right: 10 };
const GRID_LABEL_MARGIN = { left: 400, right: 170, top: 190, bottom: 90 };

function gridLayer(map) {
  const group = L.featureGroup();
  const style = { color: cssVar('--color-text-inverse'), weight: 1, opacity: 0.22, interactive: false };

  function draw() {
    group.clearLayers();
    const b = map.getBounds();
    const span = Math.max(b.getEast() - b.getWest(), b.getNorth() - b.getSouth());
    const step = GRID_STEPS.find((s) => span / s >= 4) ?? GRID_STEPS[GRID_STEPS.length - 1];
    const digits = Math.max(0, -Math.floor(Math.log10(step)));
    const label = (text, latlng, cls) => L.marker(latlng, {
      interactive: false, keyboard: false,
      // Leaflet positions the icon with a CSS transform, so the offset goes on the inner span
      icon: L.divIcon({ className: `map-grid-label ${cls}`, html: `<span>${text}</span>`, iconSize: [0, 0] }),
    });
    // Skip labels that would sit under a map control or collide in a corner:
    // zoom buttons top-right, cursor coordinates and scale bottom-left.
    const size = map.getSize();
    const px = (latlng) => map.latLngToContainerPoint(latlng);
    const topLat = map.containerPointToLatLng([0, GRID_LABEL_INSET.top]).lat;
    const rightLon = map.containerPointToLatLng([size.x - GRID_LABEL_INSET.right, 0]).lng;
    for (let lon = Math.ceil(b.getWest() / step) * step; lon <= b.getEast(); lon += step) {
      group.addLayer(L.polyline([[b.getSouth(), lon], [b.getNorth(), lon]], style));
      const { x } = px([b.getNorth(), lon]);
      if (x < GRID_LABEL_MARGIN.left || x > size.x - GRID_LABEL_MARGIN.right) continue;
      group.addLayer(label(`${lon.toFixed(digits)}°E`, [topLat, lon], 'is-lon'));
    }
    for (let lat = Math.ceil(b.getSouth() / step) * step; lat <= b.getNorth(); lat += step) {
      group.addLayer(L.polyline([[lat, b.getWest()], [lat, b.getEast()]], style));
      const { y } = px([lat, b.getWest()]);
      if (y < GRID_LABEL_MARGIN.top || y > size.y - GRID_LABEL_MARGIN.bottom) continue;
      const ns = lat < 0 ? 'S' : 'N';
      group.addLayer(label(`${Math.abs(lat).toFixed(digits)}°${ns}`, [lat, rightLon], 'is-lat'));
    }
  }

  map.on('moveend zoomend resize', () => { if (map.hasLayer(group)) draw(); });
  group.on('add', draw);
  return group;
}

// Overview map (top-right): a global base layer around Gale crater, with the main
// view drawn on it. Clicking it pans the main map there. Hidden on narrow screens (base.css).
const MINIMAP_ZOOM = 5; // whole Gale crater (~150 km) fits in the box

function miniMap(map, layers) {
  const global = layers.find((l) => l.type === 'base' && l.bounds
    && l.bounds.east - l.bounds.west >= 359);
  if (!global) return null;

  const ctl = L.control({ position: 'topright' });
  ctl.onAdd = () => {
    const box = L.DomUtil.create('div', 'leaflet-control map-minimap');
    box.setAttribute('role', 'img');
    box.setAttribute('aria-label', 'Overview map: location within Gale crater');
    box.title = 'Click to move the map here';
    L.DomEvent.disableClickPropagation(box);
    L.DomEvent.disableScrollPropagation(box);
    return box;
  };
  ctl.addTo(map);

  const mini = L.map(ctl.getContainer(), {
    crs: MARS_CRS,
    attributionControl: false, zoomControl: false, dragging: false, scrollWheelZoom: false,
    doubleClickZoom: false, boxZoom: false, keyboard: false, touchZoom: false, zoomSnap: 0,
  });
  tileLayer(global).addTo(mini); // same helper as the main map, so it falls back to web/tiles/ too
  const accent = cssVar('--color-accent');
  const view = L.rectangle(map.getBounds(), { color: accent, weight: 1, fillOpacity: 0.15, interactive: false }).addTo(mini);
  const dot = L.circleMarker(map.getCenter(), {
    radius: 3, color: accent, weight: 1, fillColor: accent, fillOpacity: 1, interactive: false,
  }).addTo(mini);

  function sync() {
    view.setBounds(map.getBounds());
    dot.setLatLng(map.getCenter());
    mini.setView(map.getCenter(), Math.min(MINIMAP_ZOOM, map.getZoom()), { animate: false });
  }
  map.on('moveend zoomend resize', sync);
  mini.on('click', (e) => map.panTo(e.latlng));
  // The box gets its size from CSS after insertion; measure once laid out
  requestAnimationFrame(() => { mini.invalidateSize(); sync(); });
  return mini;
}

function imageLayer(ov) {
  return L.imageOverlay(ov.png, toBounds(ov.bounds), { opacity: 0.7, interactive: false });
}

// route.geojson -> fn(fraction 0..1) -> L.LatLng at that share of the route length.
// The profile's d axis and the drawn geometry can differ by a few percent (projected grid
// vs. great-circle length), so positions are matched by fraction, not by metres.
function routeSampler(map, route) {
  const geom = route?.geometry ?? route?.features?.[0]?.geometry;
  if (geom?.type !== 'LineString' || geom.coordinates.length < 2) return null;
  const pts = geom.coordinates.map(coordsToLatLng);
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + map.distance(pts[i - 1], pts[i]));
  const length = cum[cum.length - 1];
  return (fraction) => {
    const target = Math.min(Math.max(fraction, 0), 1) * length;
    let i = cum.findIndex((c) => c >= target);
    if (i <= 0) return pts[0];
    const t = (target - cum[i - 1]) / (cum[i] - cum[i - 1] || 1);
    return L.latLng(
      pts[i - 1].lat + (pts[i].lat - pts[i - 1].lat) * t,
      pts[i - 1].lng + (pts[i].lng - pts[i - 1].lng) * t,
    );
  };
}

// Initial view: area.json > Curiosity traverse > bounds of the first base layer
function initialBounds(state, extra) {
  if (state.area?.bbox) return toBounds(state.area.bbox);
  if (extra.isValid()) return extra;
  const base = (state.layers || []).find((l) => l.type === 'base' && l.bounds);
  return base ? toBounds(base.bounds) : null;
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  node.append(...children.filter((c) => c !== null && c !== undefined && c !== ''));
  return node;
}

function legendEl(legend) {
  if (!legend?.length) return null;
  return el('ul', { class: 'layer-legend' },
    ...legend.map((item) => {
      const swatch = el('span', { class: 'swatch' });
      swatch.style.background = item.color;
      return el('li', {}, swatch, item.label);
    }));
}

// Habitat badge icon (simple house outline; colours come from base.css via currentColor)
const HABITAT_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">'
  + '<path d="M4 11.5 12 5l8 6.5V19a1 1 0 0 1-1 1h-4.5v-5h-5v5H5a1 1 0 0 1-1-1z" fill="currentColor"/></svg>';

// Radio relay badge: a small mast with signal arcs
const RELAY_SVG = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">'
  + '<path d="M12 9v12M8.5 21h7M12 9l-3.5 12M12 9l3.5 12" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round"/>'
  + '<circle cx="12" cy="7" r="2" fill="currentColor"/>'
  + '<path d="M7.6 3.6a6 6 0 0 0 0 6.8M16.4 3.6a6 6 0 0 1 0 6.8" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round"/></svg>';

// Panel groups, in display order. Each overlay carries its group from where it was added.
const PANEL_GROUPS = ['Route', 'Terrain', 'Safety', 'Imagery', 'Science'];
const THUMB_ZOOM = 12;   // one Trek tile at this zoom covers the study area: used as a preview

// A preview image for a layer: the PNG of a PNG overlay, or one Trek tile around the area centre
function thumbUrl(meta, center) {
  if (meta.png) return meta.png;
  if (!meta.url || !center) return null;
  const z = Math.min(THUMB_ZOOM, Number(meta.maxNativeZoom) || THUMB_ZOOM);
  const d = 180 / 2 ** z;
  const x = Math.floor((center.lng + 180) / d);
  const y = Math.floor((90 - center.lat) / d);
  return L.Util.template(meta.url, { z, x, y });
}

function thumbImg(meta, center, cls) {
  const url = thumbUrl(meta, center);
  if (!url) return el('span', { class: cls, 'aria-hidden': 'true' });
  const img = el('img', { class: cls, src: url, alt: '', loading: 'lazy', decoding: 'async' });
  img.addEventListener('error', () => { img.removeAttribute('src'); }, { once: true });
  return img;
}

function overlayItem(map, { meta, layer, on }, center) {
  const box = el('input', { type: 'checkbox', value: meta.id });
  box.checked = Boolean(on);
  const opacity = el('input', {
    type: 'range', min: '0', max: '1', step: '0.05', value: String(layer.options.opacity ?? 1),
    'aria-label': `${meta.name} opacity`, class: 'layer-opacity',
  });
  const legend = legendEl(meta.legend);
  // Opacity and legend only show while the layer is on, so the panel stays short
  const sync = () => {
    opacity.hidden = !box.checked;
    if (legend) legend.hidden = !box.checked;
  };
  box.addEventListener('change', () => {
    if (box.checked) layer.addTo(map); else map.removeLayer(layer);
    sync();
  });
  opacity.addEventListener('input', () => setLayerOpacity(layer, Number(opacity.value)));
  sync();
  const thumb = meta.png || meta.url ? thumbImg(meta, center, 'layer-thumb') : null;
  return el('div', { class: 'layer-item' },
    el('label', { class: 'layer-row' }, box, thumb, el('span', {}, meta.name)), opacity, legend);
}

function buildPanel(panel, map, bases, overlays, center, onClose) {
  // overlays: [{meta, layer, on, group}] — layers with on=true start switched on
  panel.replaceChildren(el('div', { class: 'panel-head' },
    el('h2', {}, 'Map layers'),
    el('button', { class: 'panel-close', type: 'button', 'aria-label': 'Close layers', onclick: onClose }, '\u00d7')));

  if (bases.length) {
    const tiles = [];
    const grid = el('div', { class: 'base-grid', role: 'group', 'aria-label': 'Base map' });
    bases.forEach(({ meta, layer }, i) => {
      const tile = el('button', { class: 'base-tile', type: 'button', 'aria-pressed': String(i === 0), title: meta.attribution || meta.name },
        thumbImg(meta, center, ''), el('span', {}, meta.name.replace(/ mosaic$/i, '')));
      tile.addEventListener('click', () => {
        bases.forEach((b) => map.removeLayer(b.layer));
        layer.addTo(map).bringToBack();
        tiles.forEach((t) => t.setAttribute('aria-pressed', String(t === tile)));
      });
      tiles.push(tile);
      grid.append(tile);
    });
    panel.append(el('p', { class: 'panel-title' }, 'Base map'), grid);
  }

  const groups = [...PANEL_GROUPS, ...new Set(overlays.map((o) => o.group).filter((g) => !PANEL_GROUPS.includes(g)))];
  for (const name of groups) {
    const items = overlays.filter((o) => (o.group || 'Route') === name);
    if (!items.length) continue;
    const section = el('details', { class: 'panel-group' },
      el('summary', { class: 'panel-title' }, name),
      el('div', { class: 'layer-list' }, ...items.map((o) => overlayItem(map, o, center))));
    section.open = name === 'Route' || name === 'Terrain';
    panel.append(section);
  }
}

// ---------------------------------------------------------------- route planner layer
// Pins A / B: teardrop markers, draggable. Routes from nav:routes; the selected one is drawn
// last, in oxide with a soft glow, and animated when it first appears.
const DRAW_MS = 700;          // route draw-in animation
const NAV_FIT_PADDING = 48;   // px around the routes when the view is fitted to them

function navPin(which) {
  return L.divIcon({
    className: `nav-pin is-${which}`,
    html: `<span><b>${which === 'start' ? 'A' : 'B'}</b></span>`,
    iconSize: [30, 30],
    iconAnchor: [15, 38],   // the tip of the teardrop is the point
  });
}

function navLayer(map, probe, onProfile) {
  const group = L.layerGroup().addTo(map);
  const pins = { start: null, end: null };
  let picking = null;
  let data = null;   // last nav:routes detail
  let drawKey = '';
  let anim = null;
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const colors = { on: cssVar('--color-accent'), alt: cssVar('--color-muted-route'), halo: cssVar('--color-surface') };

  const send = (which, coord) => document.dispatchEvent(new CustomEvent('nav:point', { detail: { which, coord } }));

  function setPin(which, coord) {
    if (!Array.isArray(coord)) {
      if (pins[which]) { pins[which].remove(); pins[which] = null; }
      return;
    }
    const ll = toLatLng(coord);
    if (!pins[which]) {
      pins[which] = L.marker(ll, {
        icon: navPin(which), draggable: true, autoPan: true, zIndexOffset: 2000,
        title: which === 'start' ? 'Start (drag to move)' : 'Destination (drag to move)',
        alt: which === 'start' ? 'Start' : 'Destination',
      }).addTo(map);
      pins[which].on('dragend', (e) => {
        const p = e.target.getLatLng();
        send(which, [p.lng, p.lat]);
      });
    } else {
      pins[which].setLatLng(ll);
    }
    if (which === 'end') describe(coord);
  }

  async function describe(coord) {
    const pin = pins.end;
    const info = await probe(coord[0], coord[1]);
    if (!pin || pin !== pins.end) return;
    const text = info
      ? `Destination · ${Math.round(info.z).toLocaleString('en-US')} m · slope ${info.slope == null ? '—' : `${Math.round(info.slope)}°`}${info.note}`
      : 'Destination';
    pin.unbindTooltip().bindTooltip(text, { direction: 'top', offset: [0, -44] });
  }

  function draw() {
    group.clearLayers();
    if (anim) { cancelAnimationFrame(anim); anim = null; }
    const opts = Array.isArray(data?.options) ? data.options : [];
    const chosen = opts.find((o) => o.id === data.chosen) || null;
    for (const o of opts) {
      if (o === chosen) continue;
      const line = L.polyline(o.feature.geometry.coordinates.map(toLatLng), {
        color: colors.alt, weight: 5, opacity: 0.8, className: 'nav-route-alt', bubblingMouseEvents: false,
      }).bindTooltip(`${o.label} · ${Math.round(o.summary.duration_min)} min`, { sticky: true });
      line.on('click', (e) => {
        L.DomEvent.stop(e);
        document.dispatchEvent(new CustomEvent('nav:choose', { detail: { id: o.id } }));
      });
      group.addLayer(line);
    }
    if (chosen) {
      const pts = chosen.feature.geometry.coordinates.map(toLatLng);
      const glow = L.polyline([], { color: colors.on, weight: 14, opacity: 0.35, className: 'nav-route-glow', interactive: false });
      const casing = L.polyline([], { color: colors.halo, weight: 8, opacity: 0.9, interactive: false });
      const main = L.polyline([], { color: colors.on, weight: 5, opacity: 1, interactive: false });
      group.addLayer(glow).addLayer(casing).addLayer(main);
      const key = `${data.start}|${data.end}|${data.roundTrip}`;
      const animate = !reduced && key !== drawKey;
      drawKey = key;
      const setUpTo = (n) => { const part = pts.slice(0, n); glow.setLatLngs(part); casing.setLatLngs(part); main.setLatLngs(part); };
      if (!animate) setUpTo(pts.length);
      else {
        const t0 = performance.now();
        const step = (now) => {
          const k = Math.min((now - t0) / DRAW_MS, 1);
          setUpTo(Math.max(2, Math.ceil(pts.length * (1 - (1 - k) ** 3))));
          anim = k < 1 ? requestAnimationFrame(step) : null;
        };
        anim = requestAnimationFrame(step);
      }
    }
    onProfile(chosen);
  }

  function fit() {
    const b = L.latLngBounds([]);
    for (const o of data?.options || []) for (const c of o.feature.geometry.coordinates) b.extend(toLatLng(c));
    if (Array.isArray(data?.start)) b.extend(toLatLng(data.start));
    if (Array.isArray(data?.end)) b.extend(toLatLng(data.end));
    if (!b.isValid()) return;
    if (map.getBounds().contains(b)) return;
    // keep the routes clear of the planner on the left and the profile at the bottom; on a narrow
    // screen (planner as a bottom sheet) or a tiny window the padding would not fit: use none
    const size = map.getSize();
    if (size.x < 2 * NAV_FIT_PADDING || size.y < 2 * NAV_FIT_PADDING) return;   // hidden or minimised
    const pad = NAV_FIT_PADDING;
    const cards = document.getElementById('cards');
    const side = cards && cards.offsetWidth < size.x / 2 ? cards.offsetWidth : 0;
    const tl = [side + 2 * pad, 2 * pad];
    const br = [pad, 4 * pad];
    const fits = size.x > tl[0] + br[0] + pad && size.y > tl[1] + br[1] + pad;
    try {
      map.flyToBounds(b, fits ? { paddingTopLeft: tl, paddingBottomRight: br, maxZoom: 17, duration: 0.8 } : { maxZoom: 17, duration: 0.8 });
    } catch (err) {
      console.warn('[map] could not frame the routes', err.message);
    }
  }

  map.on('click', (e) => {
    const which = picking || 'end';
    picking = null;
    map.getContainer().classList.remove('is-picking');
    send(which, [e.latlng.lng, e.latlng.lat]);
  });
  document.addEventListener('nav:pick', (e) => {
    picking = e.detail?.which === 'start' ? 'start' : 'end';
    map.getContainer().classList.add('is-picking');
  });
  document.addEventListener('nav:cancel', () => {
    picking = null;
    map.getContainer().classList.remove('is-picking');
  });
  document.addEventListener('nav:routes', (e) => {
    data = e.detail || null;
    setPin('start', data?.start);
    setPin('end', data?.end);
    draw();
    if (data?.options?.length) fit();
  });
  document.addEventListener('nav:choose', (e) => {
    if (!data || !e.detail?.id || data.chosen === e.detail.id) return;
    data = { ...data, chosen: e.detail.id };
    draw();
  });
  document.addEventListener('nav:clear', () => {
    if (data) data = { ...data, options: [], end: null };
    setPin('end', null);
    draw();
  });
  // the cards can tell the map is able to pick points
  document.documentElement.dataset.navMap = 'on';
  return group;
}

export function initMap(state, mapEl) {
  const map = L.map(mapEl, {
    crs: MARS_CRS,
    minZoom: 3,
    maxZoom: MAX_ZOOM,
    zoomSnap: 0.5,
    attributionControl: true,
    zoomControl: false,
  });
  map.attributionControl.setPrefix(false);   // credits are in the footer line
  // Bottom-left, next to the route planner: zoom, then scale and cursor coordinates
  L.control.zoom({ position: 'bottomleft' }).addTo(map);
  L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(map);
  coordsControl(map);
  const probe = terrainProbe(state.summary?.terrain, state.mission);

  // Base layers and tile overlays (layers.json)
  const layers = state.layers || [];
  const bases = layers.filter((l) => l.type === 'base').map((meta) => ({ meta, layer: tileLayer(meta) }));
  const overlays = layers.filter((l) => l.type === 'overlay')
    .map((meta) => ({ meta, layer: tileLayer(meta), group: 'Imagery' }));
  bases[0]?.layer.addTo(map);
  overlays.forEach((o) => o.layer.setOpacity(0.6));

  // PNG overlays (overlays.json + safety.json), same schema
  for (const ov of state.overlays || []) {
    if (ov?.png && ov?.bounds) overlays.push({ meta: ov, layer: imageLayer(ov), group: 'Terrain' });
  }
  for (const ov of state.safety?.overlays || []) {
    if (ov?.png && ov?.bounds) overlays.push({ meta: ov, layer: imageLayer(ov), group: 'Safety' });
  }

  // Vector layers are built first and added after the view is set: Leaflet circle
  // markers throw if they are added to a map that has no center/zoom yet.
  const extent = L.latLngBounds([]);
  const vectors = [];

  // Curiosity's actual traverse: off by default (Layers); a thick blue line on a light casing so it
  // reads on the imagery
  if (state.traverse) {
    const traverse = L.featureGroup([
      L.geoJSON(state.traverse, { coordsToLatLng, style: { color: cssVar('--color-surface'), weight: 8, opacity: 0.85 }, interactive: false }),
      L.geoJSON(state.traverse, { coordsToLatLng, style: { color: cssVar('--color-info'), weight: 4.5, opacity: 1 }, interactive: false }),
    ]);
    extent.extend(traverse.getBounds());
    overlays.push({ meta: { id: 'traverse', name: "Curiosity rover's real path" }, layer: traverse, on: false, group: 'Route' });
  }

  // Geologic map (geology.geojson), off by default
  if (state.geology?.features?.length) {
    // Own pane under the route and stops so the polygons never block stop clicks
    map.createPane('geology').style.zIndex = 350;
    const { layer, legend } = geologyLayer(state.geology, 'geology');
    overlays.push({ meta: { id: 'geology', name: 'Geologic units', legend }, layer, group: 'Science' });
  }

  // Shelters from safety.json, on by default
  if (Array.isArray(state.safety?.shelters) && state.safety.shelters.length) {
    const shelters = shelterLayer(state.safety.shelters);
    vectors.push(shelters);
    overlays.push({ meta: { id: 'shelters', name: 'Shelters' }, layer: shelters, on: true, group: 'Safety' });
  }

  // Radio relay from safety.json: a mast that shortens the time without a link
  const relay = state.safety?.relay;
  if (Array.isArray(relay?.coord)) {
    const height = Number.isFinite(relay.antenna_height_m) ? ` (${relay.antenna_height_m} m)` : '';
    const before = relay.offline_min_without_relay;
    const after = state.safety?.offline_min;
    const gain = Number.isFinite(before) && Number.isFinite(after)
      ? `<br>Time without link ${Math.round(before)} → ${Math.round(after)} min` : '';
    const marker = L.marker(toLatLng(relay.coord), {
      icon: L.divIcon({ className: 'relay-pin', html: RELAY_SVG, iconSize: [24, 24], iconAnchor: [12, 22] }),
      title: `Radio relay${height}`, alt: `Radio relay${height}`, zIndexOffset: 400,
    }).bindTooltip(`Radio relay${height}${gain}`, { direction: 'top', offset: [0, -20] });
    vectors.push(marker);
    overlays.push({ meta: { id: 'relay', name: 'Radio relay' }, layer: marker, on: true, group: 'Safety' });
  }

  // Planned Marswalk route (Demir): the science walk the HUD follows. Off by default (Layers), so the
  // route planner's own routes are the only lines at first; dashed sand on a light casing
  if (state.route) {
    const route = L.featureGroup([
      L.geoJSON(state.route, { coordsToLatLng, style: { color: cssVar('--color-surface'), weight: 7, opacity: 0.85 }, interactive: false }),
      L.geoJSON(state.route, { coordsToLatLng, style: { color: cssVar('--color-sand'), weight: 4, opacity: 1, dashArray: '10 7' }, interactive: false }),
    ]);
    extent.extend(route.getBounds());
    overlays.push({ meta: { id: 'planned', name: 'Planned science walk (HUD)' }, layer: route, on: false, group: 'Route' });
  }

  // Habitat: house badge
  if (Array.isArray(state.area?.habitat)) {
    vectors.push(L.marker(toLatLng(state.area.habitat), {
      icon: L.divIcon({ className: 'habitat-pin', html: HABITAT_SVG, iconSize: [28, 28], iconAnchor: [14, 14] }),
      title: 'Habitat', alt: 'Habitat', zIndexOffset: 500,
    }).bindTooltip('Habitat', { direction: 'top', offset: [0, -14] }));
  }

  // Stops: numbered badges in route order; click or Enter dispatches 'stop:select'
  if (Array.isArray(state.stops)) {
    const markers = [];
    state.stops.forEach((stop, i) => {
      if (!Array.isArray(stop.coord)) return;
      const name = stop.name ?? stop.id;
      const m = L.marker(toLatLng(stop.coord), {
        icon: L.divIcon({ className: 'stop-pin', html: `<span>${i + 1}</span>`, iconSize: [24, 24], iconAnchor: [12, 12] }),
        title: `Stop ${i + 1}: ${name}`, alt: `Stop ${i + 1}: ${name}`, zIndexOffset: 1000,
      }).bindTooltip(`${i + 1}. ${name}`, { direction: 'top', offset: [0, -12] });
      m.on('click', () => {
        markers.forEach((x) => x.getElement()?.classList.remove('is-selected'));
        m.getElement()?.classList.add('is-selected');
        document.dispatchEvent(new CustomEvent('stop:select', { detail: stop }));
      });
      markers.push(m);
      extent.extend(m.getLatLng());
    });
    const stopGroup = L.featureGroup(markers);
    vectors.push(stopGroup);
    overlays.push({ meta: { id: 'stops', name: 'Science stops' }, layer: stopGroup, on: true, group: 'Route' });
  }

  const bounds = initialBounds(state, extent);
  if (bounds) map.fitBounds(bounds, { padding: [16, 16] });
  else map.setView([0, 0], 3);
  vectors.forEach((v) => v.addTo(map));

  // Overview map (needs the main view set first)
  try {
    miniMap(map, layers);
  } catch (err) {
    console.warn('[map] overview map failed', err);
  }

  // Lat/lon grid, switchable from the layer panel
  const grid = gridLayer(map);
  overlays.push({ meta: { id: 'grid', name: 'Lat/lon grid' }, layer: grid, on: true, group: 'Route' });
  grid.addTo(map);

  // Layers: a button bottom-right opens the popover (#panel); Esc or a click on the map closes it
  const panel = document.getElementById('panel');
  const layersBtn = document.getElementById('layers-toggle');
  const setLayersOpen = (open) => {
    if (!panel) return;
    panel.hidden = !open;
    layersBtn?.setAttribute('aria-expanded', String(open));
  };
  if (panel) {
    buildPanel(panel, map, bases, overlays, bounds?.getCenter() ?? null, () => { setLayersOpen(false); layersBtn?.focus(); });
    layersBtn?.addEventListener('click', () => setLayersOpen(panel.hidden));
    map.on('mousedown', () => setLayersOpen(false));
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !panel.hidden) { setLayersOpen(false); e.preventDefault(); }
    });
  } else if (layersBtn) {
    layersBtn.hidden = true;
  }

  // Astronaut position from the HUD simulation clock ('hud:time').
  // detail: {active, playing, utc, elapsed_min, coord: [lon, lat] | null, d_m | null,
  //          storm, shelter: [lon, lat] | null, refuge_path: [[lon, lat], ...] | null, refuge_label}
  const astronaut = L.circleMarker([0, 0], {
    radius: 7, color: cssVar('--color-bg'), weight: 2,
    fillColor: cssVar('--color-hud'), fillOpacity: 1, interactive: false,
  }).bindTooltip('Astronaut', { direction: 'top', offset: [0, -8] });
  // HUD path (refuge_path): during the storm a pulsing red ring on the refuge and the path to it;
  // otherwise (science target, its preview, back to the route) the same in a calm colour
  const danger = cssVar('--color-danger');
  const calm = cssVar('--color-ok');
  const shelterRing = L.circleMarker([0, 0], {
    radius: 14, color: danger, weight: 3, fill: false, interactive: false, className: 'shelter-alert',
  }).bindTooltip('Nearest shelter', { permanent: true, direction: 'right', offset: [14, 0], className: 'shelter-alert-label' });
  const shelterLine = L.polyline([], { color: danger, weight: 2, dashArray: '6 6', interactive: false });
  let stormShown = false;
  let lastFlyMin = null;   // simulation minute of the last zoom to a path (no zoom twice in one event)
  // Dust devil scenario (HUD hud:time.hazard = {coord, radius_m}): a moving circle, sized in metres
  const warnColor = cssVar('--color-warn');
  const dustDevil = L.circle([0, 0], {
    radius: 40, color: warnColor, weight: 2, dashArray: '4 4', fillColor: warnColor, fillOpacity: 0.35, interactive: false,
  }).bindTooltip('Dust devil', { permanent: true, direction: 'right', offset: [10, 0] });

  document.addEventListener('hud:time', (e) => {
    const { active, coord, elapsed_min: elapsed, storm, shelter, hazard } = e.detail || {};
    if (active && Array.isArray(hazard?.coord)) {
      dustDevil.setLatLng(toLatLng(hazard.coord));
      if (Number.isFinite(hazard.radius_m)) dustDevil.setRadius(hazard.radius_m);
      if (!map.hasLayer(dustDevil)) dustDevil.addTo(map);
    } else {
      dustDevil.remove();
    }
    // HUD refuge_path: the walkable path still ahead to the refuge (or back to the route after
    // the storm), around steep ground. Without it, a straight line to the shelter.
    const { refuge_path: refugePath, refuge_label: refugeLabel } = e.detail || {};
    const path = Array.isArray(refugePath) && refugePath.length > 1 ? refugePath
      : storm && Array.isArray(coord) && Array.isArray(shelter) ? [coord, shelter] : null;
    const showStorm = Boolean(active && path);
    if (showStorm) {
      const color = storm ? danger : calm;
      shelterRing.setLatLng(toLatLng(path[path.length - 1]));
      shelterRing.setStyle({ color });
      shelterLine.setStyle({ color });
      shelterRing.setTooltipContent(refugeLabel || 'Nearest shelter');
      shelterLine.setLatLngs(path.map(toLatLng));
      if (!map.hasLayer(shelterLine)) shelterLine.addTo(map);
      if (!map.hasLayer(shelterRing)) shelterRing.addTo(map);
      // Pulse and red label only during the storm
      shelterRing.getElement()?.classList.toggle('shelter-alert', Boolean(storm));
      shelterRing.getTooltip()?.getElement()?.classList.toggle('is-calm', !storm);
      // When a path first shows, zoom to the astronaut and the path once, with the dust devil in
      // view too (it is why the astronaut steps aside); not again within the same event
      // (e.g. stepping aside, then walking back after the wait).
      const recent = Number.isFinite(lastFlyMin) && Number.isFinite(elapsed) && Math.abs(elapsed - lastFlyMin) < 15;
      if (!stormShown && !recent) {
        const bounds = shelterLine.getBounds();
        if (Array.isArray(hazard?.coord)) bounds.extend(toLatLng(hazard.coord));
        map.flyToBounds(bounds, { padding: [80, 80], maxZoom: 17, duration: 1 });
        lastFlyMin = elapsed;
      }
    } else {
      shelterRing.remove();
      shelterLine.remove();
    }
    stormShown = showStorm;

    if (!active || !Array.isArray(coord)) {
      astronaut.remove();
      return;
    }
    astronaut.setLatLng(toLatLng(coord));
    if (!map.hasLayer(astronaut)) astronaut.addTo(map);
    astronaut.bringToFront();
    // hud:time comes ~10 times a second: update the tooltip text, do not rebuild it
    astronaut.setTooltipContent(Number.isFinite(elapsed) ? `Astronaut · T+${Math.round(elapsed)} min` : 'Astronaut');
  });

  // Elevation profile of the selected planner route (bottom); hovering it marks the spot on the map
  const hover = L.circleMarker([0, 0], {
    radius: 6, color: cssVar('--color-surface'), weight: 2,
    fillColor: cssVar('--color-accent'), fillOpacity: 1, interactive: false,
  });
  const profileEl = document.getElementById('profile');
  let chart = null;
  function showProfile(option) {
    if (!profileEl) return;
    chart?.detach?.();
    chart = null;
    hover.remove();
    const prof = option?.summary?.profile;
    if (!Array.isArray(prof) || prof.length < 2) {
      profileEl.hidden = true;
      document.body.classList.remove('has-profile');
      return;
    }
    profileEl.hidden = false;
    document.body.classList.add('has-profile');
    const along = routeSampler(map, option.feature);
    const total = prof[prof.length - 1].d;
    try {
      chart = initProfile({ summary: option.summary }, profileEl, {
        label: `the ${option.label.toLowerCase()} route`,
        onHover: (d) => {
          const ll = along && Number.isFinite(d) && total ? along(d / total) : null;
          if (!ll) { hover.remove(); return; }
          hover.setLatLng(ll);
          if (!map.hasLayer(hover)) hover.addTo(map);
        },
      });
    } catch (err) {
      console.warn('[profile] failed to draw', err);
      profileEl.hidden = true;
      document.body.classList.remove('has-profile');
    }
  }
  navLayer(map, probe, showProfile);

  // Re-measure the map when HUD mode changes the layout
  new MutationObserver(() => map.invalidateSize())
    .observe(document.body, { attributes: true, attributeFilter: ['data-mode'] });
  window.addEventListener('resize', () => map.invalidateSize());

  return map;
}
