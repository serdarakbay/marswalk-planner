"""NASA DONKI space weather events -> web/data/donki.json

Fetches FLR, CME and SEP events for the last --days days (live) and for the replay scenario
(20 May 2024, +/- --replay-pad-days). WSA-ENLIL simulations decide `mars_impact`:

- CME: true if any WSA-ENLIL run for it (embedded in the CME record or from the
  WSAEnlilSimulations endpoint, matched by CMEID) lists "Mars" in its impactList.
- FLR / SEP: true if they are linked (linkedEvents, either direction) to such a CME.
- Anything else: false. Nothing is inferred beyond this.

The FLR endpoint can be unavailable (it returns HTTP 404 on api.nasa.gov at the time of
writing). Flares are then taken from the activity IDs in linkedEvents of the CME and SEP
records; their start time comes from the ID and `peak` is null.

Mode: live if the live window has any event, otherwise replay (override with --mode).

Run:  python -m pipeline.fetch.donki [--mode auto|live|replay] [--refresh]
API key: NASA_API_KEY from the environment or .env (never from code); DEMO_KEY otherwise.
Raw responses are cached in data/cache/donki/.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from datetime import date, datetime, timedelta, timezone

import requests

from pipeline.common import CACHE, ROOT, WEB_DATA, write_json

API = "https://api.nasa.gov/DONKI/"
CACHE_DIR = CACHE / "donki"
OUT_JSON = WEB_DATA / "donki.json"
REPLAY_DATE = date(2024, 5, 20)   # replay scenario fixed in CLAUDE.md
DEFAULT_LIVE_DAYS = 30
DEFAULT_REPLAY_PAD_DAYS = 3
TIMEOUT_S = 90


# --- API key ----------------------------------------------------------------------------------

def api_key() -> str:
    try:
        from dotenv import load_dotenv
        load_dotenv(ROOT / ".env")
    except ImportError:
        env = ROOT / ".env"
        if env.exists() and "NASA_API_KEY" not in os.environ:
            for line in env.read_text(encoding="utf-8").splitlines():
                if line.strip().startswith("NASA_API_KEY="):
                    os.environ["NASA_API_KEY"] = line.split("=", 1)[1].strip().strip('"').strip("'")
    key = os.environ.get("NASA_API_KEY", "").strip()
    if not key or key == "DEMO_KEY":
        print("WARNING: NASA_API_KEY not set in .env; using DEMO_KEY (low rate limit)", file=sys.stderr)
        return "DEMO_KEY"
    return key


def redact(text: str, key: str) -> str:
    text = re.sub(r"api_key=[^&\s'\"]+", "api_key=***", text)
    return text.replace(key, "***") if key else text


# --- Fetch with cache -------------------------------------------------------------------------

def fetch(endpoint: str, start: date, end: date, key: str, refresh: bool):
    """Return the parsed list for one endpoint and date range, or None if it failed."""
    path = CACHE_DIR / f"{endpoint}_{start}_{end}.json"
    if path.exists() and not refresh:
        return json.loads(path.read_text(encoding="utf-8"))
    params = {"startDate": start.isoformat(), "endDate": end.isoformat(), "api_key": key}
    try:
        r = requests.get(API + endpoint, params=params, timeout=TIMEOUT_S)
    except requests.RequestException as exc:
        print(f"WARNING: {endpoint} {start}..{end}: {redact(str(exc), key)}", file=sys.stderr)
        return None
    if r.status_code != 200:
        print(f"WARNING: {endpoint} {start}..{end}: HTTP {r.status_code}", file=sys.stderr)
        return None
    data = r.json() if r.text.strip() else []   # DONKI returns an empty body for "no events"
    if not isinstance(data, list):
        print(f"WARNING: {endpoint} {start}..{end}: unexpected response", file=sys.stderr)
        return None
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    return data


# --- Normalisation ----------------------------------------------------------------------------

def iso_utc(t: str | None) -> str | None:
    """DONKI '2024-05-17T00:12Z' or '2024-05-17T00:12:00' -> '2024-05-17T00:12:00Z'."""
    if not t:
        return None
    m = re.match(r"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(:\d{2})?", t)
    return f"{m.group(1)}{m.group(2) or ':00'}Z" if m else None


def id_time(activity_id: str) -> str | None:
    """Start time encoded in a DONKI activity ID, e.g. '2024-05-17T20:33:00-FLR-001'."""
    return iso_utc(activity_id.split("-FLR-")[0].split("-CME-")[0].split("-SEP-")[0])


def links(rec: dict) -> set[str]:
    return {l["activityID"] for l in (rec.get("linkedEvents") or []) if l.get("activityID")}


def mars_arrivals(impact_lists) -> list[dict]:
    return [i for lst in impact_lists for i in (lst or []) if i.get("location") == "Mars"]


def build_events(flr, cme, sep, sims, start: date, end: date) -> tuple[list[dict], list[str]]:
    notes = []
    sims = sims or []

    # CME -> Mars arrivals from embedded enlilList and from WSAEnlilSimulations (by CMEID)
    by_cme: dict[str, list[dict]] = {}
    for s in sims:
        arrivals = mars_arrivals([s.get("impactList")])
        for inp in s.get("cmeInputs") or []:
            cid = inp.get("CMEID") or inp.get("cmeid")
            if cid and arrivals:
                by_cme.setdefault(cid, []).extend(arrivals)
    cme_mars: dict[str, list[dict]] = {}
    for c in cme or []:
        embedded = [e.get("impactList") for a in (c.get("cmeAnalyses") or []) for e in (a.get("enlilList") or [])]
        cme_mars[c["activityID"]] = mars_arrivals(embedded) + by_cme.get(c["activityID"], [])
    mars_cmes = {cid for cid, arr in cme_mars.items() if arr}

    def linked_to_mars(rec_id: str, rec_links: set[str]) -> bool:
        if rec_links & mars_cmes:
            return True
        return any(rec_id in links(c) for c in (cme or []) if c["activityID"] in mars_cmes)

    events = []
    for c in cme or []:
        arr = cme_mars[c["activityID"]]
        times = sorted(t for t in (iso_utc(a.get("arrivalTime")) for a in arr) if t)
        events.append({"type": "CME", "start": iso_utc(c.get("startTime")), "peak": None,
                       "mars_impact": bool(arr), "id": c["activityID"],
                       "mars_arrival": times[0] if times else None,
                       "mars_glancing": all(a.get("isGlancingBlow") for a in arr) if arr else None,
                       "link": c.get("link")})

    for s in sep or []:
        events.append({"type": "SEP", "start": iso_utc(s.get("eventTime")), "peak": None,
                       "mars_impact": linked_to_mars(s["sepID"], links(s)), "id": s["sepID"],
                       "instruments": [i.get("displayName") for i in (s.get("instruments") or [])],
                       "link": s.get("link")})

    if flr is not None:
        for f in flr:
            events.append({"type": "FLR", "start": iso_utc(f.get("beginTime")), "peak": iso_utc(f.get("peakTime")),
                           "mars_impact": linked_to_mars(f["flrID"], links(f)), "id": f["flrID"],
                           "class": f.get("classType"), "link": f.get("link")})
    else:
        notes.append("FLR endpoint unavailable; flares taken from linkedEvents of CME/SEP records "
                     "(start from the activity ID, peak unknown).")
        flare_ids = {a for rec in (cme or []) + (sep or []) for a in links(rec) if "-FLR-" in a}
        lo, hi = f"{start}T00:00:00Z", f"{end}T23:59:59Z"
        for fid in sorted(flare_ids):
            t = id_time(fid)
            if t and lo <= t <= hi:
                events.append({"type": "FLR", "start": t, "peak": None,
                               "mars_impact": linked_to_mars(fid, set()), "id": fid,
                               "from_linked_events": True})

    events = [e for e in events if e["start"]]
    events.sort(key=lambda e: (e["start"], e["type"]))
    return events, notes


def replay_window(pad_days: int = DEFAULT_REPLAY_PAD_DAYS) -> tuple[date, date, date]:
    """(start, end, end of the WSA-ENLIL query) for the replay scenario."""
    pad = timedelta(days=pad_days)
    return REPLAY_DATE - pad, REPLAY_DATE + pad, REPLAY_DATE + 2 * pad


def cached_replay_events(pad_days: int = DEFAULT_REPLAY_PAD_DAYS) -> list[dict] | None:
    """Replay events built from data/cache/donki/ only (no network). None if the cache is missing."""
    start, end, sims_end = replay_window(pad_days)

    def read(endpoint, s, e):
        path = CACHE_DIR / f"{endpoint}_{s}_{e}.json"
        return json.loads(path.read_text(encoding="utf-8")) if path.exists() else None

    cme, sep, sims = read("CME", start, end), read("SEP", start, end), read("WSAEnlilSimulations", start, sims_end)
    if cme is None or sims is None:
        return None
    events, _ = build_events(read("FLR", start, end), cme, sep or [], sims, start, end)
    return events


def collect(start: date, end: date, sims_end: date, key: str, refresh: bool) -> dict:
    flr = fetch("FLR", start, end, key, refresh)
    cme = fetch("CME", start, end, key, refresh)
    sep = fetch("SEP", start, end, key, refresh)
    sims = fetch("WSAEnlilSimulations", start, sims_end, key, refresh)
    failed = [n for n, v in (("CME", cme), ("SEP", sep), ("WSAEnlilSimulations", sims)) if v is None]
    events, notes = build_events(flr, cme, sep, sims, start, end)
    if failed:
        notes.append(f"Could not fetch: {', '.join(failed)}.")
    return {"window": {"start": start.isoformat(), "end": end.isoformat()}, "events": events,
            "notes": notes, "complete": not failed}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--mode", choices=("auto", "live", "replay"), default="auto")
    ap.add_argument("--days", type=int, default=DEFAULT_LIVE_DAYS, help="live window length")
    ap.add_argument("--replay-pad-days", type=int, default=DEFAULT_REPLAY_PAD_DAYS)
    ap.add_argument("--refresh", action="store_true", help="ignore the cache and download again")
    args = ap.parse_args()

    key = api_key()
    today = datetime.now(timezone.utc).date()
    live = None
    if args.mode in ("auto", "live"):
        live = collect(today - timedelta(days=args.days), today, today, key, args.refresh)
        print(f"live   {live['window']['start']}..{live['window']['end']}: {len(live['events'])} events")
    replay = collect(*replay_window(args.replay_pad_days), key, args.refresh)
    print(f"replay {replay['window']['start']}..{replay['window']['end']}: {len(replay['events'])} events")

    if args.mode == "live" or (args.mode == "auto" and live and live["events"]):
        mode, chosen = "live", live
    else:
        mode, chosen = "replay", replay
        if args.mode == "auto":
            print("Live window is empty or unavailable -> replay mode")

    out = {
        "mode": mode,
        "events": chosen["events"],
        "source": "NASA DONKI (api.nasa.gov); mars_impact from WSA-ENLIL impactList",
        "window": chosen["window"],
        "replay_date": REPLAY_DATE.isoformat(),
        "fetched_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "notes": chosen["notes"],
    }
    write_json(OUT_JSON, out)
    n_mars = sum(e["mars_impact"] for e in out["events"])
    print(f"mode={mode}: {len(out['events'])} events, {n_mars} with mars_impact")
    for n in out["notes"]:
        print("note:", n)
    return 0


if __name__ == "__main__":
    sys.exit(main())
