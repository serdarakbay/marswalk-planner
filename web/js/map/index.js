// map/index.js (Ege): Leaflet map, Mars Trek base layers, layer panel,
// Curiosity traverse, planned route and stops. Clicking a stop dispatches 'stop:select'.
//
//   export function initMap(state, el)   // el = #map; the panel is drawn into #panel
//
// Any file in state may be null; missing layers are skipped quietly.

/* global L */
import { MARS_CRS, coordsToLatLng, toBounds, toLatLng } from './geo.js';
import { initProfile } from './profile.js';

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

// Lat/lon grid that picks a round step for the current zoom
const GRID_STEPS = [10, 5, 2, 1, 0.5, 0.2, 0.1, 0.05, 0.02, 0.01, 0.005, 0.002, 0.001, 0.0005];

// Pixel margins kept free of grid labels (see the control positions in initMap)
const GRID_LABEL_MARGIN = { left: 48, right: 64, top: 28, bottom: 76 };

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
    // Skip labels that would sit under a map control or collide in a corner:
    // zoom buttons top-right, cursor coordinates and scale bottom-left.
    const size = map.getSize();
    const px = (latlng) => map.latLngToContainerPoint(latlng);
    for (let lon = Math.ceil(b.getWest() / step) * step; lon <= b.getEast(); lon += step) {
      group.addLayer(L.polyline([[b.getSouth(), lon], [b.getNorth(), lon]], style));
      const { x } = px([b.getNorth(), lon]);
      if (x < GRID_LABEL_MARGIN.left || x > size.x - GRID_LABEL_MARGIN.right) continue;
      group.addLayer(label(`${lon.toFixed(digits)}°E`, [b.getNorth(), lon], 'is-lon'));
    }
    for (let lat = Math.ceil(b.getSouth() / step) * step; lat <= b.getNorth(); lat += step) {
      group.addLayer(L.polyline([[lat, b.getWest()], [lat, b.getEast()]], style));
      const { y } = px([lat, b.getWest()]);
      if (y < GRID_LABEL_MARGIN.top || y > size.y - GRID_LABEL_MARGIN.bottom) continue;
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
const PANEL_GROUPS = ['Imagery', 'Terrain', 'Safety', 'Science', 'Mission'];

function overlayItem(map, { meta, layer, on }) {
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
  return el('div', { class: 'layer-item' },
    el('label', { class: 'layer-row' }, box, el('span', {}, meta.name)), opacity, legend);
}

function buildPanel(panel, map, bases, overlays) {
  // overlays: [{meta, layer, on, group}] — layers with on=true start switched on
  panel.replaceChildren();

  if (bases.length) {
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
    const section = el('details', { class: 'panel-group' }, el('summary', { class: 'panel-title' }, 'Base map'), list);
    section.open = true;
    panel.append(section);
  }

  const groups = [...PANEL_GROUPS, ...new Set(overlays.map((o) => o.group).filter((g) => !PANEL_GROUPS.includes(g)))];
  for (const name of groups) {
    const items = overlays.filter((o) => (o.group || 'Mission') === name);
    if (!items.length) continue;
    const section = el('details', { class: 'panel-group' },
      el('summary', { class: 'panel-title' }, name),
      el('div', { class: 'layer-list' }, ...items.map((o) => overlayItem(map, o))));
    section.open = true;
    panel.append(section);
  }
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
  map.attributionControl.setPrefix(false);
  // Zoom buttons top-right: the top and left edges carry the grid labels
  L.control.zoom({ position: 'topright' }).addTo(map);
  L.control.scale({ imperial: false }).addTo(map);
  coordsControl(map);

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

  // Curiosity's actual traverse
  if (state.traverse) {
    const traverse = L.geoJSON(state.traverse, {
      coordsToLatLng,
      style: { color: cssVar('--color-info'), weight: 2, opacity: 0.9, dashArray: '4 4' },
      interactive: false,
    });
    extent.extend(traverse.getBounds());
    vectors.push(traverse);
    overlays.push({ meta: { id: 'traverse', name: 'Curiosity traverse' }, layer: traverse, on: true, group: 'Mission' });
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

  // Planned Marswalk route (Demir)
  if (state.route) {
    const route = L.geoJSON(state.route, {
      coordsToLatLng,
      style: { color: cssVar('--color-accent'), weight: 4, opacity: 0.95 },
    });
    extent.extend(route.getBounds());
    vectors.push(route);
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
    vectors.push(...markers);
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
  overlays.push({ meta: { id: 'grid', name: 'Lat/lon grid' }, layer: grid, on: true, group: 'Mission' });
  grid.addTo(map);

  const panel = document.getElementById('panel');
  if (panel) buildPanel(panel, map, bases, overlays);

  // Astronaut position from the HUD simulation clock ('hud:time').
  // detail: {active, playing, utc, elapsed_min, coord: [lon, lat] | null, d_m | null,
  //          storm, shelter: [lon, lat] | null}
  const astronaut = L.circleMarker([0, 0], {
    radius: 7, color: cssVar('--color-bg'), weight: 2,
    fillColor: cssVar('--color-hud'), fillOpacity: 1, interactive: false,
  });
  // Storm replay: pulsing ring on the nearest shelter and a line from the astronaut to it
  const danger = cssVar('--color-danger');
  const shelterRing = L.circleMarker([0, 0], {
    radius: 14, color: danger, weight: 3, fill: false, interactive: false, className: 'shelter-alert',
  }).bindTooltip('Nearest shelter', { permanent: true, direction: 'right', offset: [14, 0], className: 'shelter-alert-label' });
  const shelterLine = L.polyline([], { color: danger, weight: 2, dashArray: '6 6', interactive: false });
  let stormShown = false;

  document.addEventListener('hud:time', (e) => {
    const { active, coord, elapsed_min: elapsed, storm, shelter } = e.detail || {};
    const showStorm = Boolean(active && storm && Array.isArray(coord) && Array.isArray(shelter));
    if (showStorm) {
      shelterRing.setLatLng(toLatLng(shelter));
      shelterLine.setLatLngs([toLatLng(coord), toLatLng(shelter)]);
      if (!map.hasLayer(shelterLine)) shelterLine.addTo(map);
      if (!map.hasLayer(shelterRing)) shelterRing.addTo(map);
      // When the storm starts, zoom to the astronaut and the shelter once
      if (!stormShown) map.flyToBounds(shelterLine.getBounds(), { padding: [80, 80], maxZoom: 17, duration: 1 });
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
    const label = Number.isFinite(elapsed) ? `Astronaut · T+${Math.round(elapsed)} min` : 'Astronaut';
    astronaut.bindTooltip(label, { direction: 'top', offset: [0, -8] });
  });

  // Elevation profile under the map; hovering it marks the same spot on the route
  const along = routeSampler(map, state.route);
  const total = state.summary?.profile?.at(-1)?.d;
  const hover = L.circleMarker([0, 0], {
    radius: 6, color: cssVar('--color-text'), weight: 2,
    fillColor: cssVar('--color-accent'), fillOpacity: 1, interactive: false,
  });
  const profileEl = document.getElementById('profile');
  if (profileEl) {
    try {
      initProfile(state, profileEl, {
        onHover: (d) => {
          const ll = along && Number.isFinite(d) && total ? along(d / total) : null;
          if (!ll) { hover.remove(); return; }
          hover.setLatLng(ll);
          if (!map.hasLayer(hover)) hover.addTo(map);
        },
      });
    } catch (err) {
      console.warn('[profile] failed to start', err);
    }
  }

  // Re-measure the map when HUD mode changes the layout
  new MutationObserver(() => map.invalidateSize())
    .observe(document.body, { attributes: true, attributeFilter: ['data-mode'] });

  return map;
}
