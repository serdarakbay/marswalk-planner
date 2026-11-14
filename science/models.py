"""Walking speed, metabolic rate, O2 use and radiation dose for the Marswalk.

All mission values come from config/mission.json. The only numbers in this file are the
published coefficients of the Tobler and Pandolf equations, Earth gravity (the gravity
Pandolf was fitted at) and unit conversions. Assumptions and sources: docs/story/assumptions.md.

Conventions:
- grade_pct is the signed grade along the direction of travel: dz/dx * 100 (uphill > 0).
- O2 is reported as a percentage of the full tank (0-100), never of the usable part.
- Every function takes scalars and never raises on bad input: it clamps or substitutes
  the value and emits a RuntimeWarning, so callers (arazi/route.py, HUD tooling) keep running.
- If config/mission.json is missing or incomplete, importing this module raises ImportError,
  so callers that guard the import with `except ImportError` fall back to their placeholder.

Run the self-check:  python -m science.models
"""
from __future__ import annotations

import math
import sys
import warnings

from pipeline.common import load_mission

# --- Published equation coefficients (part of the equations, not mission tunables) ---
# Tobler (1993): v_kmh = 6 * exp(-3.5 * |S + 0.05|), S = dz/dx
TOBLER_PEAK_KMH = 6.0
TOBLER_DECAY = 3.5
TOBLER_OFFSET = 0.05
# Pandolf et al. (1977): M = 1.5 W + 2.0 (W + L)(L / W)^2 + eta (W + L)(1.5 V^2 + 0.35 V G)
PANDOLF_STAND = 1.5
PANDOLF_LOAD = 2.0
PANDOLF_SPEED = 1.5
PANDOLF_GRADE = 0.35
# Pandolf was fitted on Earth; load and movement terms are scaled by g_mars / g_earth.
EARTH_GRAVITY_M_S2 = 9.81

# --- Unit conversions ---
KMH_PER_M_S = 3.6
S_PER_MIN = 60
MIN_PER_H = 60
MIN_PER_DAY = 1440
J_PER_KJ = 1000

_POSITIVE_KEYS = ("gravity_m_s2", "slope_max_deg", "eva_nominal_hours", "rad_base_mSv_per_day",
                  "body_mass_kg", "suit_load_kg", "terrain_factor", "o2_kj_per_l",
                  "suit_speed_factor")


def _load_mission() -> dict:
    try:
        mission = load_mission()
    except (OSError, ValueError) as exc:
        raise ImportError(f"science.models needs a valid config/mission.json: {exc}") from exc
    bad = [k for k in _POSITIVE_KEYS
           if not isinstance(mission.get(k), (int, float)) or not mission[k] > 0]
    reserve = mission.get("o2_reserve_pct")
    if not isinstance(reserve, (int, float)) or not 0 <= reserve < 100:
        bad.append("o2_reserve_pct")
    if bad:
        raise ImportError(f"config/mission.json: missing or invalid values for {bad}")
    return mission


MISSION = _load_mission()
_G_RATIO = MISSION["gravity_m_s2"] / EARTH_GRAVITY_M_S2
# Steepest grade we model: the impassable slope from mission.json, as a grade in percent
MAX_GRADE_PCT = math.tan(math.radians(MISSION["slope_max_deg"])) * 100


def _warn(msg: str) -> None:
    warnings.warn(f"science.models: {msg}", RuntimeWarning, stacklevel=3)


def _num(value, name: str, default: float, lo: float | None = None, hi: float | None = None) -> float:
    """Coerce to a finite float and clamp to [lo, hi]; warn instead of raising."""
    try:
        x = float(value)
    except (TypeError, ValueError):
        _warn(f"{name}={value!r} is not a number, using {default}")
        return default
    if not math.isfinite(x):
        _warn(f"{name}={value!r} is not finite, using {default}")
        return default
    if lo is not None and x < lo:
        _warn(f"{name}={x} is below {lo}, clamped")
        return lo
    if hi is not None and x > hi:
        _warn(f"{name}={x} is above {hi}, clamped")
        return hi
    return x


