# Data contracts

The full schema of every file under `web/data/`. Owner: Utku. If you need a schema change, tell Utku first; do not change the schema of your own file on your own, because others read it.

## General rules

- Points are always **`[lon, lat]`** (east positive, planetocentric). A bbox is always `{west, south, east, north}`.
- The unit is written in the field name: `_m`, `_min`, `_deg`, `_mSv`, `_pct`, `_c`. Older fields listed without a unit in the table (`sun_az`, `sun_el`, `earth_el`) are in degrees, and their names do not change.
- Times: UTC as `"2026-11-15T12:46:05Z"` (ISO 8601, with `Z`), Mars local time as `"HH:MM"` (LMST).
- **Extra fields are allowed**; the reader ignores any field it does not know. The fields written in this file, however, are required; if a value is unknown, write `null`, do not remove the field.
- Mock files are written with **the same name and the same schema** as the real data. To make it clear that a file is a mock, `"source": "MOCK"` at the object root is recommended.
- The frontend assumes that any file can be missing or broken (`state.x === null`).

`state` keys and file paths in `main.js`:

| `state` key | File | Owner |
|---|---|---|
| `area` | `web/data/area.json` | Utku |
| `layers` | `web/data/layers.json` | Utku |
| `overlays` | `web/data/overlays.json` | Demir |
| `route` | `web/data/route.geojson` | Demir |
| `summary` | `web/data/summary.json` | Demir |
| `safety` | `web/data/safety/safety.json` | Utku |
| `stops` | `web/data/stops.json` | Utku |
| `geology` | `web/data/geology.geojson` | Serdar |
| `images` | `web/data/images.json` | Egemen |
| `traverse` | `web/data/traverse.geojson` | Egemen |
| `weather` | `web/data/weather.json` | Egemen |
| `sun` | `web/data/sun.json` | Serdar |
| `eva` | `web/data/eva_window.json` | Serdar |
| `donki` | `web/data/donki.json` | Utku |
| `radiation` | `web/data/radiation.json` | Utku |
| `alerts` | `web/data/alerts.json` | Utku |

`config/mission.json` (Utku) is not loaded by the frontend; it is the shared input of the Python scripts. Its schema is at the bottom.

---

## area.json (Utku)

```json
{
  "bbox": {"west": 137.36, "south": -4.77, "east": 137.40, "north": -4.73},
  "habitat": [137.385, -4.755],
  "crs": "+proj=longlat +R=3396190 +no_defs"
}
```

- `habitat` must be **inside** the bbox. The coordinate above is only an example; Utku decides the real one.

## layers.json (Utku)

Base map layers (Mars Trek WMTS).

```json
[
  {
    "id": "ctx",
    "name": "CTX mosaic",
    "type": "base",
    "url": "https://trek.nasa.gov/tiles/Mars/EQ/<Layer>/1.0.0/default/default028mm/{z}/{y}/{x}.jpg",
    "fallbackUrl": "tiles/ctx/{z}/{y}/{x}.jpg",
    "format": "jpg",
    "maxNativeZoom": 17,
    "attribution": "NASA/JPL-Caltech/MSSS, Mars Trek"
  }
]
```

- `type`: `"base"` (only one is selected) or `"overlay"` (several can be stacked).
- `format`: `"jpg"` or `"png"`. If there is no `fallbackUrl`, it is `null`.

## overlays.json (Demir)

Pre-rendered PNG layers (slope, cost, ...).

```json
[
  {
    "id": "slope",
    "name": "Slope",
    "png": "data/overlays/slope.png",
    "bounds": {"west": 137.36, "south": -4.77, "east": 137.40, "north": -4.73},
    "legend": [
      {"color": "#4fb37a", "label": "< 15°"},
      {"color": "#e8b43a", "label": "15–25°"},
      {"color": "#e5484d", "label": "> 25°"}
    ]
  }
]
```

- The `png` path is relative to `web/`. `bounds` must be **exactly** the same as the bounds the PNG was warped to.
- `legend` can be empty (`[]`).

## route.geojson (Demir)

```json
{
  "type": "Feature",
  "geometry": {"type": "LineString", "coordinates": [[137.385, -4.755], [137.386, -4.754]]},
  "properties": {
    "slope_deg": [0, 4.2],
    "t_min": [0, 1.8]
  }
}
```

- `slope_deg[i]` and `t_min[i]` belong to coordinate `i`; each array has the same length as the number of coordinates.
- `t_min` is the cumulative time from the start.

## summary.json (Demir)

```json
{
  "distance_m": 2140,
  "duration_min": 185,
  "o2_used_pct": 41.5,
  "dose_mSv": 0.08,
  "max_slope_deg": 18.3,
  "profile": [{"d": 0, "z": -4512.0, "slope": 0}, {"d": 25, "z": -4510.4, "slope": 3.7}]
}
```

