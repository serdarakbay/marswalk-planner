"""REMS air temperature -> typical diurnal curve for the EVA sol.

Owner: Egemen (branch `veri`)

Run:   python -m pipeline.fetch.rems [--refresh] [--sols 30] [--step-min 30]
Out:   web/data/weather.json  {rows:[{lmst, temp_c}], ...metadata}

Source: REMS daily summary feed (Centro de Astrobiologia / NASA-JPL),
        mars.nasa.gov/rss/api/?feed=weather&category=msl
The feed only has daily min/max (no hourly values; hourly RDRs live in PDS
and are too heavy for the hackathon). So:
  1. take the median min/max air temperature and sunrise/sunset (LMST) of
     the latest N valid sols  -> REAL measurements
  2. shape the day with the Parton & Logan (1981) model: sine during
     daylight (peak lagged after noon), exponential cooling at night
     -> MODEL, therefore the file is tagged "approximate": true.

Only the Python standard library is used.
"""
from __future__ import annotations

import argparse
import json
import math
import statistics
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CACHE = ROOT / "data" / "cache" / "rems"
OUT = ROOT / "web" / "data" / "weather.json"

FEED_URL = "https://mars.nasa.gov/rss/api/?feed=weather&category=msl&feedtype=json"
USER_AGENT = "martian-map-pipeline/1.0"

# Diurnal model parameters (documented assumptions, see docs/story/assumptions.md)
PEAK_LMST_H = 13.5      # air temperature peak at Gale is early afternoon (REMS)
NIGHT_DECAY_PER_H = 0.35  # night-time cooling rate, shapes the exponential tail


def log(msg: str) -> None:
    print(f"[rems] {msg}", flush=True)


def fetch_feed(refresh: bool) -> dict:
    cache_file = CACHE / "msl_weather.json"
    if cache_file.exists() and not refresh:
        return json.loads(cache_file.read_text())
    req = urllib.request.Request(FEED_URL, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=90) as r:
        raw = r.read()
    cache_file.parent.mkdir(parents=True, exist_ok=True)
    cache_file.write_bytes(raw)
    return json.loads(raw)


def hhmm_to_h(s: str) -> float:
    h, m = s.split(":")
    return int(h) + int(m) / 60


def h_to_hhmm(h: float) -> str:
    total = int(round(h * 60)) % (24 * 60)
    return f"{total // 60:02d}:{total % 60:02d}"


def as_num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def latest_valid(soles: list[dict], n: int) -> list[dict]:
    out = []
    for s in sorted(soles, key=lambda s: int(s["sol"]), reverse=True):
        if None in (as_num(s.get("min_temp")), as_num(s.get("max_temp"))):
            continue
        if not (s.get("sunrise") or "").count(":") or not (s.get("sunset") or "").count(":"):
            continue
        out.append(s)
        if len(out) >= n:
            break
    return out


def diurnal(t: float, tmin: float, tmax: float, sunrise: float, sunset: float) -> float:
    """Parton-Logan: T(t) for t in LMST hours [0, 24)."""
    day_len = sunset - sunrise
    # lag a such that the sine peaks at PEAK_LMST_H: sunrise + (D + 2a)/2 = peak
    a = max(0.0, (PEAK_LMST_H - sunrise) - day_len / 2)
    period = day_len + 2 * a

    def day_temp(x):
        return tmin + (tmax - tmin) * math.sin(math.pi * (x - sunrise) / period)

    if sunrise <= t <= sunset:
        return day_temp(t)
    # night: from sunset temperature decay towards tmin at next sunrise
    t_set = day_temp(sunset)
    night_len = 24 - day_len
    n = (t - sunset) % 24
    b = NIGHT_DECAY_PER_H
    frac = (math.exp(-b * n) - math.exp(-b * night_len)) / (1 - math.exp(-b * night_len))
    return tmin + (t_set - tmin) * frac


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--refresh", action="store_true", help="re-download the REMS feed")
    ap.add_argument("--sols", type=int, default=30, help="number of latest valid sols to average (default 30)")
    ap.add_argument("--step-min", type=int, default=30, help="curve resolution in LMST minutes (default 30)")
    args = ap.parse_args()

    feed = fetch_feed(args.refresh)
    sols = latest_valid(feed["soles"], args.sols)
    if not sols:
        raise SystemExit("[rems] ERROR: no valid sols in the REMS feed")

    med = lambda key: statistics.median(as_num(s[key]) for s in sols)  # noqa: E731
    tmin, tmax = med("min_temp"), med("max_temp")
    sunrise = statistics.median(hhmm_to_h(s["sunrise"]) for s in sols)
    sunset = statistics.median(hhmm_to_h(s["sunset"]) for s in sols)
    gts = [s for s in sols if as_num(s.get("min_gts_temp")) is not None and as_num(s.get("max_gts_temp")) is not None]

    rows = []
    for i in range(0, 24 * 60, args.step_min):
        t = i / 60
        rows.append({"lmst": h_to_hhmm(t), "temp_c": round(diurnal(t, tmin, tmax, sunrise, sunset), 1)})

    sol_nums = [int(s["sol"]) for s in sols]
    out = {
        "rows": rows,
        "approximate": True,
        "label": "Typical sol (approximate): REMS min/max, modelled diurnal shape",
        "min_c": round(tmin, 1),
        "max_c": round(tmax, 1),
        "ground_min_c": round(statistics.median(as_num(s["min_gts_temp"]) for s in gts), 1) if gts else None,
        "ground_max_c": round(statistics.median(as_num(s["max_gts_temp"]) for s in gts), 1) if gts else None,
        "sunrise_lmst": h_to_hhmm(sunrise),
        "sunset_lmst": h_to_hhmm(sunset),
        "sols": [min(sol_nums), max(sol_nums)],
        "ls_deg": as_num(sols[0].get("ls")),
        "method": f"median of {len(sols)} latest REMS sols; Parton-Logan diurnal model "
                  f"(peak {h_to_hhmm(PEAK_LMST_H)} LMST, night decay {NIGHT_DECAY_PER_H}/h)",
        "source": "REMS, Centro de Astrobiologia (CSIC-INTA) / NASA/JPL-Caltech",
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, indent=1))
    log(f"sols {min(sol_nums)}-{max(sol_nums)}: air {tmin:.0f}..{tmax:.0f} C, "
        f"sunrise {h_to_hhmm(sunrise)} sunset {h_to_hhmm(sunset)} LMST -> wrote {OUT.relative_to(ROOT)} ({len(rows)} rows)")


if __name__ == "__main__":
    main()
