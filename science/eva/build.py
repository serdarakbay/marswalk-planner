"""web/data/sun.json (+ weather.json) -> web/data/eva_window.json

EVA window = longest stretch of the sol where
    sun_el >= eva_min_sun_el_deg  AND  temp_c >= eva_min_temp_c,
clipped to eva_nominal_hours (centered on the highest Sun inside the stretch).
Edges are refined by linear interpolation between the 10 min samples.

Run:  python -m science.eva.build
Inputs:  web/data/sun.json (pipeline.fetch.horizons), config/mission.json,
         web/data/weather.json (optional; MOCK curve until it exists)
"""
from __future__ import annotations

import json
import math
import sys
from datetime import datetime, timedelta
from pathlib import Path

from science.eva.lmst import fmt_hm, mars_sun

ROOT = Path(__file__).resolve().parents[2]
SUN_JSON = ROOT / "web" / "data" / "sun.json"
WEATHER_JSON = ROOT / "web" / "data" / "weather.json"
MISSION_JSON = ROOT / "config" / "mission.json"
OUT_JSON = ROOT / "web" / "data" / "eva_window.json"

# Used only when config/mission.json lacks a key (team decision); a warning is printed.
DEFAULTS = {"eva_min_sun_el_deg": 15.0, "eva_min_temp_c": -40.0, "eva_nominal_hours": 8.0}

# --- MOCK temperature curve ---------------------------------------------------
# MOCK: replace with web/data/weather.json (Egemen) as soon as it lands.
# Typical Gale crater near-surface air temperature shape (REMS-like):
# minimum just before sunrise, maximum early afternoon.
MOCK_TEMP_MIN_C = -78.0
MOCK_TEMP_MAX_C = -8.0
MOCK_T_MIN_LMST_H = 6.0
MOCK_T_MAX_LMST_H = 14.0


def mock_temp_c(lmst_h: float) -> float:
    """MOCK: half-cosine warm-up (06->14 LMST), half-cosine cool-down (14->06)."""
    span_up = MOCK_T_MAX_LMST_H - MOCK_T_MIN_LMST_H
    x = (lmst_h - MOCK_T_MIN_LMST_H) % 24.0
    if x <= span_up:
        f = (1 - math.cos(math.pi * x / span_up)) / 2
    else:
        f = (1 + math.cos(math.pi * (x - span_up) / (24.0 - span_up))) / 2
    return MOCK_TEMP_MIN_C + (MOCK_TEMP_MAX_C - MOCK_TEMP_MIN_C) * f
# -----------------------------------------------------------------------------


def _hm_to_h(s: str) -> float:
    hh, mm = s.split(":")[:2]
    return int(hh) + int(mm) / 60.0