- `profile`: `d` in metres (distance from the start), `z` in metres (elevation relative to the Mars areoid), `slope` in degrees.

## safety/safety.json (Utku)

```json
{
  "overlays": [
    {"id": "comm_shadow", "name": "Radio shadow", "png": "data/safety/comm_shadow.png",
     "bounds": {"west": 137.36, "south": -4.77, "east": 137.40, "north": -4.73}, "legend": []}
  ],
  "shelters": [{"coord": [137.381, -4.751], "svf": 0.62}],
  "route": [{"d": 0, "comm_ok": true, "shelter_min": 4.5}],
  "offline_min": 12
}
```

- `overlays[]` has the same schema as `overlays.json`; the layer panel shows both together.
- `svf`: sky-view factor, 0–1. `route[].d` is in metres, on the same axis as `d` in the `summary.json` profile.
- `offline_min`: total time without communication along the route.
- `route[]` has exactly one entry per `summary.json` profile point, with the same `d` values in the same order. `shelter_min` is the walking time to the nearest shelter in minutes (`null` if none can be reached).

## stops.json (Utku)

```json
[
  {
    "id": "s1",
    "name": "Boxwork ridge",
    "coord": [137.383, -4.752],
    "science": "Calcium sulfate veins left by groundwater...",
    "photos": [{"url": "https://mars.nasa.gov/msl-raw-images/...jpg", "sol": 4500, "camera": "MAST_LEFT", "credit": "NASA/JPL-Caltech/MSSS"}]
  }
]
```

- Stops are listed in route order. The `detail` of the `stop:select` event is one of these objects.

## geology.geojson (Serdar)

```json
{
  "type": "FeatureCollection",
  "features": [
    {"type": "Feature",
     "geometry": {"type": "Polygon", "coordinates": [[[137.36, -4.77], [137.37, -4.77], [137.37, -4.76], [137.36, -4.77]]]},
     "properties": {"unit": "Hmm", "name": "Mount Sharp group", "note": "..."}}
  ]
}
```

## images.json (Egemen)

```json
[
  {"url": "https://mars.nasa.gov/msl-raw-images/...jpg", "sol": 4500, "camera": "MAST_LEFT",
   "utc": "2025-04-01T10:22:00Z", "site": 110, "drive": 1240, "credit": "NASA/JPL-Caltech/MSSS"}
]
```

## traverse.geojson (Egemen)

Curiosity's route inside the bbox. It can be a single LineString `Feature` or a `FeatureCollection` of route segments; the reader accepts both.

```json
{
  "type": "FeatureCollection",
  "features": [
    {"type": "Feature",
     "geometry": {"type": "LineString", "coordinates": [[137.383458, -4.730024], [137.384, -4.7305]]},
     "properties": {"sol_start": 2468, "sol_end": 2824, "source": "MSL traverse, NASA/JPL-Caltech (MMGIS)"}}
  ]
}
```

- Each segment is a `LineString`. `sol_start`, `sol_end` and `source` in `properties` are recommended, not required.

## weather.json (Egemen)

```json
{
  "source": "REMS",
  "rows": [{"lmst": "06:00", "temp_c": -78.0}, {"lmst": "14:00", "temp_c": -8.0}]
}
```

- `rows` are sorted by LMST. Serdar's EVA window reads this file (if it is missing, it falls back to its own MOCK curve).

## sun.json (Serdar)

```json
{
  "source": "JPL Horizons (airless apparent az/el) + Mars24 LMST",
  "observer": {"lon": 137.385, "lat": -4.755, "from": "area.json"},
  "step_min": 10,
  "rows": [
    {"utc": "2026-11-15T00:00:00Z", "lmst": "21:48", "sun_az": 278.63, "sun_el": -50.4, "earth_el": -13.87, "light_time_min": 10.95}
  ]
}
```

- `sun_az` is in degrees, clockwise from north; `sun_el` and `earth_el` are in degrees. If Horizons cannot be reached, `earth_el` and `light_time_min` are `null`.
- `observer.from`: `"area.json"` or `"fallback"`.

## eva_window.json (Serdar)

```json
{
  "start_lmst": "10:13",
  "end_lmst": "17:22",
  "reason": "Start limited by temperature -40 C; end limited by Sun elevation 15 deg.",
  "start_utc": "2026-11-15T12:46:05Z",
  "end_utc": "2026-11-15T20:06:20Z",
  "duration_min": 440,
  "temp_source": "MOCK"
}
```

- Required fields: `start_lmst`, `end_lmst`, `reason`. If there is no window, the first two are `null`.

## donki.json (Utku)

