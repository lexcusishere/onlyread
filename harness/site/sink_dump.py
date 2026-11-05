"""Pull the dev sink (/__audit on the fixture) into a session directory.

    python3 harness/site/sink_dump.py apps/<app>/sessions/<name> [--sink http://localhost:4173/__audit] [--domains localhost,127.0.0.1]

Writes decisions.jsonl, observations.jsonl, system.jsonl and session.json. Use for
sessions run in a real Chrome profile where the popup is not driven by the harness.
"""
from __future__ import annotations

import argparse
import json
import pathlib
import sys
import urllib.request

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "lib"))  # shared harness modules
from common import SESSION_FILES, split_sink, write_jsonl


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("session", type=pathlib.Path)
    ap.add_argument("--sink", default="http://localhost:4173/__audit")
    ap.add_argument("--server-log", default="http://localhost:4173/__log")
    ap.add_argument("--domains", default="localhost,127.0.0.1")
    ap.add_argument("--note", default="")
    ap.add_argument("--since", type=int, default=0, help="skip the first N sink entries (offset printed by the harness scripts)")
    ap.add_argument("--instance", help="keep only entries posted by this extension instance (ctl.py instances)")
    a = ap.parse_args(argv)

    rows = json.load(urllib.request.urlopen(a.sink))[a.since:]
    if a.instance:
        rows = [r for r in rows if r.get("instance") == a.instance]
    parts = split_sink(rows)
    a.session.mkdir(parents=True, exist_ok=True)
    for key in ("decisions", "observations", "system"):
        n = write_jsonl(a.session / SESSION_FILES[key], parts[key])
        print(f"{key}: {n}")
    try:
        (a.session / SESSION_FILES["server_log"]).write_text(json.dumps(json.load(urllib.request.urlopen(a.server_log)), indent=1))
        print("server log saved")
    except Exception as e:  # noqa: BLE001
        print(f"server log unavailable: {e}")
    (a.session / "session.json").write_text(json.dumps({
        "targetDomains": [d.strip() for d in a.domains.split(",") if d.strip()],
        "source": "dev-sink",
        "note": a.note,
    }, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
