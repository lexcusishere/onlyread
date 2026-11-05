"""Parse a Chrome NetLog (--log-net-log) into JSONL of {ts, method, url} per URL request.

Ground truth #2: independent of the extension. Handles files truncated by an unclean exit.

    python3 harness/site/netlog.py apps/<app>/sessions/<name>/netlog.json [--out apps/<app>/sessions/<name>/netlog.jsonl]
"""
from __future__ import annotations

import argparse
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "lib"))  # shared harness modules
from common import write_jsonl


def load_netlog(path: pathlib.Path) -> dict:
    text = path.read_text(errors="replace")
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        # Chrome writes the closing brackets only on clean shutdown. Repair by cutting at the last complete event.
        cut = text.rfind("},\n")
        if cut == -1:
            raise
        return json.loads(text[: cut + 1] + "]}")


def extract_requests(netlog: dict) -> list[dict]:
    consts = netlog.get("constants", {})
    types = consts.get("logEventTypes", {})
    start_job = types.get("URL_REQUEST_START_JOB")
    offset = int(consts.get("timeTickOffset", 0))
    out = []
    for ev in netlog.get("events", []):
        if ev.get("type") != start_job or ev.get("phase") != 1:
            continue
        p = ev.get("params", {})
        if "url" not in p:
            continue
        out.append({
            "ts": int(ev.get("time", 0)) + offset,
            "method": p.get("method", "GET"),
            "url": p["url"],
            "source": ev.get("source", {}).get("id"),
        })
    return out


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("netlog", type=pathlib.Path)
    ap.add_argument("--out", type=pathlib.Path)
    a = ap.parse_args(argv)
    rows = extract_requests(load_netlog(a.netlog))
    out = a.out or a.netlog.with_suffix(".jsonl")
    n = write_jsonl(out, rows)
    print(f"{n} requests → {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