def _grade(grade_pct) -> float:
    return _num(grade_pct, "grade_pct", 0.0, -MAX_GRADE_PCT, MAX_GRADE_PCT)


def walking_speed_m_s(grade_pct: float = 0.0) -> float:
    """Suited walking speed (m/s): Tobler's hiking function x suit_speed_factor."""
    s = _grade(grade_pct) / 100
    kmh = TOBLER_PEAK_KMH * math.exp(-TOBLER_DECAY * abs(s + TOBLER_OFFSET))
    return kmh / KMH_PER_M_S * MISSION["suit_speed_factor"]


def metabolic_rate_w(speed_m_s: float, grade_pct: float = 0.0) -> float:
    """Metabolic rate (W) from the Pandolf equation, adapted to Mars gravity.

    Load and movement terms are scaled by gravity_m_s2 / 9.81; the 1.5 W standing term is not.
    Downhill grades are clipped to 0 (Pandolf is not reliable downhill; this is conservative).
    """
    v = _num(speed_m_s, "speed_m_s", 0.0, lo=0.0)
    g = max(0.0, _grade(grade_pct))
    w, load, eta = MISSION["body_mass_kg"], MISSION["suit_load_kg"], MISSION["terrain_factor"]
    standing = PANDOLF_STAND * w
    load_term = PANDOLF_LOAD * (w + load) * (load / w) ** 2
    movement = eta * (w + load) * (PANDOLF_SPEED * v ** 2 + PANDOLF_GRADE * v * g)
    return standing + _G_RATIO * (load_term + movement)


def o2_l_per_min(metabolic_w: float) -> float:
    """O2 consumption (L/min) for a metabolic rate, using o2_kj_per_l."""
    m = _num(metabolic_w, "metabolic_w", 0.0, lo=0.0)
    return m * S_PER_MIN / (MISSION["o2_kj_per_l"] * J_PER_KJ)


NOMINAL_SPEED_M_S = walking_speed_m_s(0.0)
NOMINAL_METABOLIC_W = metabolic_rate_w(NOMINAL_SPEED_M_S, 0.0)
# Tank calibration: eva_nominal_hours of flat walking at nominal speed uses (100 - reserve) %.
TANK_O2_L = (o2_l_per_min(NOMINAL_METABOLIC_W) * MISSION["eva_nominal_hours"] * MIN_PER_H
             / ((100 - MISSION["o2_reserve_pct"]) / 100))


def o2_used_pct(duration_min: float, grade_pct: float = 0.0, speed_m_s: float | None = None) -> float:
    """O2 used (% of the full tank) for walking duration_min at grade_pct.

    speed_m_s defaults to the suited Tobler speed at that grade. With only duration_min this is
    flat walking at nominal speed, which matches the placeholder in arazi/route.py exactly.
    The result can exceed 100 if the activity is longer than the tank allows.
    """
    t = _num(duration_min, "duration_min", 0.0, lo=0.0)
    g = _grade(grade_pct)
    v = walking_speed_m_s(g) if speed_m_s is None else _num(speed_m_s, "speed_m_s", NOMINAL_SPEED_M_S, lo=0.0)
    used_l = o2_l_per_min(metabolic_rate_w(v, g)) * t
    return 100 * used_l / TANK_O2_L


def dose_mSv(duration_min: float, event_multiplier: float = 1.0) -> float:
    """Dose equivalent (mSv) outside: rad_base_mSv_per_day x event_multiplier x duration / 1440.

    Same formula as the HUD (web/js/hud/model.js evaDose). Sv, not Gy.
    """
    t = _num(duration_min, "duration_min", 0.0, lo=0.0)
    k = _num(event_multiplier, "event_multiplier", 1.0, lo=0.0)
    return MISSION["rad_base_mSv_per_day"] * k * t / MIN_PER_DAY


