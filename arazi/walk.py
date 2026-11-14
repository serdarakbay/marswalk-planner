# walk.py
# Walking model shared by route.py and return_rings.py: speed, O2 and dose.
# Placeholders until Utku's science/models.py lands (see docs/story/assumptions.md).

import numpy as np

from arazi.geo import load_mission

SUIT_SPEED_FACTOR = 0.6     # suited astronaut walks at 60% of Tobler's hiking speed
STOP_DWELL_MIN = 15         # time spent at each science stop

mission = load_mission()


def speed_m_min(grade):
    """Tobler's hiking function (km/h -> m/min), scaled for a suited astronaut.

    grade: rise / run (positive = uphill). Works on scalars and numpy arrays.
    """
    kmh = 6 * np.exp(-3.5 * np.abs(grade + 0.05))
    return kmh * 1000 / 60 * SUIT_SPEED_FACTOR


def o2_used_pct(duration_min):
    """O2 used for an EVA of this length, in % of the full tank."""
    try:
        from science.models import o2_used_pct as model   # Utku's model, when available
        return model(duration_min)
    except ImportError:
        # Placeholder: a nominal-length EVA uses all O2 above the reserve
        usable = 100 - mission["o2_reserve_pct"]
        return usable * np.asarray(duration_min) / (mission["eva_nominal_hours"] * 60)


def dose_mSv(duration_min):
    return mission["rad_base_mSv_per_day"] * duration_min / (24 * 60)
