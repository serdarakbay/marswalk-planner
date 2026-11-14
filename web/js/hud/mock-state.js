// MOCK state for dev.html only. Not loaded by the real app (main.js).
// Shapes follow the contracts in CLAUDE.md; values are placeholders until
// teammates push their files (area/stops/radiation/alerts: Utku, route/summary: Demir).
export const MOCK_STATE = {
  area: {
    bbox: { west: 137.36, south: -4.77, east: 137.40, north: -4.73 },
    habitat: [137.372, -4.758], // MOCK
    crs: '+proj=longlat +R=3396190 +no_defs',
  },
  stops: [
    { id: 's1', name: 'Boxwork Ridge (MOCK)', coord: [137.381, -4.749],
      science: 'MOCK note: raised ridges of cemented fractures, a record of groundwater moving through the bedrock.', photos: [] },
    { id: 's2', name: 'Sulfate Bench (MOCK)', coord: [137.389, -4.742],
      science: 'MOCK note: layered sulfate-bearing unit; look for colour changes between beds.', photos: [] },
    { id: 's3', name: 'Overlook (MOCK)', coord: [137.395, -4.736],
      science: 'MOCK note: view down Gale crater toward the rim.', photos: [] },
  ],
  // MOCK route (Demir's route.geojson shape): habitat -> s1 -> s2 -> s3 -> habitat.
  // Repeated vertices = time spent at a stop. t_min = minutes after EVA start.
  route: {
    type: 'Feature',
    properties: {
      slope_deg: [0, 6, 6, 9, 9, 12, 12, 7, 0],
      t_min: [0, 45, 85, 120, 160, 195, 235, 270, 300],
    },
    geometry: {
      type: 'LineString',
      coordinates: [
        [137.372, -4.758], [137.381, -4.749], [137.381, -4.749], [137.389, -4.742], [137.389, -4.742],
        [137.395, -4.736], [137.395, -4.736], [137.384, -4.748], [137.372, -4.758],
      ],
    },
  },
  summary: {
    distance_m: 4600, duration_min: 300, o2_used_pct: 46, dose_mSv: null, max_slope_deg: 12, profile: [],
  },
  radiation: { base_mSv_per_day: 0.64, event_multiplier: 1, status: 'nominal', message: 'Quiet Sun' },
  alerts: {
    rules: [
      { id: 'o2-low', metric: 'o2_remaining_pct', op: '<', value: 60, level: 'warn', text: 'O₂ below 60%: keep to the plan' },
      { id: 'eva-ending', metric: 'eva_remaining_min', op: '<', value: 30, level: 'warn', text: 'EVA window closes in under 30 min' },
      { id: 'earth-low', metric: 'earth_el', op: '<', value: 10, level: 'info', text: 'Earth low on horizon: link may degrade' },
    ],
  },
};