```json
{
  "mode": "replay",
  "events": [{"type": "FLR", "start": "2024-05-20T05:00:00Z", "peak": "2024-05-20T05:22:00Z", "mars_impact": true}]
}
```

- `mode`: `"live"` or `"replay"`. Replay is always the 20 May 2024 event.
- `type`: DONKI event type (`FLR`, `CME`, `SEP`, ...).

## radiation.json (Utku)

```json
{
  "base_mSv_per_day": 0.64,
  "event_multiplier": 1.0,
  "status": "nominal",
  "message": "Background GCR only."
}
```

- `status`: `"nominal"`, `"elevated"` or `"storm"`.
- `replay` (optional): the 20 May 2024 storm scenario, written next to the live values so the demo can switch to it. The top-level fields above stay the live (or current) values.

  ```json
  "replay": {"status": "storm", "event_multiplier": 38.6, "message": "Replay of the 20 May 2024 solar storm: dose rate x38.6. Stay close to shelter.", "event_dose_mGy": 8.1}
  ```

  `event_dose_mGy` is absorbed dose (Gy) and is never added to mSv values.

## alerts.json (Utku)

```json
{
  "rules": [
    {"id": "o2_low", "metric": "o2_remaining_pct", "op": "<", "value": 25, "level": "danger", "text": "O2 reserve reached. Return to habitat."}
  ]
}
```

- `op`: `<`, `<=`, `>`, `>=`, `==`. `level`: `info`, `warn` or `danger` (the colours are `--color-info`, `--color-warn` and `--color-danger` in `base.css`).
- `metric` names are the values the HUD computes: `o2_remaining_pct`, `dose_mSv`, `slope_deg`, `comm_ok`, `shelter_min`.

---

## config/mission.json (Utku)

All thresholds and constants. Python scripts read them from here, so there are no magic numbers in the code.

```json
{
  "gravity_m_s2": 3.71,
  "slope_warn_deg": 15,
  "slope_max_deg": 25,
  "eva_nominal_hours": 8,
  "eva_min_sun_el_deg": 15,
  "eva_min_temp_c": -40,
  "o2_reserve_pct": 25,
  "rad_base_mSv_per_day": 0.64,
  "dem_resolution_m": 1,
  "dem_max_downsample_m": 2,
  "body_mass_kg": 75,
  "suit_load_kg": 90,
  "terrain_factor": 1.2,
  "o2_kj_per_l": 20.1,
  "suit_speed_factor": 0.6,
  "stop_dwell_min": 15,
  "rad_base_mGy_per_day": 0.21,
  "replay_event_dose_mGy": 8.1,
  "rad_event_window_h": 48,
  "comm_antenna_height_m": 6,
  "comm_suit_antenna_height_m": 2,
  "shelter_search_radius_m": 200,
  "shelter_count": 5,
  "shelter_min_spacing_m": 150,
  "svf_directions": 16,
  "svf_radius_m": 100,
  "svf_grid_m": 5
}
```

- `eva_min_sun_el_deg` and `eva_min_temp_c` are needed for Serdar's EVA window.
- Walking and O2 model (`science/models.py`); sources and assumptions are in `docs/story/assumptions.md`:
  - `body_mass_kg`: astronaut body mass, kg.
  - `suit_load_kg`: suit, life-support backpack and tools, kg.
  - `terrain_factor`: Pandolf terrain coefficient η, no unit (1.0 = hard flat surface).
  - `o2_kj_per_l`: energy released per litre of O2 consumed, kJ/L.
  - `suit_speed_factor`: suited walking speed as a fraction of Tobler's hiking speed, no unit.
  - `stop_dwell_min`: time spent at each science stop, minutes.
- Radiation (`science/radiation.py`). Gy values are absorbed dose and are never added to Sv values:
  - `rad_base_mGy_per_day`: mean surface absorbed dose rate measured by RAD, mGy/day.
  - `replay_event_dose_mGy`: absorbed dose RAD measured during the 20 May 2024 replay event, mGy.
  - `rad_event_window_h`: in live mode, a WSA-ENLIL Mars arrival within this many hours of now sets `status` to `elevated`, hours.
- Radio link and shelters (`science/safety/build.py`):
  - `comm_antenna_height_m`: habitat antenna height above the ground, m.
  - `comm_suit_antenna_height_m`: suit antenna height above the ground, m.
  - `shelter_search_radius_m`: shelters are searched within this distance of the route, m.
  - `shelter_count`: number of shelters to pick.
  - `shelter_min_spacing_m`: minimum distance between two shelters, m.
  - `svf_directions`: number of directions for the sky-view factor.
  - `svf_radius_m`: how far to search for the horizon in each direction, m.
  - `svf_grid_m`: spacing of the candidate points, m.
