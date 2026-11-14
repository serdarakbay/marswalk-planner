// map/index.js (Ege): Leaflet map, Mars Trek base layers, layer panel,
// Curiosity traverse, planned route and stops. Clicking a stop dispatches 'stop:select'.
//
//   export function initMap(state, el)   // el = #map; the panel is drawn into #panel
//
// Any file in state may be null; missing layers are skipped quietly.

/* global L */
import { MARS_CRS, coordsToLatLng, toBounds, toLatLng } from './geo.js';

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

// Tile and image layers have setOpacity; GeoJSON lines use setStyle
function setLayerOpacity(layer, value) {
  if (layer.setOpacity) layer.setOpacity(value);
  else layer.setStyle?.({ opacity: value });
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

// Lat/lon grid that picks a round step for the current zoom
const GRID_STEPS = [10, 5, 2, 1, 0.5, 0.2, 0.1, 0.05, 0.02, 0.01, 0.005, 0.002, 0.001, 0.0005];

function gridLayer(map) {
  const group = L.featureGroup();
  const style = { color: cssVar('--color-text-muted'), weight: 1, opacity: 0.35, interactive: false };

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
    for (let lon = Math.ceil(b.getWest() / step) * step; lon <= b.getEast(); lon += step) {
      group.addLayer(L.polyline([[b.getSouth(), lon], [b.getNorth(), lon]], style));
      group.addLayer(label(`${lon.toFixed(digits)}°E`, [b.getNorth(), lon], 'is-lon'));
    }
    for (let lat = Math.ceil(b.getSouth() / step) * step; lat <= b.getNorth(); lat += step) {
      group.addLayer(L.polyline([[lat, b.getWest()], [lat, b.getEast()]], style));
      const ns = lat < 0 ? 'S' : 'N';
      group.addLayer(label(`${Math.abs(lat).toFixed(digits)}°${ns}`, [lat, b.getWest()], 'is-lat'));
    }
  }

  map.on('moveend zoomend resize', () => { if (map.hasLayer(group)) draw(); });
  group.on('add', draw);
  return group;
}

// Overview map (bottom-right): a global base layer around Gale crater, with the main
// view drawn on it. Clicking it pans the main map there. Hidden on narrow screens (base.css).
const MINIMAP_ZOOM = 5; // whole Gale crater (~150 km) fits in the box

function miniMap(map, layers) {
  const global = layers.find((l) => l.type === 'base' && l.bounds
    && l.bounds.east - l.bounds.west >= 359);
  if (!global) return null;

  const ctl = L.control({ position: 'bottomright' });
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
  L.tileLayer(global.url, { maxNativeZoom: global.maxNativeZoom, maxZoom: MAX_ZOOM, noWrap: true }).addTo(mini);
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
  node.append(...children);
  return node;
}

function legendEl(legend) {
  if (!legend?.length) return '';
  return el('ul', { class: 'layer-legend' },
    ...legend.map((item) => {
      const swatch = el('span', { class: 'swatch' });
      swatch.style.background = item.color;
      return el('li', {}, swatch, item.label);
    }));
}

function buildPanel(panel, map, bases, overlays) {
  // overlays: [{meta, layer, on}] — layers with on=true start switched on
  panel.replaceChildren();

  if (bases.length) {
    panel.append(el('h2', { class: 'panel-title' }, 'Base map'));
    const list = el('div', { class: 'layer-list', role: 'radiogroup', 'aria-label': 'Base map' });
    bases.forEach(({ meta, layer }, i) => {
      const input = el('input', { type: 'radio', name: 'base', value: meta.id });
      input.checked = i === 0;
      input.addEventListener('change', () => {
        bases.forEach((b) => map.removeLayer(b.layer));
        layer.addTo(map).bringToBack();
      });
      list.append(el('label', { class: 'layer-row' }, input, el('span', {}, meta.name)));
    });
    panel.append(list);
  }

  if (overlays.length) {
    panel.append(el('h2', { class: 'panel-title' }, 'Layers'));
    const list = el('div', { class: 'layer-list' });
    for (const { meta, layer, on } of overlays) {
      const box = el('input', { type: 'checkbox', value: meta.id });
      box.checked = Boolean(on);
      const opacity = el('input', {
        type: 'range', min: '0', max: '1', step: '0.05', value: String(layer.options.opacity ?? 1),
        'aria-label': `${meta.name} opacity`, class: 'layer-opacity',
      });
      opacity.disabled = !box.checked;
      box.addEventListener('change', () => {
        if (box.checked) layer.addTo(map); else map.removeLayer(layer);
        opacity.disabled = !box.checked;
      });
      opacity.addEventListener('input', () => setLayerOpacity(layer, Number(opacity.value)));
      list.append(el('div', { class: 'layer-item' },
        el('label', { class: 'layer-row' }, box, el('span', {}, meta.name)),
        opacity,
        legendEl(meta.legend)));
    }
    panel.append(list);
  }
}

