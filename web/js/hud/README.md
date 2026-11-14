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

- **Solar storm:** replay of the 20 May 2024 storm measured by Curiosity RAD (`radiation.json` → `replay`: x38.6, 120 min). The astronaut walks to the nearest refuge (terrain shelter from `safety.json`, or the habitat), waits until the storm ends, walks back and resumes the route. Dose in a shelter is multiplied by its sky-view factor (`svf`), in the habitat by `replay.habitat_dose_factor`. If waiting at a shelter would take O2 below the 25 % reserve, the astronaut returns to the habitat instead.
- **Dust devil:** appears upwind (NE) and crosses the route at 3 m/s. The HUD warns within 400 m; the astronaut holds position while it approaches within 120 m and resumes once it is 160 m away and moving off. The delay carries over to stop times, O2 and dose.

Demo assumptions (walking speed 50 m/min, dust devil speed, size and distances) are constants at the top of `scenario.js`.

## Files

| File | Role |
|---|---|
| `index.js` | `initHUD(state, el)`: panels, alerts, controls, `hud:time` events |
| `model.js` | Pure helpers: Sun interpolation, EVA status, route timing, stops, O2, dose, radiation, alerts |
| `scenario.js` | Storm and dust devil simulation |
| `sim.js` | Simulation clock |
| `dev.html`, `mock-state.js` | Standalone test page with MOCK data |
| `test.mjs` | Self-tests (`node web/js/hud/test.mjs`) |
| `../../css/hud.css` | Styles; every selector starts with `#hud-root` |

## Tests

```
node web/js/hud/test.mjs
```

No dependencies. Part 1 checks the logic on small made-up inputs (stop order, storm and dust devil plans, O2 and dose, radio shadows, radiation, alerts, missing data). Part 2 checks the real files in `web/data/` (sun.json, EVA window, stop order on the real route, O2 against summary.json, safety.json); a missing file is skipped. Exits with code 1 if anything fails.

## Events

- Listens to `hud:toggle`, the **H** key and `stop:select`.
- Emits `hud:time` with `{active, playing, utc, elapsed_min, coord, d_m, storm, shelter, hazard, mode}` (see `CLAUDE.md`).
