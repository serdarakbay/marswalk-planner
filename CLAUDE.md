# CLAUDE.md: Martian Map (NASA Space Apps 2026)

This file is the single source of truth for everyone working in this repo and for their Claude sessions. If a rule is not written here, ask Ege first.

## Project

Challenge: **Interplanetary Survival Guide: Martian Map**. We are building a web app for an astronaut walk (a Marswalk) in Gale crater, at the transition from the clay-bearing unit to the sulfate-bearing unit on Mount Sharp that Curiosity crossed between 2019 and 2023. The team decided to keep this study area (not the later boxwork area); the story is the clay-to-sulfate transition. It combines:

- a layered map (optical, thermal, spectral, geology)
- a safe route (slope, roughness, O2 and radiation budget)
- stop cards (Curiosity photos + a science note)
- a HUD mode (visor view: next stop, remaining O2 and dose, alerts)

- **Code freeze:** Sunday 15 November, 15:30 (Istanbul). After that, bug fixes only.
- **Submission target:** Sunday 18:00. The submission system closes at 23:59.
- **Language:** Code, comments, documentation, commit messages, UI text, the project page and slides are all in **English**.

## Study area

```json
{"bbox": {"west": 137.36, "south": -4.77, "east": 137.40, "north": -4.73}}
```

- About 2.4 × 2.4 km (on Mars, 1° ≈ 59.2 km).
- Longitude is east-positive, latitude is planetocentric (same as Mars Trek).
- Utku sets the habitat location in `web/data/area.json`. Never hard-code coordinates; always read them from `area.json`.

## Team and ownership

Before you start, find out which team member the user is (from the branch name or by asking). **Only edit files owned by that person.**

