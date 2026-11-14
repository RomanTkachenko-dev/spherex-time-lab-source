"""Check a laboratory track against JPL predictions from the spacecraft.

Pass a JSON mapping frame IDs to {"source": "...", "utc": "...",
"xobs": [x,y,z,vx,vy,vz]} from an independent spacecraft ephemeris.
Positions/velocities must be geocentric ICRF, km and km/s. Supply the
state at each exposure midpoint, with the exact UTC string in the report.
"""
import argparse
import json
from pathlib import Path

import numpy as np
import requests
from astropy.coordinates import SkyCoord
from astropy import units as u

API = "https://ssd-api.jpl.nasa.gov/sb_ident.api"
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("report", type=Path)
parser.add_argument("states", type=Path)
parser.add_argument("track", type=int, help="One-based trajectory number")
args = parser.parse_args()
report = json.loads(args.report.read_text(encoding="utf8"))
states = json.loads(args.states.read_text(encoding="utf8"))
track = report["tracks"][args.track - 1] if 1 <= args.track <= len(report["tracks"]) else None
if not track:
    parser.error("Invalid track number")
evidence, common = [], None
for detection in track["detections"]:
    frame = report["frames"][detection["frame"]]
    point = frame["detections"][detection["detection"]]
    state = states.get(frame["id"], {})
    vector = state.get("xobs", [])
    if len(vector) != 6 or not np.isfinite(vector).all() or state.get("utc") != frame["date"] or not state.get("source"):
        parser.error(f"Missing verified spacecraft state at the UTC midpoint of {frame['id']}")
    target = SkyCoord(point["ra"] * u.deg, point["dec"] * u.deg)
    ra = target.ra.to_string(unit=u.hourangle, sep="-", pad=True, precision=4)
    dec = target.dec.to_string(sep="-", pad=True, alwayssign=True, precision=3)
    response = requests.get(API, params={"xobs": ",".join(map(str, vector)), "obs-time": frame["date"],
        "fov-ra-center": ra, "fov-dec-center": dec, "fov-ra-hwidth": 0.03,
        "fov-dec-hwidth": 0.03, "two-pass": "true", "suppress-first-pass": "true",
        "mag-required": "false", "req-elem": "false"}, timeout=90)
    response.raise_for_status()
    result = response.json()
    count = result.get("n_second_pass")
    rows = result.get("data_second_pass", [])
    if not isinstance(count, int) or count != len(rows):
        raise ValueError(f"Incomplete JPL result for {frame['id']}")
    hits = {}
    if rows:
        fields = result["fields_second"]
        name = fields.index("Object name")
        rai = next(i for i, field in enumerate(fields) if field.startswith("Astrometric RA"))
        dei = next(i for i, field in enumerate(fields) if field.startswith("Astrometric Dec"))
        for row in rows:
            position = SkyCoord(row[rai], row[dei], unit=(u.hourangle, u.deg))
            distance = float(target.separation(position).arcsec)
            if distance <= 3:
                hits[row[name]] = distance
    common = set(hits) if common is None else common & hits.keys()
    evidence.append({"frame": frame["id"], "state_source": state["source"],
                     "query": response.url, "matches_arcsec": hits, "response": result})

epochs = len({report["frames"][d["frame"]]["mjd"] for d in track["detections"]})
print(json.dumps({"track": args.track, "epochs": epochs,
    "possible_associations": sorted(common or []) if epochs >= 3 else [],
    "complete": epochs >= 3, "radius_arcsec": 3, "evidence": evidence,
    "limits": "Positional screening within the requested field; dependent on the supplied spacecraft state, catalogue coverage and orbit uncertainties."}, indent=2))
