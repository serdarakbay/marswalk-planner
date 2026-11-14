// geo.js (Ege): coordinate conversions. JSON points are [lon, lat], Leaflet expects [lat, lon];
// the conversion happens only here.

/* global L */

// Mars Trek EQ tiles use the EPSG4326 scheme. We keep that projection but swap in the
// Mars radius so the scale bar and distances are correct.
export const MARS_RADIUS_M = 3396190;
export const MARS_CRS = L.extend({}, L.CRS.EPSG4326, { R: MARS_RADIUS_M });

// [lon, lat] -> [lat, lon]
export function toLatLng(coord) {
  return [coord[1], coord[0]];
}

// {west, south, east, north} -> Leaflet LatLngBounds
export function toBounds(bbox) {
  return L.latLngBounds([bbox.south, bbox.west], [bbox.north, bbox.east]);
}

// For L.geoJSON: GeoJSON [lon, lat(, z)] -> L.LatLng
export function coordsToLatLng(coord) {
  return L.latLng(toLatLng(coord));
}
