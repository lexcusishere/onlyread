"""Turn a labels sheet into a verdict-cache import for the extension's options page.

    python3 harness/site/labels_to_cache.py apps/linear/labels.jsonl [--out apps/linear/cache.json]

read → allow, telemetry → allow, write → block. URL-shaped telemetry can also go in
policy.telemetryAllow; body-shaped telemetry (form:tshe=…, json[]:…) needs the cache. Static assets and safe GETs are left out too, the
rules layer already decides them. The result is the allowlist built from the site's labels that lets
enforce mode run on a system before (or instead of) a judge.
"""
from __future__ import annotations

import argparse
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "lib"))  # shared harness modules
from common import read_jsonl
from evaluate import gray_zone


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("labels", type=pathlib.Path)
    ap.add_argument("--out", type=pathlib.Path)
    a = ap.parse_args(argv)
    out: dict[str, dict] = {}
    for r in read_jsonl(a.labels):
        if not gray_zone(r) and r["label"] != "telemetry":
            continue  # rules decide safe GETs; body-shaped telemetry needs an allow verdict
        out[r["fingerprint"]] = {"verdict": "allow" if r["label"] in ("read", "telemetry") else "block", "note": r.get("note", "")}
    dest = a.out or a.labels.with_name(a.labels.stem.replace("labels", "cache") + ".json")
    dest.write_text(json.dumps(out, indent=1) + "\n")
    allows = sum(1 for v in out.values() if v["verdict"] == "allow")
    print(f"{len(out)} verdicts ({allows} allow, {len(out) - allows} block) → {dest}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
