"""HUD alert rules -> web/data/alerts.json

Every threshold comes from config/mission.json. Rules only use metrics, ops and levels that
the HUD evaluates (web/js/hud/index.js `metrics`, web/js/hud/model.js `OPS` and alert CSS);
the script refuses to write a rule that the HUD would silently ignore.

Run:  python -m science.alerts
"""
from __future__ import annotations

import sys

from pipeline.common import WEB_DATA, load_mission, write_json

# What the HUD supports today (read from web/js/hud/, keep in sync with Serdar's code)
HUD_METRICS = {
    "o2_remaining_pct": (int, float), "o2_used_pct": (int, float), "dose_mSv": (int, float),
    "slope_deg": (int, float), "max_slope_deg": (int, float), "comm_ok": (bool,),
    "shelter_min": (int, float), "eva_remaining_min": (int, float), "elapsed_min": (int, float),
    "sun_el": (int, float), "earth_el": (int, float), "light_time_min": (int, float),
    "radiation_status": (str,), "eva_state": (str,), "at_habitat": (bool,),
}
HUD_OPS = {"<", "<=", ">", ">=", "==", "!="}
LEVELS = {"info", "warn", "danger"}          # docs/contracts.md

OUT_JSON = WEB_DATA / "alerts.json"


def build(m: dict) -> list[dict]:
    reserve = m["o2_reserve_pct"]
    turn_back = reserve + m["o2_return_margin_pct"]
    rule = lambda id_, metric, op, value, level, text: {
        "id": id_, "metric": metric, "op": op, "value": value, "level": level, "text": text}
    return [
        rule("slope_warn", "slope_deg", ">=", m["slope_warn_deg"], "warn",
             "Steep ground. Slow down and check your footing."),
        rule("slope_max", "slope_deg", ">=", m["slope_max_deg"], "danger",
             "Slope over the limit. Stop and back off to flatter ground."),
        rule("o2_turn_back", "o2_remaining_pct", "<=", turn_back, "warn",
             f"O2 at {turn_back}%. Start heading back to the habitat."),
        rule("o2_reserve", "o2_remaining_pct", "<=", reserve, "danger",
             "O2 reserve reached. Return to the habitat now."),
        rule("radiation_elevated", "radiation_status", "==", "elevated", "warn",
             "Space weather alert. Keep stops short and stay near a shelter."),
        rule("radiation_storm", "radiation_status", "==", "storm", "danger",
             "Solar storm. Go to the nearest shelter now."),
        rule("dose_warn", "dose_mSv", ">=", m["eva_dose_warn_mSv"], "warn",
             f"EVA dose over {m['eva_dose_warn_mSv']} mSv. Cut the remaining stops short."),
        rule("comm_lost", "comm_ok", "==", False, "warn",
             "Radio shadow. No link to the habitat; stay on the planned route."),
        rule("eva_ending", "eva_remaining_min", "<=", m["eva_end_warn_min"], "warn",
             f"EVA window closes in {m['eva_end_warn_min']} min. Head back to the habitat."),
    ]


def validate(rules: list[dict]) -> list[str]:
    problems = []
    for r in rules:
        if r["metric"] not in HUD_METRICS:
            problems.append(f"{r['id']}: metric {r['metric']} is not computed by the HUD")
        elif not isinstance(r["value"], HUD_METRICS[r["metric"]]) or (
                isinstance(r["value"], bool) and bool not in HUD_METRICS[r["metric"]]):
            problems.append(f"{r['id']}: value {r['value']!r} has the wrong type for {r['metric']}")
        if r["op"] not in HUD_OPS:
            problems.append(f"{r['id']}: op {r['op']} is not supported by the HUD")
        if r["level"] not in LEVELS:
            problems.append(f"{r['id']}: level {r['level']} is not in docs/contracts.md")
    return problems


def main() -> int:
    rules = build(load_mission())
    problems = validate(rules)
    if problems:
        for p in problems:
            print("ERROR:", p, file=sys.stderr)
        return 1
    write_json(OUT_JSON, {"rules": rules, "source": "config/mission.json"})
    for r in rules:
        print(f"{r['level']:6s} {r['metric']} {r['op']} {r['value']!r:10}  {r['text']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