def load_thresholds() -> dict:
    try:
        mission = json.loads(MISSION_JSON.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        print(f"WARNING: could not read config/mission.json ({exc}); using defaults {DEFAULTS}",
              file=sys.stderr)
        return dict(DEFAULTS)
    out = {}
    for key, default in DEFAULTS.items():
        if key in mission:
            out[key] = float(mission[key])
        else:
            print(f"WARNING: {key} missing in config/mission.json; using default {default}",
                  file=sys.stderr)
            out[key] = default
    return out


def load_temp_fn():
    """Return (temp_c(lmst_h), source label). Real weather.json if valid, else MOCK."""
    try:
        weather = json.loads(WEATHER_JSON.read_text(encoding="utf-8"))
        pts = sorted((_hm_to_h(r["lmst"]), float(r["temp_c"])) for r in weather["rows"])
        if len(pts) < 2:
            raise ValueError("fewer than 2 rows")
    except (OSError, KeyError, ValueError, TypeError) as exc:
        print(f"WARNING: weather.json unavailable ({exc}); using MOCK temperature curve",
              file=sys.stderr)
        return mock_temp_c, "MOCK"

    def interp(h: float) -> float:  # linear, wrapping around midnight
        h %= 24.0
        ext = [(pts[-1][0] - 24.0, pts[-1][1])] + pts + [(pts[0][0] + 24.0, pts[0][1])]
        for (h0, t0), (h1, t1) in zip(ext, ext[1:]):
            if h0 <= h <= h1:
                return t0 if h1 == h0 else t0 + (t1 - t0) * (h - h0) / (h1 - h0)
        return pts[0][1]

    return interp, "weather.json"


def _parse_utc(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def build() -> dict:
    sun = json.loads(SUN_JSON.read_text(encoding="utf-8"))
    lon = float(sun["observer"]["lon"])
    th = load_thresholds()
    temp_fn, temp_src = load_temp_fn()
    min_el, min_t = th["eva_min_sun_el_deg"], th["eva_min_temp_c"]

    samples = []
    for r in sun["rows"]:
        t = _parse_utc(r["utc"])
        temp = temp_fn(mars_sun(t, lon, 0.0)["lmst_h"])
        m_sun, m_temp = r["sun_el"] - min_el, temp - min_t
        samples.append({"t": t, "sun_el": r["sun_el"], "temp": temp,
                        "m_sun": m_sun, "m_temp": m_temp, "ok": m_sun >= 0 and m_temp >= 0})

    # Longest run of consecutive OK samples
    best, cur = None, None
    for i, s in enumerate(samples):
        if s["ok"]:
            cur = (cur[0], i) if cur else (i, i)
            if best is None or cur[1] - cur[0] > best[1] - best[0]:
                best = cur
        else:
            cur = None

    temp_note = "temperature MOCK" if temp_src == "MOCK" else "temperature from weather.json"
    if best is None:
        return {"start_lmst": None, "end_lmst": None,
                "reason": (f"No window: sun_el >= {min_el:g} deg and temp >= {min_t:g} C "
                           f"never hold together ({temp_note})"),
                "duration_min": 0, "temp_source": temp_src}

    def edge(i_out: int, i_in: int) -> tuple[datetime, str]:
        """Interpolated crossing between a failing and a passing sample + binding constraint."""
        a, b = samples[i_out], samples[i_in]
        binding = "sun" if a["m_sun"] < 0 and (a["m_temp"] >= 0 or a["m_sun"] < a["m_temp"]) else "temp"
        ma, mb = a[f"m_{binding}"], b[f"m_{binding}"]
        frac = (-ma) / (mb - ma) if mb != ma else 1.0
        return a["t"] + (b["t"] - a["t"]) * frac, binding

    i0, i1 = best
    if i0 > 0:
        start, start_by = edge(i0 - 1, i0)
    else:
        start, start_by = samples[i0]["t"], "data"
    if i1 < len(samples) - 1:
        end, end_by = edge(i1 + 1, i1)
    else:
        end, end_by = samples[i1]["t"], "data"

    # Clip to nominal EVA duration, centered on the highest Sun inside the run
    nominal = timedelta(hours=th["eva_nominal_hours"])
    if end - start > nominal:
        peak = max(samples[i0:i1 + 1], key=lambda s: s["sun_el"])["t"]
        s = min(max(peak - nominal / 2, start), end - nominal)
        if s > start:
            start_by = "nominal"
        if s + nominal < end:
            end_by = "nominal"
        start, end = s, s + nominal

    label = {
        "sun": f"Sun elevation {min_el:g} deg",
        "temp": f"temperature {min_t:g} C",
        "nominal": f"{th['eva_nominal_hours']:g} h nominal EVA",
        "data": "end of sun.json data",
    }
    reason = (f"Start limited by {label[start_by]}; end limited by {label[end_by]}. "
              f"Rule: sun_el >= {min_el:g} deg and temp >= {min_t:g} C ({temp_note}).")
    return {
        "start_lmst": fmt_hm(mars_sun(start, lon, 0.0)["lmst_h"]),
        "end_lmst": fmt_hm(mars_sun(end, lon, 0.0)["lmst_h"]),
        "reason": reason,
        "start_utc": start.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "end_utc": end.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "duration_min": round((end - start).total_seconds() / 60),
        "temp_source": temp_src,
    }


def main() -> None:
    out = build()
    OUT_JSON.parent.mkdir(parents=True, exist_ok=True)
    OUT_JSON.write_text(json.dumps(out, indent=1), encoding="utf-8")
    print(f"wrote: {OUT_JSON.relative_to(ROOT)} - {out['start_lmst']}-{out['end_lmst']} LMST, "
          f"{out['duration_min']} min")
    print(out["reason"])


if __name__ == "__main__":
    main()
