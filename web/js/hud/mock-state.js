// MOCK state for dev.html only. Not loaded by the real app (main.js).
// Shapes follow the contracts in CLAUDE.md; values are placeholders until
// teammates push their files (area/stops/radiation/alerts: Utku, summary: Demir).
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
  summary: {
    distance_m: 2600, duration_min: 300, o2_used_pct: 46, dose_mSv: null, max_slope_deg: 12, profile: [],
  },
  radiation: { base_mSv_per_day: 0.64, event_multiplier: 1, status: 'nominal', message: 'Quiet Sun' },
  alerts: {
    rules: [
      { id: 'o2-high', metric: 'o2_used_pct', op: '>', value: 70, level: 'warn', text: 'O₂ use above 70% of supply' },
      { id: 'earth-low', metric: 'earth_el', op: '<', value: 10, level: 'info', text: 'Earth low on horizon: link may degrade' },
    ],
  },
};
