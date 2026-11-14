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

- **Radio line of sight** (Assumption). The astronaut has a radio link only with a direct line of sight from an antenna 6 m above the habitat (`comm_antenna_height_m`) to a suit antenna 2 m above the ground (`comm_suit_antenna_height_m`). Both heights are our choice. There is no relay, and radio waves are not modelled as bending or reflecting around terrain, so any hill in between cuts the link.
- **Why a 6 m mast** (Derived, then our choice). The habitat sits lower than the ground around it, so a short mast sees little of the route. We ran the same route with different mast heights:

  | Mast height | Route points with a link | Route time without a link |
  |---|---|---|
  | 3 m | 53 % | 59.7 min |
  | 6 m | 62 % | 26.3 min |
  | 10 m | 65 % | 25.3 min |
  | 20 m | 73 % | 8.0 min |

  Going from 3 m to 6 m cuts the time without a link from about 60 to about 26 minutes; going on to 10 m saves only 1 more minute. We chose 6 m, the shortest mast after which the benefit levels off. Only a much taller mast (20 m) helps again.
- **Relay for the remaining shadow** (Assumption). A small relay on a nearby hilltop could cover the rest of the route. It is not modelled.
- **Mars curvature** (Derived). Heights along each line of sight are lowered by `d^2 / 2R` with R = 3,396,190 m (about 0.85 m at 2.4 km). Atmospheric refraction is ignored because the Martian atmosphere is thin.
- **Offline time** (Derived). Route time without a link is added up from the route's `t_min`: each walking segment is weighted by its two ends, and stop time by the stop's own link state.
- **Sky-view factor** (Source for the method). SVF is the fraction of the sky hemisphere that is visible: `SVF = 1 - mean(sin(horizon angle))` over 16 directions, searching up to 100 m away (Zakšek, Oštir & Kokalj, 2011, *Remote Sensing* 3(2), 398–415). Directions, radius and the 5 m grid are our choice.
- **Shelters** (Assumption). Candidates are passable points within 200 m of the route. We pick the 5 points with the lowest SVF (the most enclosed) that are at least 150 m apart. "Time to shelter" is the walking time on the same cost grid as the return rings, again counting every step as uphill.
- **Dose falls with the visible sky** (Assumption). At a shelter we take the dose rate as `base rate × SVF`: radiation is assumed to arrive evenly from the visible sky, and the terrain is assumed to block it completely. In reality more of the surface dose comes from overhead than from near the horizon, and some secondary particles come up from the ground. Blocking the low sky therefore helps less than this suggests, so the shelter benefit is probably **optimistic**.

## Mission thresholds

- **Slope warning 15°, impassable above 25°** (Assumption). Team values, not taken from a reference.
- **EVA window: Sun at least 15° above the horizon, temperature at least -40 °C** (Assumption). Team values, used by Serdar's EVA window.
- **Nominal EVA 8 h** (Assumption). Team value, not taken from a reference.
