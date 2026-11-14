# Assumptions

Every number the Marswalk models use, where it comes from, and how sure we are. Values live in `config/mission.json`; the models are in `science/models.py` (run `python -m science.models` to print and check them).

Each item is tagged:

- **Source**: taken from a published reference.
- **Assumption**: our own choice; reasonable, but not taken from a reference.
- **Derived**: calculated from the items above.

## Walking speed

- **Tobler's hiking function** (Source). Walking speed on a slope is `6 * exp(-3.5 * |S + 0.05|)` km/h, where `S` is the grade (dz/dx). It is fastest on a gentle downhill (S = -0.05) and symmetric around it, so a 10 % downhill gives the same speed as flat ground.
  Tobler, W. (1993). *Three presentations on geographical analysis and modeling.* NCGIA Technical Report 93-1.
- **Suit speed factor 0.6** (Assumption). A suited astronaut walks at 60 % of Tobler's hiking speed. Taken from Demir's route code. This gives about 3.0 km/h on flat ground.

## Metabolic rate (Pandolf equation)

- **Pandolf load-carriage equation** (Source).
  `M = 1.5 W + 2.0 (W + L)(L / W)^2 + eta (W + L)(1.5 V^2 + 0.35 V G)`
  with `M` in watts, `W` body mass (kg), `L` carried load (kg), `V` speed (m/s), `G` grade (%), and `eta` a terrain factor.
  Pandolf, K. B., Givoni, B., & Goldman, R. F. (1977). Predicting energy expenditure with loads while standing or walking very slowly. *Journal of Applied Physiology*, 43(4), 577–581.
- **Terrain factor eta = 1.2** (Assumption based on a Source). 1.2 is the "light brush" value in the terrain coefficient table used with the Pandolf equation (Soule & Goldman, 1972, *Journal of Applied Physiology* 32, 706–708). Mars has no brush. We use 1.2 as a stand-in for lightly rough, rocky ground.
- **Body mass 75 kg** (Assumption). A typical adult astronaut.
- **Suit load 90 kg** (Assumption). The mass of the suit, life-support backpack and tools, chosen to be in the range of the Apollo A7L suit with its PLSS. We did not check this against a specific mass figure; treat it as an order-of-magnitude value.
- **Gravity scaling** (Assumption). Pandolf was fitted on Earth. On Mars we multiply the load term and the movement term by `g_mars / g_earth = 3.71 / 9.81 ≈ 0.38`, because both come from moving or holding up mass against gravity. We do **not** scale the `1.5 W` standing term, which we treat as basal metabolism and not as work against gravity. This is a first-order simplification; real reduced-gravity walking also changes gait, which this model ignores.
- **Downhill clipped to 0 %** (Assumption). The Pandolf equation is not reliable on downhill grades: plugging in a negative grade can predict less energy than standing still. We set negative grades to 0 % for the metabolic rate. This is conservative: downhill walking costs as much as flat walking. Walking speed still uses the signed grade.
- **Grades limited to ±46.6 %** (Derived). Inputs are clamped to the grade of `slope_max_deg` (25°), the slope the route treats as impassable.

With these values, flat walking at nominal speed costs about **371 W** (Derived).

## Oxygen

- **1 L of O2 ≈ 20.1 kJ** (Source, standard value). The energy released per litre of oxygen consumed, at a typical mixed diet (respiratory quotient around 0.8). This is the usual indirect-calorimetry figure (about 4.8 kcal per litre); the underlying method is Weir, J. B. de V. (1949), *Journal of Physiology*, 109, 1–9.
- **Tank size from calibration** (Assumption, then Derived). We do not use a real suit O2 capacity. Instead, we set the tank so that walking on flat ground at nominal speed for `eva_nominal_hours` (8 h) uses exactly `100 - o2_reserve_pct` (75 %) of it. This gives about 709 L of O2 (Derived). It also keeps the model consistent with the placeholder in Demir's route code: `o2_used_pct(duration_min)` returns the same value as before.
- **Reserve 25 %** (Assumption). Team value. The O2 alert rules use it as the point to return to the habitat.
- **What O2 use does not include** (Assumption). We count only metabolic use. Suit leakage, cooling and purge, and the extra cost of tasks at a stop (for example, using tools) are not modelled.
- **Route O2 is added up piece by piece** (Derived). Each walking segment uses its own grade, `o2_used_pct(t, grade_pct)`; time at a stop counts as standing still, `o2_used_pct(t, 0, speed_m_s=0)`. Standing costs less than walking, so the current route uses 11.6 % of the tank instead of 12.2 % when everything was counted as flat walking.
- O2 is always reported as a percentage of the **full** tank.

Because the tank is calibrated with the same `o2_kj_per_l`, that value cancels out of the percentage. It only affects the litre figures.

## Radiation

- **0.64 mSv/day on the surface** (Source). Dose equivalent rate measured by Curiosity's RAD at Gale crater. The same paper gives an absorbed dose rate of about 0.21 mGy/day.
  Hassler, D. M., et al. (2014). Mars' surface radiation environment measured with the Mars Science Laboratory's Curiosity rover. *Science*, 343(6169), 1244797.
