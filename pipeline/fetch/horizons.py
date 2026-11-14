"""JPL Horizons -> web/data/sun.json

From the habitat (Mars surface), over 1 sol at a 10 min step:
  Sun az/el, Earth el, Earth->Mars one-way light time; LMST from Mars24.

Run:  python -m pipeline.fetch.horizons
Raw API responses are cached in data/cache/horizons_*.json and never re-fetched.
If Horizons is unreachable, Sun angles fall back to the Mars24 analytic model
(plan B) and earth_el / light_time_min are written as null.
"""
from __future__ import annotations

import hashlib
import json
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

from science.eva.lmst import fmt_hm, mars_sun

ROOT = Path(__file__).resolve().parents[2]
CACHE_DIR = ROOT / "data" / "cache"
AREA_JSON = ROOT / "web" / "data" / "area.json"
OUT_JSON = ROOT / "web" / "data" / "sun.json"

API = "https://ssd.jpl.nasa.gov/api/horizons.api"

# Team decision: 1 sol (24h40m) starting 2026-11-15 00:00 UTC, 10 min step
START_UTC = datetime(2026, 11, 15, 0, 0, tzinfo=timezone.utc)
SPAN = timedelta(hours=24, minutes=40)
STEP_MIN = 10

# Fallback habitat when area.json is missing (team decision)
FALLBACK_HABITAT = (137.39, -4.80)  # [lon_east, lat]


def load_habitat() -> tuple[float, float, str]:
    try:
        area = json.loads(AREA_JSON.read_text(encoding="utf-8"))
        lon, lat = area["habitat"]
        return float(lon), float(lat), "area.json"
    except (OSError, KeyError, ValueError, TypeError) as exc:
        print(f"WARNING: could not read area.json ({exc}); using fallback habitat {FALLBACK_HABITAT}",
              file=sys.stderr)
        return FALLBACK_HABITAT[0], FALLBACK_HABITAT[1], "fallback"


def _q(v: str) -> str:
    return f"'{v}'"


def horizons_query(target: str, quantities: str, lon: float, lat: float) -> dict:
    stop = START_UTC + SPAN
    params = {
        "format": "json",
        "COMMAND": _q(target),
        "OBJ_DATA": "NO",
        "MAKE_EPHEM": "YES",
        "EPHEM_TYPE": "OBSERVER",
        "CENTER": _q("coord@499"),
        "COORD_TYPE": _q("GEODETIC"),
        # Mars is west-positive in IAU: Horizons wants east longitude as a negative number
        "SITE_COORD": _q(f"{-lon},{lat},0"),
        "START_TIME": _q(START_UTC.strftime("%Y-%m-%d %H:%M")),
        "STOP_TIME": _q(stop.strftime("%Y-%m-%d %H:%M")),
        "STEP_SIZE": _q(f"{STEP_MIN} m"),
        "QUANTITIES": _q(quantities),
        "ANG_FORMAT": "DEG",
        "APPARENT": "AIRLESS",
        "CSV_FORMAT": "YES",
        "TIME_DIGITS": "MINUTES",
    }
    key = hashlib.sha1(json.dumps(params, sort_keys=True).encode()).hexdigest()[:12]
    cache = CACHE_DIR / f"horizons_{target}_{key}.json"
    if cache.exists():
        print(f"cache: {cache.relative_to(ROOT)}")
        return json.loads(cache.read_text(encoding="utf-8"))

    url = API + "?" + urllib.parse.urlencode(params)
    print(f"Horizons request: target={target}")
    with urllib.request.urlopen(url, timeout=120) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    if "error" in data or "$$SOE" not in data.get("result", ""):
        raise RuntimeError(f"Horizons error: {data.get('error') or data.get('result', '')[:500]}")
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cache.write_text(json.dumps(data), encoding="utf-8")
    return data


def parse_csv(result: str) -> list[dict]:
    """Turn the $$SOE/$$EOE block into dicts keyed by the header column names."""
    lines = result.splitlines()
    soe = lines.index("$$SOE")
    eoe = lines.index("$$EOE")
    header_line = next(l for l in reversed(lines[:soe]) if "Date__(UT)" in l)
    header = [h.strip() for h in header_line.split(",")]
    rows = []
    for line in lines[soe + 1:eoe]:
        cells = [c.strip() for c in line.split(",")]
        rows.append(dict(zip(header, cells)))
    return rows


def _col(row: dict, prefix: str) -> float:
    for k, v in row.items():
        if k.startswith(prefix):
            return float(v)
    raise KeyError(prefix)


def build() -> dict:
    lon, lat, habitat_src = load_habitat()
    n = int(SPAN.total_seconds() // 60 // STEP_MIN) + 1
    times = [START_UTC + timedelta(minutes=STEP_MIN * i) for i in range(n)]

    try:
        sun = parse_csv(horizons_query("10", "4", lon, lat)["result"])
        earth = parse_csv(horizons_query("399", "4,21", lon, lat)["result"])
        if len(sun) != n or len(earth) != n:
            raise RuntimeError(f"row count mismatch: sun={len(sun)} earth={len(earth)} expected={n}")
        source = "JPL Horizons (airless apparent az/el) + Mars24 LMST"
    except Exception as exc:  # noqa: BLE001 - network/API failure -> plan B
        print(f"WARNING: Horizons unavailable ({exc}); using Mars24 analytic plan B", file=sys.stderr)
        sun = earth = None
        source = "Mars24 analytic (Allison & McEwen 2000) - Horizons unavailable"

    rows = []
    for i, t in enumerate(times):
        m = mars_sun(t, lon, lat)
        if sun is not None:
            sun_az, sun_el = _col(sun[i], "Azi"), _col(sun[i], "Elev")
            earth_el = round(_col(earth[i], "Elev"), 2)
            lt = round(_col(earth[i], "1-way"), 2)
        else:
            sun_az, sun_el = m["sun_az_deg"], m["sun_el_deg"]
            earth_el = lt = None
        rows.append({
            "utc": t.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "lmst": fmt_hm(m["lmst_h"]),
            "sun_az": round(sun_az, 2),
            "sun_el": round(sun_el, 2),
            "earth_el": earth_el,
            "light_time_min": lt,
        })

    return {
        "source": source,
        "observer": {"lon": lon, "lat": lat, "from": habitat_src},
        "step_min": STEP_MIN,
        "rows": rows,
    }


def main() -> None:
    out = build()
    OUT_JSON.parent.mkdir(parents=True, exist_ok=True)
    OUT_JSON.write_text(json.dumps(out, indent=1), encoding="utf-8")
    print(f"wrote: {OUT_JSON.relative_to(ROOT)} ({len(out['rows'])} rows) - {out['source']}")


if __name__ == "__main__":
    main()