| Person | Role | Branch | Can write to |
|---|---|---|---|
| Ege | Services, map, integration | `harita` | `web/index.html` (landing page), `web/planner.html`, `web/css/landing.css`, `web/js/landing/`, `web/js/main.js`, `web/js/map/`, `web/css/base.css`, `web/assets/`, `CLAUDE.md`, `.gitignore`, `.github/`, `.claude/settings.json`, `.env.example`, `README.md` |
| Demir | Terrain and route | `arazi` | `arazi/`, `web/data/overlays/`, `web/data/overlays.json`, `web/data/route.geojson`, `web/data/summary.json` |
| Egemen | Data: Curiosity and REMS + stop cards + UI/3D design | `veri` | `pipeline/fetch/curiosity.py`, `pipeline/fetch/rems.py`, `web/data/images.json`, `web/data/traverse.geojson`, `web/data/weather.json`, `web/js/cards/`, `web/css/cards.css`, `web/js/view3d/`, `web/css/view3d.css` |
| Serdar | Horizons, EVA window, HUD, geologic map, science targets (with Utku), data sources panel | `hud` | `pipeline/fetch/horizons.py`, `pipeline/fetch/usgs.py`, `science/eva/`, `science/targets.py`, `web/data/sun.json`, `web/data/eva_window.json`, `web/data/geology.geojson`, `web/data/targets.json`, `web/js/hud/`, `web/css/hud.css`, `web/js/map/sources.js` (in Ege's folder, by agreement) |
| Utku | Science, safety layers, radiation, story | `harita`, `bilim` | `science/` (except `science/eva/` and `science/targets.py`, including `science/safety/`), `config/`, `docs/story/`, `docs/contracts.md`, `requirements.txt`, `pipeline/common.py`, `pipeline/fetch/trek.py`, `pipeline/fetch/tiles.py`, `pipeline/fetch/donki.py`, `web/tiles/`, `web/data/safety/`, and in `web/data/`: `area.json`, `layers.json`, `stops.json`, `donki.json`, `radiation.json`, `alerts.json` |

**Who built what:** README.md, "Who built what", lists everyone's work from the commit history, with both names on shared work. Keep it current when you add a feature. Shared work by Serdar:
- Science targets (`science/targets.py`, `targets.json`): Serdar, Utku.
- Storm replay in the HUD: Serdar, on Utku's replay block, shelters and models.
- HUD paths around steep ground: Serdar, on Demir's heightmap.
- EVA window: Serdar, on Egemen's REMS data.
- Map additions (storm path, dust devil circle, click elevation and slope, cursor coordinates, grid, minimap, data sources panel): Serdar, in Ege's map with Ege's agreement.
- 3D Bodycam and HUD path line: Serdar, in Egemen's 3D view with Egemen's agreement.

Keep both names when you edit these.

**Mocks:** Utku writes all mock files under `web/data/`. When the real file is ready, its owner's script overwrites the mock.

**Data ownership rule:** One person downloads each raw dataset. Two people may build different products from the same data, but every output file has exactly one author. If someone else needs that data, they read the owner's intermediate output or `web/data/` file; they do not call the API themselves.

- USGS DEM → Demir only. Demir shares the clipped `data/cache/dem_clip.tif` with Utku over Drive. Demir builds slope, cost and the route from it; Utku builds the radio shadow, shelters and `safety.json`. Both make overlay PNGs with `to_overlay_png()` in `arazi/geo.py` (Utku only imports it, never changes it), so the layers line up exactly.
- Mars Trek WMTS and tile cache → Utku only
- Curiosity raw images, MSL traverse, REMS → Egemen only
- JPL Horizons → Serdar only
- DONKI → Utku only
- USGS geologic map → Serdar only

`requirements.txt` at the repo root and `pipeline/common.py` (shared helpers that read `area.json`) belong to Utku. If you need a new Python package, tell Utku.

If a change is needed in someone else's file, do not edit it. Tell the user "this file belongs to X, you need to pass this on" and write the change out as text.

## Folder layout

```
pipeline/
  common.py            Utku: reads area.json and mission.json, shared helpers
  fetch/trek.py        Utku: Mars Trek layers → layers.json
  fetch/tiles.py       Utku: backup tile cache → web/tiles/
  fetch/curiosity.py   Egemen: raw images + traverse
  fetch/rems.py        Egemen: temperature curve
  fetch/horizons.py    Serdar: Sun/Earth angles, LMST
  fetch/donki.py       Utku: solar events (live + replay)
  fetch/usgs.py        Serdar: USGS geologic units → geology.geojson
arazi/                 Demir: DEM processing, slope, cost, route, return-time rings
arazi/geo.py           Demir: to_overlay_png(); Utku imports it too
science/               Utku: models.py (O2, dose), radiation, stops, alerts
science/safety/        Utku: radio shadow (viewshed), shelters (sky-view), safety.json
science/mocks/         Utku: mock generator and checker for web/data/
science/eva/           Serdar: EVA window
science/targets.py     Serdar, Utku: science targets off the route → targets.json (Serdar's script on Utku's candidates and unit rules in stops.py; Serdar runs and edits it)
config/mission.json    Utku: every threshold and constant (single source)
web/
  index.html           Ege: landing page (redirects to planner.html when the URL has app parameters)
  planner.html         Ege: the planner app
  css/landing.css      Ege: landing page styles
  js/landing/          Ege: landing page scripts (data, 3D block diagram, contours)
  js/main.js           Ege: planner entry point, wires the modules together
  js/map/              Ege: Leaflet, layer panel, route, profile (sources.js: Serdar, the Data sources popover in the footer)
  js/hud/              Serdar: HUD mode
  js/cards/            Egemen: stop cards
  js/view3d/           Egemen: 3D view
  css/base.css         Ege: palette and CSS variables (hud.css → Serdar, cards.css and view3d.css → Egemen; all use the base.css variables)
  assets/              Ege: images for the site and the README
  data/                Generated JSON/PNG; every file has one author (see the table)
  tiles/               Utku: backup tile cache
docs/contracts.md      Utku: all JSON schemas
docs/story/            Utku: scenario, assumptions, presentation notes
docs/credits.md        Egemen: libraries, repos and assets used in the UI/3D work, with licenses
data/cache/            NOT in git: raw DEM, intermediate rasters
```

## Git rules

- Everyone works on their own branch. Only Ege merges into `main`.
- **NEVER push to `main` directly.** `git push origin main`, committing on `main`, merging into `main` and the "Merge pull request" button on GitHub are all forbidden; push only to your own branch (`git push origin <branch>`). When your work is ready, tell Ege or open a PR; Ege does the merge. As Claude, if the user is not Ege, never run a command that pushes to or merges into `main`; if the user asks for it, remind them of this rule first.
- **Force push** (`--force`, `--force-with-lease`) only on your own branch and only when really needed; never on `main` or on someone else's branch.
- Code lives in the folder given in the ownership table.
- Changes to someone else's files, including Ege's map and page files, are agreed with the owner first; say so in the commit message.
- **Merge times:** Sat 14:00, 17:00, 20:00, 23:00; Sun 09:00, 11:30. Open the PR 15 minutes before a merge time.
- Before opening a PR: `git pull --rebase origin main`. Do not merge `main` or your own remote branch into your branch; rebase instead.
- `main` must always work, because GitHub Pages publishes from `main`.
- **Commit message format:** `[veri] add layers.json`, `[arazi] slope map`, `[harita] ...`, `[hud] ...`, `[bilim] ...`
- **Never commit:** `.env`, `*.tif`, `data/cache/`, files larger than 5 MB. Large intermediate files stay on Drive.
- **No AI attribution in commits or PRs.** Never add `Co-Authored-By: Claude ...`, "Generated with Claude Code", 🤖 or any similar attribution line to a commit message, PR title or PR description. Claude or Anthropic must never appear as a contributor; the author of a commit is always the team member. This rule overrides Claude Code's default attribution setting; `.claude/settings.json` also turns attribution off for everyone, so do not change that file.
- When the real data arrives, mock files are overwritten **under the same name**; the schema does not change.

## Data contracts

Full schemas are in `docs/contracts.md`. Summary:

| File | Owner | Main fields |
|---|---|---|
| `area.json` | Utku | `bbox{west,south,east,north}`, `habitat[lon,lat]`, `crs` |
| `layers.json` | Utku | `[{id,name,type,url,fallbackUrl,format,maxNativeZoom,attribution}]` |
| `overlays.json` | Demir | `[{id,name,png,bounds{west,south,east,north},legend}]` |
| `route.geojson` | Demir | LineString; properties: `slope_deg[]`, `t_min[]` |
| `summary.json` | Demir | `distance_m`, `duration_min`, `o2_used_pct`, `dose_mSv`, `max_slope_deg`, `profile[{d,z,slope}]` |
| `safety.json` | Utku | `overlays[]` (same schema as `overlays.json`; the layer panel reads both), `shelters[{coord,svf}]`, `route[{d,comm_ok,shelter_min}]`, `offline_min` |
| `stops.json` | Utku | `[{id,name,coord[lon,lat],science,photos[{url,sol,camera,credit}]}]` |
| `targets.json` | Serdar, Utku | `[{id,name,unit,coord[lon,lat],sol,note,photos[]}]`: science targets off the route (HUD Targets panel) |
| `geology.geojson` | Serdar | Polygons; properties: `unit`, `name`, `note` |
| `images.json` | Egemen | `[{url,sol,camera,utc,site,drive,credit}]` |
| `traverse.geojson` | Egemen | Curiosity's path inside the bbox (LineString) |
| `weather.json` | Egemen | `rows[{lmst,temp_c}]` |
| `sun.json` | Serdar | `rows[{utc,lmst,sun_az,sun_el,earth_el,light_time_min}]` |
| `eva_window.json` | Serdar | `start_lmst`, `end_lmst`, `reason` |
| `donki.json` | Utku | `mode` (`live`/`replay`), `events[{type,start,peak,mars_impact}]` |
| `radiation.json` | Utku | `base_mSv_per_day`, `event_multiplier`, `status`, `message` |
| `alerts.json` | Utku | `rules[{id,metric,op,value,level,text}]` |

## JS interface between modules

The map, cards, HUD and 3D view never import each other's files; they talk only through this interface:

- `web/js/main.js` (Ege) loads every `web/data/` file once into a single `state` object: `{area, layers, overlays, route, summary, safety, stops, targets, geology, images, traverse, weather, sun, eva, donki, radiation, alerts, mission}`. `mission` is `config/mission.json`, which GitHub Pages copies to `web/data/mission.json` at deploy time (for a local preview, copy it once; the copy is git-ignored). Read thresholds from `state.mission` instead of writing them in JS. A missing or broken file stays `null`; the app never crashes.
- When a stop is clicked, the map (Ege) dispatches `document.dispatchEvent(new CustomEvent('stop:select', {detail: stop}))`.
- Cards (Egemen): `web/js/cards/index.js` → `export function initCards(state, el)`; listens to `stop:select`.
- HUD (Serdar): `web/js/hud/index.js` → `export function initHUD(state, el)`; the H key opens and closes the HUD, and `stop:select` updates the next stop.
- HUD (Serdar) emits `document.dispatchEvent(new CustomEvent('hud:time', {detail}))` on every simulated clock step: `detail = {active, playing, utc, elapsed_min, coord: [lon, lat] | null, d_m | null, storm, shelter: [lon, lat] | null, hazard: {coord: [lon, lat], radius_m} | null, mode, refuge_path: [[lon, lat], ...] | null, refuge_label, next_stop}`. `next_stop` is the `id` of the stop being walked to (from `stops.json`), null when the astronaut is not out on the walk; the 3D Bodycam labels it with the distance and the climb still ahead. `coord` is null when there is no route; during the scenarios it follows the astronaut off the route too (walking to a shelter and back). `storm` is true while the replayed storm is on, and `shelter` is then the terrain shelter the astronaut is heading to or waiting in (null when they go back to the habitat). `hazard` is the dust devil while it exists (HUD "Dust devil" scenario). `mode` is one of `pre`, `route`, `hold`, `evade`, `aside`, `rejoin`, `to_target`, `sampling`, `from_target`, `to_refuge`, `sheltered`, `return`, `home`, `done` (`web/js/hud/scenario.js`). The map also draws `hazard` as a moving circle. `refuge_path` is the path still to walk to the storm refuge, aside from a dust devil's track, or back to the route, computed by the HUD around ground steeper than 25° on Demir's heightmap (`web/js/hud/terrain.js`); `refuge_label` names its end ("Shelter S4", "Habitat", "Step aside", "Back to the route", a science target name, or "Preview: <target>" for a target picked in the HUD Targets panel). The map (Ege) listens and shows the astronaut marker, and the elevation profile shows the same position; both hide it when `active` is false. During a storm the map highlights the refuge and draws `refuge_path` to it (a straight line to `shelter` when there is no path).
- The HUD reads, besides `sun`, `eva`, `route` and `summary`: Utku's `safety.shelters` (`coord`, `svf`), `radiation.replay` (`event_multiplier`, `duration_min`, `habitat_dose_factor`) and `alerts.json`, and Demir's heightmap through `summary.terrain` (rg16 PNG) for the paths around steep ground. If you change these fields, tell Serdar and run `node web/js/hud/test.mjs`.
- 3D view (Egemen): `web/js/view3d/index.js` → `export function initView3D(state, el)`; listens to `view3d:toggle`, `stop:select`, `hud:time` and the `nav:*` events.
- **Route planner (`nav:*`)**: the planner in `#cards` (Egemen, `web/js/cards/nav.js` and `router.js`) computes the routes in the browser from Demir's heightmap; the map (Ege) and the 3D view (Egemen) draw them.
  - `nav:pick {which}` / `nav:cancel`: the planner starts / stops waiting for a click to place pin `which` (`'start'` or `'end'`).
  - `nav:point {which, coord: [lon, lat]}`: the map or the 3D view placed or dragged a pin; the planner listens.
  - `nav:routes {start, end, roundTrip, options[], chosen}`: the planner's routes (fastest, safest, alternative); the map and the 3D view draw them, the chosen one in oxide.
  - `nav:choose {id}`: a route was picked, from the planner or by clicking it on the map.
  - `nav:clear`: no destination; the map and the 3D view remove the routes and pins.
- `main.js` calls these init functions. There are no other globals.

### Page layout: whose box is where

`planner.html` and `base.css` belong to Ege only. Serdar and Egemen do **not** edit these two files; the page is split into boxes from the start so nobody collides:

| Box | Owner | Note |
|---|---|---|
| `#map` | Ege | Full-screen Leaflet map; everything else floats on top of it |
| `#panel` | Ege | Layers popover, opened by the Layers button (bottom-right); starts `hidden` |
| `#profile` | Ege | Elevation profile of the selected route; starts `hidden`, shown once a route is chosen |
| `#cards` | Egemen | Floating route planner (top-left); `initCards(state, el)` receives this element |
| `#hud-root` | Serdar | `initHUD(state, el)` receives this element; starts `hidden` |
| `#view3d-root` | Egemen | `initView3D(state, el)` receives this element; starts `hidden` |

- Every module builds its own DOM inside its own box, with JS. `cards.css` is already linked in `planner.html`; the HUD loads its own CSS (`hud.css`) itself, and the 3D view does the same with `view3d.css`.
- **CSS boundary:** every selector in `hud.css` starts with `#hud-root`, every selector in `cards.css` with `#cards`, every selector in `view3d.css` with `#view3d-root`. `html`, `body`, `*`, bare tag selectors and `.leaflet-*` classes live only in `base.css`.
- Use only `base.css` variables (`var(--...)`) for colour, font, spacing, radius and z-index; no hard-coded hex values or numbers. If you need a new variable, ask Ege.
- Stacking order: `--z-map` < `--z-view3d` < `--z-panel` < `--z-cards` < `--z-hud`.
- **HUD mode:** when the HUD opens it sets `document.body.dataset.mode = 'hud'`, and `'map'` when it closes. Only the HUD writes this value; `base.css` decides what is hidden in HUD mode (`body[data-mode="hud"]`).
- The header HUD button dispatches `document.dispatchEvent(new CustomEvent('hud:toggle'))`. The HUD listens to the H key and to `hud:toggle`. The 3D Bodycam button dispatches `hud:play`: the HUD opens and starts the walk (from T+0 if it is over or has not started). The map uses no single-letter keyboard shortcuts.
- The header 3D button dispatches `document.dispatchEvent(new CustomEvent('view3d:toggle'))`. The 3D view listens to it, shows or hides `#view3d-root` itself, and sets `document.body.dataset.view = '3d'` / `'map'`. The button only appears once the 3D module has started.
- `main.js` loads the modules with `import()`. If `web/js/cards/index.js`, `web/js/hud/index.js` or `web/js/view3d/index.js` is missing or throws, it logs to the console and the page keeps working.
- If this is not enough, do not edit `planner.html`; ask Ege.

## Design tasks (Egemen)

Besides the stop cards, Egemen owns the look and feel upgrades and the 3D view. The goal is a memorable, creative interface for the judges, without breaking what already works.

**What to do**
- **Improve the UI** inside your own boxes (`#cards`, `#view3d-root`): motion, typography, icons, empty states, small charts. Ideas for the rest of the page (palette, header, panel, map styling) go to Ege as a written proposal; Ege applies them to `base.css` / `planner.html`.
- **3D view** in `web/js/view3d/` (e.g. the DEM as a 3D terrain with the route, stops, habitat and astronaut position draped on it, a fly-through along the route, or the Sun direction from `sun.json`). Read everything from `state`; do not fetch APIs from the browser.
- **Look for libraries and open-source repos** that save time (for example three.js, deck.gl, CesiumJS, MapLibre GL, Chart.js plugins, Lottie, icon sets). Reusing good existing work is encouraged; creativity counts.

**Rules**
- No build step: load libraries as ES modules or scripts from a CDN (cdnjs, jsdelivr, unpkg) with an **exact pinned version** (e.g. `three@0.160.0`, never `three@latest`).
- Only permissive licenses (MIT, Apache-2.0, BSD, ISC, CC-BY for assets). Record every library, repo and asset you use, with its license and link, in `docs/credits.md` and tell Ege; the README credits come from there.
- If you copy code from a repo, keep its license header and link the source in a comment.
- Stay inside your files. Need a new `<script>`/`<link>` in `planner.html`, a new `base.css` variable or a map hook? Ask Ege; do not edit those files.
- The 3D view gets its own data from `state` (`area`, `route`, `stops`, `summary.profile`, `sun`, ...) and listens to `stop:select` and `hud:time` like the other modules. Heavy assets (textures, meshes) stay under 5 MB per file; prefer generating terrain from `summary.json` profile or a small heightmap PNG produced by Demir.
- Performance: the page must stay usable on a laptop; load 3D lazily (only when the 3D button is pressed) and fall back quietly if WebGL is missing.
- Decision time below: if the 3D view is not working by then, ship the UI improvements only.

## Decision times (nothing left half-done)

Every risky task has a decision time; if it does not work by then, switch to plan B. The full list is in the team plan; summary:

| Task | Owner | Decide by | Plan B |
|---|---|---|---|
| 1 m DEM coverage | Demir | Sat 13:30 | HiRISE DTM or shift the bbox |
| MSL traverse | Egemen | Sat 13:30 | 10–15 points by hand from Mars Trek |
| Curiosity image API | Egemen | Sat 14:30 | 8–10 URLs by hand from the Raw Images site |
| Horizons Mars surface | Serdar | Sat 14:30 | Analytic Sun angle with the Mars24 algorithm |
| USGS GeoJSON | Serdar | Sat 16:00 | Drop it; keep the Trek geology layer |
| REMS | Egemen | Sat 16:30 | Typical daily curve, labelled "approximate" |
| Route | Demir | Sat 19:30 | 2 m DEM; otherwise a straight line + slope warning |
| `gdal_viewshed` / rvt-py | Utku | Sat 19:30 | Horizon angle in 8 directions and a simple line of sight with numpy; otherwise radio shadow only |
| 3D view MVP | Egemen | Sat 23:00 | UI improvements only, 3D button hidden |
| End-to-end demo | Ege | Sat 23:30 | Extra modules cancelled, everyone on integration |
| Full HUD | Serdar | Sun 03:00 | The 23:00 HUD MVP |

If you are stuck on the same problem for more than 30 minutes, tell the group. As Claude, if the user is stuck on a task past its decision time, remind them of plan B.

## Coordinate and unit rules

- Points in JSON are always **[lon, lat]** (GeoJSON standard).
- A bbox is always written with named fields: `{west, south, east, north}`. Never use an array bbox.
- Leaflet expects [lat, lon]. The conversion happens only in the `toLatLng()` helper in `web/js/map/geo.js`.
- The unit goes in the field name: `_m`, `_min`, `_deg`, `_mSv`, `_pct`, `_c`. Gy (absorbed dose) and Sv (dose equivalent) are never mixed.
- Mars CRS (rasterio/pyproj):
  - Geographic: `+proj=longlat +R=3396190 +no_defs` (`IAU_2015:49900` if PROJ supports it)
  - Metric: `+proj=eqc +lat_ts=0 +lon_0=0 +R=3396190 +units=m +no_defs`
- **Slope, distance and cost are always computed in metres on a projected grid.** Only the visualisation PNG is warped to the geographic grid. PNG bounds must match `bounds` in `overlays.json` exactly.

## Mission constants

Every threshold is read from `config/mission.json` (Utku). Never write magic numbers in code. The full list, with sources and reasoning, is in `docs/story/assumptions.md`; the main values:

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
  "dem_max_downsample_m": 2
}
```

- The O2 and dose models are in `science/models.py`. Demir imports them and does not write a separate model.
- Every assumption goes into `docs/story/assumptions.md`; it will be shown openly in the presentation.

## Tech stack

- **Python 3.11:** `rasterio`, `numpy`, `scipy`, `scikit-image` (`MCP_Geometric`, `route_through_array`), `pyproj`, `requests`, `python-dotenv`, `matplotlib`, `Pillow`. GDAL CLI (`gdalwarp`, `gdal_viewshed`).
- **Frontend:** plain HTML + ES modules with no build step, Leaflet, Chart.js (CDN). GitHub Pages publishes the `web/` folder.
- **Mars Trek tiles:** the map uses the EPSG4326 tile scheme (with the Mars radius, so distances are right). URL order is `{z}/{y}/{x}` (TileMatrix/TileRow/TileCol, x and y swapped):
  ```
  https://trek.nasa.gov/tiles/Mars/EQ/<Layer>/1.0.0/default/default028mm/{z}/{y}/{x}.jpg
  ```
  The extension is jpg or png depending on the layer; use the `format` field in `layers.json`.

## Do and don't

- **Never call external APIs from the browser.** Horizons, the Curiosity raw image API and DONKI are fetched ahead of time by the Python scripts and written to `web/data/` as JSON (CORS and key safety). The only exceptions are Mars Trek tiles and photo URLs (as images).
- **An API key never goes into JS or the repo.** The key lives in `.env`; `.env.example` is in the repo. GitHub Pages is static, so any key in JS is public.
- **Every script must be re-runnable:** like `python -m pipeline.fetch.donki`, input `area.json` and `config/mission.json`, output `web/data/`.
- **Live data can come back empty.** For DONKI, the `replay` mode (the 20 May 2024 event, Curiosity RAD 8,100 µGy) must always work.
- **NoData gaps in the DEM** count as impassable (`inf`) in the cost map, never 0.
- **Photos are never downloaded;** they are shown by URL. Every photo shows its credit: "NASA/JPL-Caltech" ("NASA/JPL-Caltech/MSSS" for Mastcam).
- **The frontend must open even if any `web/data/` file is missing or broken.** Log the error to the console; never crash the UI.
- **After the code freeze:** no new features, no new dependencies, no schema changes.

## Commands

```bash
# Python environment
python -m venv .venv && source .venv/bin/activate     # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env   # NASA_API_KEY=...