- **Dose during the walk** (Assumption). Dose = `0.64 × event_multiplier × duration_min / 1440` mSv. The rate is constant through the day. Terrain shielding (crater walls, cliffs) is not counted, so this is conservative. The HUD uses the same formula.
- **Gy and Sv are never mixed.** mGy is absorbed dose; mSv is dose equivalent, which also weights the type of radiation. The 20 May 2024 solar event measured by RAD (8,100 µGy) is an absorbed dose. We never add Gy values to Sv values.

## Space weather (DONKI) and the radiation status

- **Event data** (Source). Flares (FLR), coronal mass ejections (CME) and solar energetic particle events (SEP) come from NASA's DONKI database via api.nasa.gov (`pipeline/fetch/donki.py`).
- **Mars impact** (Source, with a rule we chose). A CME counts as reaching Mars only if a WSA-ENLIL simulation in DONKI lists "Mars" in its impactList. A flare or SEP counts only if it is linked in DONKI to such a CME. Everything else is `false`. WSA-ENLIL is a model forecast, not a measurement at Mars.
- **Missing flares** (Data limitation). The DONKI flare endpoint returned HTTP 404 on api.nasa.gov when we built this. Flares are then taken from the links in CME and SEP records: the start time comes from the DONKI activity ID and the peak time is unknown (`null`). For the replay window, DONKI has no SEP records and no Mars-impacting run for the 20 May 2024 CME.
- **Replay event dose 8,100 µGy = 8.1 mGy** (Source). Absorbed dose measured by Curiosity's RAD during the May 2024 solar storm, as reported in NASA/JPL's news release on that storm (June 2024).
- **Background absorbed dose 0.21 mGy/day** (Source). Hassler et al. (2014), the same paper as the 0.64 mSv/day dose equivalent above.
- **Replay dose multiplier ≈ 38.6** (Assumption). `event_multiplier = 8.1 mGy / 0.21 mGy per day`. Both values are absorbed doses, so the ratio has no unit. Using it as a dose-rate multiplier means two simplifications:
  1. The whole event dose arrives within one day.
  2. The event's radiation has the same quality factor (mSv per mGy) as the background. Solar particles are mostly protons, which have a lower quality factor than the galactic cosmic ray background, so this probably **overestimates** the dose equivalent. That makes it a conservative value.

  With it, a 4 h EVA during the replay storm gets about 4.1 mSv instead of 0.11 mSv.
- **Live status** (Assumption). In live mode the dose is not quantified: `event_multiplier` stays 1.0. The status is `elevated` when a WSA-ENLIL Mars arrival falls within ±48 h (`rad_event_window_h`) of now, otherwise `nominal`. The 48 h window is our choice.

## Route and stops

- **Stop time 15 min** (Assumption). Time spent at each science stop. Taken from Demir's route code.
- **Route cost** (Assumption). Each 1 m DEM pixel costs `1 + (slope / 15°)^2 + roughness / 0.5 m`, where roughness is the standard deviation of elevation in a 5 × 5 m window. Pixels steeper than 25° and NoData pixels cannot be crossed. The route is the lowest-cost path on the 1 m DEM, found with scikit-image's `MCP_Geometric` (8 directions).
- **Return rings** (Assumption). For every pixel, the time and O2 of the shortest safe walk back to the habitat. To be cautious, every step is counted as uphill, so the real way back can be shorter. The rings are drawn in 15-minute bands.

## Science stops

- **Stops on Curiosity's track** (Source). Each stop is a rover position where Curiosity took photos (`images.json`), so the stop lies on the real traverse and its photos show that place.
- **Unit from the sol** (Assumption). The USGS map in `geology.geojson` (1:20,000,000) puts the whole walk in one unit (Htu), so it cannot separate the clay-bearing unit, the transition and the sulfate-bearing unit. We assign units by the sol of the photos instead. Clay-bearing: before sol 3100; inside our area Curiosity has no sols between 3005 and 3202, so any boundary in that gap gives the same result. Transition: sol 3100 to 3599. Sulfate-bearing: from sol 3600, about when NASA reported in October 2022 that the rover had reached the sulfate-bearing region. Both boundaries are approximate.
- **Elevation check** (Derived). Mount Sharp's layers get younger upward, so the units should also rise in this order. The stop elevations do: clay -4081 m, transition -4021 m, sulfate -3859 m.
- **Stop choice** (Assumption). Stops are at least 200 m apart. Among all valid triples we take the shortest loop from the habitat that, walked on Demir's cost grid with the same walking model, fits the EVA window and stays above the O2 reserve.

## Radio link and shelters