def _self_check() -> int:
    failures = []

    def check(ok: bool, label: str) -> None:
        print(f"  [{'OK' if ok else 'FAIL'}] {label}")
        if not ok:
            failures.append(label)

    m = MISSION
    print("Inputs from config/mission.json:")
    for k in ("gravity_m_s2", "body_mass_kg", "suit_load_kg", "terrain_factor", "o2_kj_per_l",
              "suit_speed_factor", "eva_nominal_hours", "o2_reserve_pct", "rad_base_mSv_per_day"):
        print(f"  {k} = {m[k]}")
    print("Derived:")
    print(f"  nominal speed (flat)  {NOMINAL_SPEED_M_S:.3f} m/s = {NOMINAL_SPEED_M_S * KMH_PER_M_S:.2f} km/h")
    print(f"  nominal metabolic     {NOMINAL_METABOLIC_W:.0f} W")
    print(f"  O2 at nominal         {o2_l_per_min(NOMINAL_METABOLIC_W):.3f} L/min")
    print(f"  calibrated tank       {TANK_O2_L:.0f} L O2")
    print(f"  max grade modelled    +/-{MAX_GRADE_PCT:.1f} % (slope_max_deg {m['slope_max_deg']})")

    print("Checks:")
    nominal_min = m["eva_nominal_hours"] * MIN_PER_H
    o2_8h = o2_used_pct(nominal_min)
    check(abs(o2_8h - (100 - m["o2_reserve_pct"])) < 1e-9,
          f"{m['eva_nominal_hours']} h flat at nominal speed uses {o2_8h:.2f} % (expected {100 - m['o2_reserve_pct']} %)")
    check(all(abs(o2_used_pct(t) - (100 - m["o2_reserve_pct"]) * t / nominal_min) < 1e-9 for t in (0, 37, 112, 480)),
          "o2_used_pct(duration_min) matches the arazi/route.py placeholder")

    def km(grade):
        v = walking_speed_m_s(grade)
        t = 1000 / v / S_PER_MIN
        return t, o2_used_pct(t, grade), metabolic_rate_w(v, grade), v

    t_up, o2_up, w_up, v_up = km(10)
    t_flat, o2_flat, w_flat, v_flat = km(0)
    t_dn, o2_dn, w_dn, v_dn = km(-10)
    print(f"  1 km at +10 %: {v_up:.3f} m/s, {t_up:.1f} min, {w_up:.0f} W, O2 {o2_up:.2f} %")
    print(f"  1 km flat    : {v_flat:.3f} m/s, {t_flat:.1f} min, {w_flat:.0f} W, O2 {o2_flat:.2f} %")
    print(f"  1 km at -10 %: {v_dn:.3f} m/s, {t_dn:.1f} min, {w_dn:.0f} W, O2 {o2_dn:.2f} % (grade clipped to 0)")
    check(o2_up > o2_flat, "1 km at +10 % uses more O2 than 1 km flat")

    dose4 = dose_mSv(4 * MIN_PER_H)
    check(abs(dose4 - 0.107) < 0.0005, f"4 h EVA dose {dose4:.4f} mSv (expected about 0.107)")
    check(200 <= NOMINAL_METABOLIC_W <= 500, f"nominal metabolic rate {NOMINAL_METABOLIC_W:.0f} W is within 200-500 W")

    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        try:
            results = [o2_used_pct(float("nan")), o2_used_pct(-10), o2_used_pct("abc"),
                       o2_used_pct(60, grade_pct=500), o2_used_pct(60, speed_m_s=-1),
                       walking_speed_m_s(None), metabolic_rate_w(float("inf")), dose_mSv(-5),
                       dose_mSv(60, event_multiplier="x")]
            ok = all(isinstance(r, float) and math.isfinite(r) for r in results)
        except Exception as exc:  # the check itself must report, not crash
            ok = False
            print(f"  raised {type(exc).__name__}: {exc}")
    check(ok and len(caught) >= 9, f"bad inputs return finite numbers with warnings ({len(caught)} warnings)")

    print("All checks passed." if not failures else f"{len(failures)} check(s) failed.")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(_self_check())
