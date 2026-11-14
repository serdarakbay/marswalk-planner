"""Mars24 algorithm (Allison & McEwen 2000; Mars24 Sunclock technical notes).

No third-party libraries: math and datetime only.
- LMST / LTST (local mean / true solar time)
- Ls, solar declination, equation of time (EOT)
- Analytic solar elevation/azimuth (Horizons fallback and cross-check)

Longitude: east-positive (same as Mars Trek / area.json).
"""
from __future__ import annotations

import math
from datetime import datetime, timezone

# TT - UTC = 32.184 s + TAI-UTC (37 s since 2017; no new leap second through end of 2026)
TT_MINUS_UTC_S = 69.184

_PBS = (  # (A_i, tau_i, phi_i) planetary perturbation terms
    (0.0071, 2.2353, 49.409),
    (0.0057, 2.7543, 168.173),
    (0.0039, 1.1177, 191.837),
    (0.0037, 15.7866, 21.736),
    (0.0021, 2.1354, 15.704),
    (0.0020, 2.4694, 95.528),
    (0.0018, 32.8493, 49.095),
)


def _jd_utc(dt: datetime) -> float:
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.timestamp() / 86400.0 + 2440587.5


def mars_sun(dt: datetime, lon_east_deg: float, lat_deg: float) -> dict:
    """Mars24 quantities for a UTC instant and surface location."""
    jd_tt = _jd_utc(dt) + TT_MINUS_UTC_S / 86400.0
    d = jd_tt - 2451545.0  # days since J2000 (TT)

    m = math.radians((19.3871 + 0.52402073 * d) % 360.0)
    alpha_fms = (270.3871 + 0.524038496 * d) % 360.0
    pbs = sum(a * math.cos(math.radians(0.985626 * d / tau + phi)) for a, tau, phi in _PBS)
    nu_m = ((10.691 + 3.0e-7 * d) * math.sin(m) + 0.623 * math.sin(2 * m)
            + 0.050 * math.sin(3 * m) + 0.005 * math.sin(4 * m)
            + 0.0005 * math.sin(5 * m) + pbs)
    ls = (alpha_fms + nu_m) % 360.0
    ls_r = math.radians(ls)

    eot_deg = (2.861 * math.sin(2 * ls_r) - 0.071 * math.sin(4 * ls_r)
               + 0.002 * math.sin(6 * ls_r) - nu_m)
    msd = (jd_tt - 2451549.5) / 1.0274912517 + 44796.0 - 0.0009626
    mst_h = (24.0 * msd) % 24.0
    lmst_h = (mst_h + lon_east_deg / 15.0) % 24.0
    ltst_h = (lmst_h + eot_deg / 15.0) % 24.0

    dec = math.asin(0.42565 * math.sin(ls_r)) + math.radians(0.25 * math.sin(ls_r))
    lat = math.radians(lat_deg)
    h = math.radians((ltst_h - 12.0) * 15.0)  # local hour angle
    sin_el = math.sin(dec) * math.sin(lat) + math.cos(dec) * math.cos(lat) * math.cos(h)
    el = math.degrees(math.asin(max(-1.0, min(1.0, sin_el))))
    az = math.degrees(math.atan2(-math.sin(h),
                                 math.tan(dec) * math.cos(lat) - math.sin(lat) * math.cos(h))) % 360.0

    r_au = 1.52367934 * (1.00436 - 0.09309 * math.cos(m) - 0.004336 * math.cos(2 * m)
                         - 0.00031 * math.cos(3 * m) - 0.00003 * math.cos(4 * m))
    return {
        "msd": msd,
        "ls_deg": ls,
        "eot_min": eot_deg * 4.0,
        "mst_h": mst_h,
        "lmst_h": lmst_h,
        "ltst_h": ltst_h,
        "dec_deg": math.degrees(dec),
        "sun_el_deg": el,
        "sun_az_deg": az,  # clockwise from north
        "helio_dist_au": r_au,
    }


def lmst_hours(dt: datetime, lon_east_deg: float) -> float:
    return mars_sun(dt, lon_east_deg, 0.0)["lmst_h"]


def fmt_hm(hours: float) -> str:
    total = int(round(hours * 60)) % (24 * 60)
    return f"{total // 60:02d}:{total % 60:02d}"


if __name__ == "__main__":
    # Allison & McEwen 2000 / Mars24 worked example: 2000-01-06 00:00 UTC, lon 0
    # Expected: MSD ~ 44795.9998, Ls ~ 277.19, EOT ~ -5.19 deg (~ -20.75 min)
    r = mars_sun(datetime(2000, 1, 6, tzinfo=timezone.utc), 0.0, 0.0)
    print({k: round(v, 4) for k, v in r.items()})
