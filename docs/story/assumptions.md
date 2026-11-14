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
- **What O2 use does not include** (Assumption). We count only metabolic use. Suit leakage, cooling and purge, and the extra cost of tasks at a stop (for example, using tools) are not modelled. The route code passes the whole EVA duration, stops included, so stop time is counted at the flat walking rate.
- O2 is always reported as a percentage of the **full** tank.

Because the tank is calibrated with the same `o2_kj_per_l`, that value cancels out of the percentage. It only affects the litre figures.

## Radiation

- **0.64 mSv/day on the surface** (Source). Dose equivalent rate measured by Curiosity's RAD at Gale crater. The same paper gives an absorbed dose rate of about 0.21 mGy/day.
  Hassler, D. M., et al. (2014). Mars' surface radiation environment measured with the Mars Science Laboratory's Curiosity rover. *Science*, 343(6169), 1244797.
- **Dose during the walk** (Assumption). Dose = `0.64 × event_multiplier × duration_min / 1440` mSv. The rate is constant through the day. Terrain shielding (crater walls, cliffs) is not counted, so this is conservative. The HUD uses the same formula.
- **Gy and Sv are never mixed.** mGy is absorbed dose; mSv is dose equivalent, which also weights the type of radiation. The 20 May 2024 solar event measured by RAD (8,100 µGy) is an absorbed dose. Turning it into mSv needs a quality factor; the models do not do this yet.

## Route and stops

- **Stop time 15 min** (Assumption). Time spent at each science stop. Taken from Demir's route code.

## Mission thresholds

- **Slope warning 15°, impassable above 25°** (Assumption). Team values, not taken from a reference.
- **EVA window: Sun at least 15° above the horizon, temperature at least -40 °C** (Assumption). Team values, used by Serdar's EVA window.
- **Nominal EVA 8 h** (Assumption). Team value, not taken from a reference.
