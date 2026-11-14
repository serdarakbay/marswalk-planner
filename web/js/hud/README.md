# HUD mode (Serdar)

The astronaut's helmet-visor view. Opens with **H** or the HUD button in `planner.html`.

## What it shows

- **Top bar:** local Mars time (LMST, Mars24), UTC, EVA window and time left, `REPLAY` label during the storm scenario.
- **Life support:** O2 remaining and at return (est.), dose so far, planned dose (or the no-shelter dose during a storm), solar event multiplier, nearest shelter, delay.
- **Next stop:** name, distance, ETA or time left at the stop, slope here, science note.
- **Sun / Earth link:** Sun elevation and azimuth, Earth elevation, direct line of sight, radio to habitat, one-way and round-trip light time.
- **Alerts:** rules from `web/data/alerts.json` (Utku) plus built-in ones (Earth below the horizon, outside the EVA window, scenario alerts).
- **Radio shadow ahead:** from `safety.json` → `route[].comm_ok`, the HUD warns 10 min before a stretch without a link ("Radio shadow in 4 min, for 3 min: check in now") and counts down while in it.
- **Point of no return:** "Turn back by T+…" = O2 above the 25 % reserve minus the O2 to walk home from here (straight line × 1.3, 50 m/min). Warns under 30 min, "Turn back now" at zero.
- **Shelter options (storm):** every refuge (terrain shelters and the habitat) ranked by the storm dose still to come if the astronaut goes there now: walk time at the full storm rate, then the wait at the shelter's sky-view factor (habitat: `habitat_dose_factor`). The lowest dose the O2 allows is marked **best** and chosen by default; tap another one to change course. Shelters where waiting would take O2 below the reserve are greyed out.
- **Path to the refuge:** the walk to the refuge (and back to the route after the storm) follows a path around steep ground, like a turn-by-turn route: Dijkstra on Demir's heightmap (`summary.json` → `terrain`, 256 × 256 cells of ~9 m), never steeper than 25° (`slope_max_deg`), with a cost that grows with the square of the slope (×2 at 15°). Distances, walk times and doses in the options use this path. On the real data every refuge is reachable from every point of the route, with detours up to ~30 % longer than the straight line. Without the heightmap the astronaut walks straight lines. The remaining path is sent to the map in `hud:time` (`refuge_path`).
- **Mission log:** the latest key events up to the current time, newest first (EVA start, stops, radio shadows of a minute or more, storm, shelter, dust devil, return). Built from the simulated plan, so it follows the time slider.
- **Simulation clock:** play / pause, speed (real time to x1200), time slider with coloured event bands.

## URL parameters

| Parameter | Effect |
|---|---|
| `?radiation=replay` | Storm scenario on; the storm hits 40 min into the walk |
| `?hazard=dustdevil` | Dust devil scenario on; it appears 20 min into the walk |
| `?hud=plain` | Plain look instead of the default visor look |

They can be combined, e.g. `planner.html?hazard=dustdevil&radiation=replay`.

## Scenarios (`scenario.js`)

The walk is simulated in 15-second steps. Each step records the astronaut's mode, position, progress along the planned route, O2 and dose. With no scenario on, the astronaut simply follows the route.

- **Solar storm:** replay of the 20 May 2024 storm measured by Curiosity RAD (`radiation.json` → `replay`: x38.6, 120 min). The astronaut walks to the recommended refuge (lowest storm dose, see Shelter options) or the one the crew picks, waits until the storm ends, walks back and resumes the route (or stays in the habitat: the EVA ends early). Dose in a shelter is multiplied by its sky-view factor (`svf`), in the habitat by `replay.habitat_dose_factor`. If waiting at a shelter would take O2 below the 25 % reserve, the astronaut returns to the habitat instead. With Utku's current values (shelter sky-view 0.70–0.81, habitat ×0.3) the habitat usually gives the lowest dose even 25–30 min away; picking a nearby shelter keeps the EVA going at a higher dose.
- **Dust devil:** appears upwind (NE) and moves at 3 m/s. A shelter does not help here (Martian wind is weak, about 1 % of Earth's air density; the risks are dust on the visor and seals, static charge and lost visibility), so the astronaut keeps out of its way instead:
  - If its track passes closer than 120 m, the astronaut **steps aside**: walks perpendicular to the track, on walkable ground (same path finder as the storm, at most 400 m), until 150 m off it, waits there until it is 160 m away and moving off, then walks back to the route.
  - Otherwise, or when there is no walkable spot aside, the astronaut **holds position** while it approaches within 120 m and resumes once it is 160 m away and moving off.
  - The delay carries over to stop times, O2 and dose. On the real route the astronaut never gets closer than ~130 m.

Demo assumptions (walking speed 50 m/min, dust devil speed, size and distances) are constants at the top of `scenario.js`.

## Files

| File | Role |
|---|---|
| `index.js` | `initHUD(state, el)`: panels, alerts, controls, `hud:time` events |
| `model.js` | Pure helpers: Sun interpolation, EVA status, route timing, stops, O2, dose, radiation, alerts |
| `scenario.js` | Storm and dust devil simulation |
| `terrain.js` | Heightmap grid, paths to the refuges around steep ground |
| `sim.js` | Simulation clock |
| `dev.html`, `mock-state.js` | Standalone test page with MOCK data |
| `test.mjs` | Self-tests (`node web/js/hud/test.mjs`) |
| `../../css/hud.css` | Styles; every selector starts with `#hud-root` |

## Tests

```
node web/js/hud/test.mjs
```

No dependencies. Part 1 checks the logic on small made-up inputs (stop order, storm and dust devil plans, shelter options, paths around a wall, O2 and dose, radio shadows, radiation, alerts, missing data). Part 2 checks the real files in `web/data/` (sun.json, EVA window, stop order on the real route, O2 against summary.json, safety.json); a missing file is skipped. Exits with code 1 if anything fails.

## Events

- Listens to `hud:toggle`, the **H** key and `stop:select`.
- Emits `hud:time` with `{active, playing, utc, elapsed_min, coord, d_m, storm, shelter, hazard, mode, refuge_path, refuge_label}` (see `CLAUDE.md`). `refuge_path` is the `[[lon, lat], ...]` still to walk to the refuge, aside from a dust devil, or back to the route; `refuge_label` names it ("Shelter S4", "Habitat", "Step aside", "Back to the route").