export function initMap(state, mapEl) {
  const map = L.map(mapEl, {
    crs: MARS_CRS,
    minZoom: 3,
    maxZoom: MAX_ZOOM,
    zoomSnap: 0.5,
    attributionControl: true,
  });
  map.attributionControl.setPrefix(false);
  L.control.scale({ imperial: false }).addTo(map);
  coordsControl(map);

  // Base layers and tile overlays (layers.json)
  const layers = state.layers || [];
  const bases = layers.filter((l) => l.type === 'base').map((meta) => ({ meta, layer: tileLayer(meta) }));
  const overlays = layers.filter((l) => l.type === 'overlay').map((meta) => ({ meta, layer: tileLayer(meta) }));
  bases[0]?.layer.addTo(map);
  overlays.forEach((o) => o.layer.setOpacity(0.6));

  // PNG overlays (overlays.json + safety.json), same schema
  for (const ov of [...(state.overlays || []), ...(state.safety?.overlays || [])]) {
    if (ov?.png && ov?.bounds) overlays.push({ meta: ov, layer: imageLayer(ov) });
  }

  // Curiosity's actual traverse
  const extent = L.latLngBounds([]);
  if (state.traverse) {
    const traverse = L.geoJSON(state.traverse, {
      coordsToLatLng,
      style: { color: cssVar('--color-info'), weight: 2, opacity: 0.9, dashArray: '4 4' },
      interactive: false,
    }).addTo(map);
    extent.extend(traverse.getBounds());
    overlays.push({ meta: { id: 'traverse', name: 'Curiosity traverse' }, layer: traverse, on: true });
  }

  // Planned Marswalk route (Demir)
  if (state.route) {
    const route = L.geoJSON(state.route, {
      coordsToLatLng,
      style: { color: cssVar('--color-accent'), weight: 4, opacity: 0.95 },
    }).addTo(map);
    extent.extend(route.getBounds());
  }

  // Habitat
  if (Array.isArray(state.area?.habitat)) {
    L.circleMarker(toLatLng(state.area.habitat), {
      radius: 7, color: cssVar('--color-text'), weight: 2,
      fillColor: cssVar('--color-accent'), fillOpacity: 1,
    }).bindTooltip('Habitat').addTo(map);
  }

  // Stops: click dispatches 'stop:select'
  if (Array.isArray(state.stops)) {
    const sand = cssVar('--color-sand');
    const accent = cssVar('--color-accent');
    const markers = [];
    state.stops.forEach((stop, i) => {
      if (!Array.isArray(stop.coord)) return;
      const m = L.circleMarker(toLatLng(stop.coord), {
        radius: 6, color: cssVar('--color-bg'), weight: 2, fillColor: sand, fillOpacity: 1,
      }).bindTooltip(`${i + 1}. ${stop.name ?? stop.id}`).addTo(map);
      m.on('click', () => {
        markers.forEach((x) => x.setStyle({ fillColor: sand, radius: 6 }));
        m.setStyle({ fillColor: accent, radius: 8 });
        document.dispatchEvent(new CustomEvent('stop:select', { detail: stop }));
      });
      markers.push(m);
      extent.extend(m.getLatLng());
    });
  }

  const bounds = initialBounds(state, extent);
  if (bounds) map.fitBounds(bounds, { padding: [16, 16] });
  else map.setView([0, 0], 3);

  // Overview map (needs the main view set first)
  try {
    miniMap(map, layers);
  } catch (err) {
    console.warn('[map] overview map failed', err);
  }

  // Lat/lon grid, switchable from the layer panel
  const grid = gridLayer(map);
  overlays.push({ meta: { id: 'grid', name: 'Lat/lon grid' }, layer: grid, on: true });
  grid.addTo(map);

  const panel = document.getElementById('panel');
  if (panel) buildPanel(panel, map, bases, overlays);

  // Astronaut position from the HUD simulation clock ('hud:time').
  // detail: {active, playing, utc, elapsed_min, coord: [lon, lat] | null, d_m | null}
  const astronaut = L.circleMarker([0, 0], {
    radius: 7, color: cssVar('--color-bg'), weight: 2,
    fillColor: cssVar('--color-hud'), fillOpacity: 1, interactive: false,
  });
  document.addEventListener('hud:time', (e) => {
    const { active, coord, elapsed_min: elapsed } = e.detail || {};
    if (!active || !Array.isArray(coord)) {
      astronaut.remove();
      return;
    }
    astronaut.setLatLng(toLatLng(coord));
    if (!map.hasLayer(astronaut)) astronaut.addTo(map);
    const label = Number.isFinite(elapsed) ? `Astronaut · T+${Math.round(elapsed)} min` : 'Astronaut';
    astronaut.bindTooltip(label, { direction: 'top', offset: [0, -8] });
  });

  // Re-measure the map when HUD mode changes the layout
  new MutationObserver(() => map.invalidateSize())
    .observe(document.body, { attributes: true, attributeFilter: ['data-mode'] });

  return map;
}