- **Radio line of sight** (Assumption). The astronaut has a radio link only with a direct line of sight to the habitat antenna, 6 m above the habitat (`comm_antenna_height_m`), or to the relay (below), from a suit antenna 2 m above the ground (`comm_suit_antenna_height_m`). These heights are our choice. Radio waves are not modelled as bending or reflecting around terrain, so any hill in between cuts the link.
- **One relay** (Assumption). The crew sets up one relay station with an antenna 3 m above the ground (`relay_antenna_height_m`). It must have a line of sight to the habitat antenna, stand on passable ground and be within 300 m of the route (`relay_search_radius_m`). We search a 40 m grid (`relay_grid_m`), then a 10 m grid around the best point, and keep the site that leaves the least route time without a link. Its power supply, setup time and the habitat-to-relay radio budget are not modelled. For the current route the relay is about 400 m north of the habitat.
- **Mast height and the relay** (Derived, then our choice). The habitat sits lower than the ground around it, and the route runs about 1.9 km north of it, so the habitat antenna alone sees little of the route. Same route, different mast heights:

  | Mast height | Route points with a link (habitat only) | Time without a link, habitat only | Time without a link, habitat + relay |
  |---|---|---|---|
  | 3 m | 14 % | 143.6 min | 14.0 min |
  | 6 m | 17 % | 123.8 min | 12.1 min |
  | 10 m | 19 % | 122.6 min | 11.1 min |
  | 20 m | 21 % | 119.3 min | 9.4 min |

  On this route the mast height hardly matters: even a 20 m mast leaves about two hours of the 158 min walk without a link. The relay is what restores the link, cutting the time without one to about 12 minutes. We keep the 6 m mast: with the relay it saves 2 minutes over 3 m, and a 20 m mast would save less than 3 more. The table is printed by `python -m science.safety.build --mast-sensitivity 3,6,10,20`.
- **Mars curvature** (Derived). Heights along each line of sight are lowered by `d^2 / 2R` with R = 3,396,190 m (about 0.85 m at 2.4 km). Atmospheric refraction is ignored because the Martian atmosphere is thin.
- **Offline time** (Derived). Route time without a link is added up from the route's `t_min`: each walking segment is weighted by its two ends, and stop time by the stop's own link state.
- **Sky-view factor** (Source for the method). SVF is the fraction of the sky hemisphere that is visible: `SVF = 1 - mean(sin(horizon angle))` over 16 directions, searching up to 100 m away (Zakšek, Oštir & Kokalj, 2011, *Remote Sensing* 3(2), 398–415). Directions, radius and the 5 m grid are our choice.
- **Shelters** (Assumption). Candidates are passable points within 200 m of the route. Only the most enclosed 10 % of them qualify (`shelter_svf_percentile`; SVF at most about 0.82 here), and in each 50 m cell only the most enclosed one is kept. From these we choose 5 shelters at least 150 m apart that make the longest walk from any point of the route to its nearest shelter as short as possible; ties are broken by the shorter mean walk, then by the lower SVF. This spreads the shelters along the route: the longest walk to a shelter is about 8 min (mean about 4 min), instead of about 29 min when we simply took the 5 most enclosed points, which all lay in the southern half. The price is that the chosen shelters are a little more open (SVF 0.70–0.81 instead of 0.54–0.65). The candidate search uses walking times on a 5 m grid; the final "time to shelter" is the walking time on the 1 m cost grid, as for the return rings, counting every step as uphill.
- **Dose falls with the visible sky** (Assumption). At a shelter we take the dose rate as `base rate × SVF`: radiation is assumed to arrive evenly from the visible sky, and the terrain is assumed to block it completely. In reality more of the surface dose comes from overhead than from near the horizon, and some secondary particles come up from the ground. Blocking the low sky therefore helps less than this suggests, so the shelter benefit is probably **optimistic**.

## HUD alerts

The rules in `web/data/alerts.json` are written by `science/alerts.py` from `config/mission.json`.

- **Slope** (Assumption). Warning at `slope_warn_deg` (15°), danger at `slope_max_deg` (25°), the same thresholds the route uses.
- **Turn back with 10 points to spare** (Assumption). Warning when the remaining O2 reaches the reserve plus `o2_return_margin_pct` (25 % + 10 = 35 %); danger at the reserve itself (25 %). At the flat walking rate the model uses about 0.16 % of the tank per minute (75 % over 8 h), so 10 points are roughly an hour of walking back.
- **EVA dose warning 1 mSv** (Assumption). `eva_dose_warn_mSv` = 1 mSv is about 1.5 sols of background dose on the surface (1 / 0.64 mSv per day ≈ 1.56 days ≈ 1.5 sols). This is a planning flag for "this EVA is unusual", not a health limit. On a normal walk it never fires (the current route gets about 0.04 mSv); during the replay storm (×38.6) it fires after about an hour outside.
- **Radiation** (Assumption). Warning when `radiation.json` says `elevated`, danger with "go to the nearest shelter" when it says `storm`.
- **Radio shadow** (Assumption). Warning whenever the route point has no line of sight to the habitat antenna (`comm_ok` is false).
- **EVA window** (Assumption). Warning `eva_end_warn_min` (30 min) before the EVA window closes. 30 min is our choice; it is two of the 15-minute return-ring bands.

## Mission thresholds

- **Slope warning 15°, impassable above 25°** (Assumption). Team values, not taken from a reference.
- **EVA window: Sun at least 15° above the horizon, temperature at least -40 °C** (Assumption). Team values, used by Serdar's EVA window.
- **Nominal EVA 8 h** (Assumption). Team value, not taken from a reference.
