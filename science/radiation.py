"""web/data/donki.json + config/mission.json -> web/data/radiation.json

Top-level fields follow donki.json's mode:
- live: status = elevated if a WSA-ENLIL Mars arrival (CME `mars_arrival`) falls within
  +/- rad_event_window_h of now, otherwise nominal. The live dose is not quantified, so
  event_multiplier stays 1.0.
- replay: the same values as the `replay` block below.

The `replay` block (20 May 2024 storm) is always written, so the demo can switch to it:
event_multiplier = replay_event_dose_mGy / rad_base_mGy_per_day, i.e. the event's absorbed
dose (RAD) over RAD's mean daily absorbed dose. Both are Gy, so the ratio has no unit; it
treats the event dose as arriving over one day and assumes the event's quality factor equals
the background's (likely an overestimate). Mars arrivals come from the cached replay data in
data/cache/donki/ (no network); run python -m pipeline.fetch.donki first to fill the cache.

Gy values are reported in their own *_mGy fields and are never added to mSv values.
Run:  python -m science.radiation
"""
from __future__ import annotations

import json
import sys
from datetime import datetime, timedelta, timezone

from pipeline.common import WEB_DATA, load_mission, write_json
from pipeline.fetch.donki import REPLAY_DATE, cached_replay_events

DONKI_JSON = WEB_DATA / "donki.json"
OUT_JSON = WEB_DATA / "radiation.json"
UTC_FMT = "%Y-%m-%dT%H:%M:%SZ"


def parse_utc(s: str | None) -> datetime | None:
    try:
        return datetime.strptime(s, UTC_FMT).replace(tzinfo=timezone.utc)
    except (TypeError, ValueError):
        return None


def mars_arrivals(events: list[dict]) -> list[str]:
    return sorted({e["mars_arrival"] for e in events
                   if e.get("type") == "CME" and e.get("mars_impact") and e.get("mars_arrival")})


def replay_block(mission: dict, events: list[dict] | None) -> dict:
    event_mGy = mission["replay_event_dose_mGy"]
    bg_mGy_day = mission["rad_base_mGy_per_day"]
    mult = round(event_mGy / bg_mGy_day, 1)
    return {
        "date": REPLAY_DATE.isoformat(),
        "status": "storm",
        "event_multiplier": mult,
        "message": f"Replay of the {REPLAY_DATE:%d %B %Y} solar storm: dose rate x{mult}. Stay close to shelter.",
        "event_dose_mGy": event_mGy,
        "duration_min": mission["storm_duration_min"],
        "habitat_dose_factor": mission["habitat_dose_factor"],
        "background_mGy_per_day": bg_mGy_day,
        "mars_arrivals_wsa_enlil": mars_arrivals(events) if events is not None else None,
        "basis": ("event absorbed dose / mean daily absorbed dose (both mGy, Curiosity RAD); "
                  "event spread over one day, same quality factor as background (conservative)"),
    }


def live_fields(mission: dict, donki: dict, now: datetime) -> dict:
    window = timedelta(hours=mission["rad_event_window_h"])
    arrivals = sorted(
        (t, e["id"]) for e in donki.get("events", [])
        if e.get("type") == "CME" and e.get("mars_impact")
        for t in [parse_utc(e.get("mars_arrival"))] if t and abs(t - now) <= window
    )
    out = {"event_multiplier": 1.0, "status": "nominal", "message": "Background GCR only.",
           "mars_arrivals_in_window": [{"utc": t.strftime(UTC_FMT), "cme": cid} for t, cid in arrivals]}
    if arrivals:
        t, _ = arrivals[-1]
        when = "expected" if t > now else "arrived"
        out["status"] = "elevated"
        out["message"] = (f"CME {when} at Mars {t:%d %b %H:%M} UTC (WSA-ENLIL). "
                          "Dose not quantified; background rate shown.")
    return out


def build(mission: dict, donki: dict | None, replay_events: list[dict] | None, now: datetime) -> dict:
    replay = replay_block(mission, replay_events)
    out = {"base_mSv_per_day": mission["rad_base_mSv_per_day"], "event_multiplier": 1.0,
           "status": "nominal", "message": "Background GCR only.", "mode": None,
           "source": "config/mission.json"}
    if donki is None:
        out["message"] = "Background GCR only (no space weather data)."
    elif donki.get("mode") == "replay":
        out.update({"mode": "replay", "source": "config/mission.json + web/data/donki.json",
                    **{k: replay[k] for k in ("status", "event_multiplier", "message")}})
    else:
        out.update({"mode": donki.get("mode"), "source": "config/mission.json + web/data/donki.json",
                    **live_fields(mission, donki, now)})
    out["replay"] = replay
    return out


def main() -> int:
    mission = load_mission()
    try:
        donki = json.loads(DONKI_JSON.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        print(f"WARNING: could not read {DONKI_JSON.name} ({exc}); background only", file=sys.stderr)
        donki = None
    if donki is not None and (donki.get("mock") or donki.get("source") == "MOCK"):
        print("WARNING: donki.json is still the mock; run python -m pipeline.fetch.donki first", file=sys.stderr)
    replay_events = cached_replay_events()
    if replay_events is None:
        print("WARNING: no cached replay data in data/cache/donki/; replay block without Mars arrivals",
              file=sys.stderr)
    out = build(mission, donki, replay_events, datetime.now(timezone.utc))
    write_json(OUT_JSON, out)
    print(f"mode={out['mode']} status={out['status']} event_multiplier={out['event_multiplier']}")
    print(f"message: {out['message']}")
    r = out["replay"]
    print(f"replay: status={r['status']} event_multiplier={r['event_multiplier']} "
          f"event_dose_mGy={r['event_dose_mGy']} mars_arrivals={r['mars_arrivals_wsa_enlil']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
