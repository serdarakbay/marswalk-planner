# walk.py
# Walking model shared by route.py and return_rings.py: speed, O2 and dose.
# O2 and dose come from Utku's science/models.py; if it cannot be imported we fall
# back to a flat-walking placeholder so the pipeline keeps running.
# Constants come from config/mission.json (suit_speed_factor, stop_dwell_min, ...).

import numpy as np

from arazi.geo import load_mission

mission = load_mission()
SUIT_SPEED_FACTOR = mission["suit_speed_factor"]   # suited speed / Tobler hiking speed
STOP_DWELL_MIN = mission["stop_dwell_min"]         # time spent at each science stop

try:
    from science import models
except ImportError as exc:
    models = None
    print(f"WARNING: science.models unavailable ({exc}); using placeholder O2 model")

# Grades outside +/- tan(slope_max_deg) are impassable anyway; clip so the model never warns
MAX_GRADE = np.tan(np.radians(mission["slope_max_deg"]))


def speed_m_min(grade):
    """Tobler's hiking function (km/h -> m/min), scaled for a suited astronaut.

    grade: rise / run (positive = uphill). Works on scalars and numpy arrays.
    Same formula as science.models.walking_speed_m_s, but vectorised.
    """
    kmh = 6 * np.exp(-3.5 * np.abs(grade + 0.05))
    return kmh * 1000 / 60 * SUIT_SPEED_FACTOR


# O2 use per minute (% of tank) as a function of grade, as a lookup table so it
# works on whole rasters at once. science.models functions only take scalars.
_LUT_GRADES = np.linspace(-MAX_GRADE, MAX_GRADE, 401)
if models:
    _LUT_RATE = np.array([models.o2_used_pct(1.0, g * 100) for g in _LUT_GRADES])
    _REST_RATE = models.o2_used_pct(1.0, 0.0, speed_m_s=0.0)
else:
    _flat = (100 - mission["o2_reserve_pct"]) / (mission["eva_nominal_hours"] * 60)
    _LUT_RATE = np.full_like(_LUT_GRADES, _flat)
    _REST_RATE = _flat


def o2_walk_pct(duration_min, grade=0.0):
    """O2 (% of full tank) for walking `duration_min` at `grade` (rise/run). Arrays OK."""
    g = np.clip(grade, -MAX_GRADE, MAX_GRADE)
    return np.asarray(duration_min) * np.interp(g, _LUT_GRADES, _LUT_RATE)


def o2_rest_pct(duration_min):
    """O2 (% of full tank) while standing still, e.g. at a science stop."""
    return np.asarray(duration_min) * _REST_RATE


def o2_lut(n=101):
    """O2 table for the frontend route planner (web/js/cards/router.js reads summary.o2_lut).

    grade is rise/run (signed, uphill > 0); pct_per_min is % of the tank per minute of
    walking at that grade; rest_pct_per_min is standing still. Prefers Utku's
    science.models.o2_lut() when it exists, so both stay the same.
    """
    if models and hasattr(models, "o2_lut"):
        return models.o2_lut()
    grades = np.linspace(-MAX_GRADE, MAX_GRADE, n)
    return {
        "grade": [round(float(g), 4) for g in grades],
        "pct_per_min": [round(float(r), 5) for r in np.interp(grades, _LUT_GRADES, _LUT_RATE)],
        "rest_pct_per_min": round(float(_REST_RATE), 5),
    }


def dose_mSv(duration_min):
    if models:
        return models.dose_mSv(duration_min)
    return mission["rad_base_mSv_per_day"] * duration_min / (24 * 60)
