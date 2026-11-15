"""Science targets off the planned route -> web/data/targets.json

Extra places the crew can detour to during the walk (HUD "Targets" panel: can I go there?).

- A target is a rover position where Curiosity took the photos in images.json, like the stops
  (same `candidates()` as science/stops.py), so every target is a real, photographed place.
- The unit (clay, transition, sulfate) comes from the sol, with the boundaries of science/stops.py.
- Only positions inside the study area (area.json bbox) count.
- Positions closer than MIN_STOP_SPACING_M to a route stop are that stop, not a new target, and
  targets are at least that far from each other. Where two positions compete, the one with photos
  from more cameras wins, then the earlier sol.

Run:  python -m science.targets    (needs web/data/area.json, images.json and stops.json)
"""
from __future__ import annotations

import json
import sys

from pipeline.common import WEB_DATA, load_area, write_json
from science.stops import MIN_STOP_SPACING_M, UNITS, candidates, dist_m, pick_photos

UNIT_BY_KEY = {u["key"]: u for u in UNITS}


def read(name):
    path = WEB_DATA / name
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def build(images, stops, bbox):
    stop_coords = [s["coord"] for s in stops if s.get("coord")]
    ranked = []
    for c in candidates(images):
        lon, lat = c["coord"]
        if not (bbox["west"] <= lon <= bbox["east"] and bbox["south"] <= lat <= bbox["north"]):
            continue
        photos = pick_photos(c["coord"], images)
        ranked.append((-len(photos), c["sols"][0], c, photos))
    ranked.sort(key=lambda r: (r[0], r[1]))

    kept = []
    for _, _, c, photos in ranked:
        if any(dist_m(c["coord"], s) < MIN_STOP_SPACING_M for s in stop_coords):
            continue
        if any(dist_m(c["coord"], k["coord"]) < MIN_STOP_SPACING_M for k in kept):
            continue
        kept.append({**c, "photos": photos})

    kept.sort(key=lambda k: k["sols"][0])   # in the order Curiosity drove
    targets = []
    for i, k in enumerate(kept, start=1):
        sol = k["sols"][0]
        unit = UNIT_BY_KEY[k["unit"]]
        day = next((p["utc"][:10] for p in k["photos"] if p.get("utc")), None)
        when = f"sol {sol}" + (f" ({day})" if day else "")
        targets.append({
            "id": f"t{i}",
            "name": f"Curiosity site, sol {sol}",
            "unit": k["unit"],
            "coord": k["coord"],
            "sol": sol,
            "note": f"Curiosity photographed this spot on {when}. {unit['observe']} {unit['question']}",
            "photos": k["photos"],
        })
    return targets


def main() -> int:
    images = read("images.json")
    stops = read("stops.json")
    if not images:
        print("images.json not found or empty (Egemen: python -m pipeline.fetch.curiosity)", file=sys.stderr)
        return 1
    if stops is None:
        print("stops.json not found (python -m science.stops)", file=sys.stderr)
        return 1
    targets = build(images, stops, load_area()["bbox"])
    write_json(WEB_DATA / "targets.json", targets)
    by_unit = {}
    for t in targets:
        by_unit[t["unit"]] = by_unit.get(t["unit"], 0) + 1
    print(f"{len(targets)} targets: " + ", ".join(f"{n} {u}" for u, n in by_unit.items()))
    return 0


if __name__ == "__main__":
    sys.exit(main())