# Services and mocks (Utku)
python -m pipeline.fetch.trek
python -m pipeline.fetch.tiles
python -m science.mocks.make_mocks     # writes only missing mock files
python -m science.mocks.check_mocks

# Data (Egemen)
python -m pipeline.fetch.curiosity
python -m pipeline.fetch.rems

# Horizons, EVA, geology and science targets (Serdar)
python -m pipeline.fetch.horizons
python -m science.eva.build
python -m pipeline.fetch.usgs
python -m science.targets              # science targets off the route, from images.json + stops.json
node web/js/hud/test.mjs               # HUD self-tests (logic + real web/data files), no install needed

# Terrain (Demir), in this order
python -m arazi.fetch_dem
python -m arazi.slope
python -m arazi.cost
python -m arazi.overlays
python -m arazi.route
python -m arazi.return_rings

# Science (Utku)
python -m science.models               # prints and checks the model values
python -m pipeline.fetch.donki
python -m science.safety.build         # needs dem_clip.tif + route.geojson
python -m science.build_all

# Local preview: everyone sees their own branch on their own machine
python -m http.server 8000 -d web      # → http://localhost:8000
```

- The site root (`index.html`) is the landing page; the planner is `planner.html`. Old links with app parameters (`?radiation=`, `?hud=`, ...) are forwarded to `planner.html` with the same parameters.
- Do not open the site with `file://`: ES modules and `fetch('data/...')` do not work without a local server.
- The shared, current version is GitHub Pages (`main`). The link we share is always the Pages link.
- If an integration check is needed before a merge, Ege runs `python -m http.server 8000 -d web --bind 0.0.0.0` on Ege's machine and the others open `http://<Ege's IP>:8000`. This is only for a quick look; the hackathon Wi-Fi may block device-to-device traffic.

## Links

- Challenge page and resources: Mars Trek (trek.nasa.gov/mars), USGS Planetary Geologic Mapping, Curiosity Raw Images
- Mars Trek API: https://trek.nasa.gov/tiles/apidoc/trekAPI.html?body=mars
- JPL Horizons API: https://ssd-api.jpl.nasa.gov/doc/horizons.html
- DONKI: https://api.nasa.gov (DONKI section)
- PDS Imaging: https://pds-imaging.jpl.nasa.gov
- Team plan (tasks and times): https://claude.ai/artifact/1wpy7V7LKhvZvTu8fTajC1
