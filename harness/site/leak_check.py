"""Pair the observer (webRequest) records of a dumped session with its decisions.

    python3 harness/site/leak_check.py apps/<app>/sessions/<name> [--host mail.google.com] [--window 3]

Every request the browser started is in observations.jsonl; every request the interception layer
decided is in decisions.jsonl (CDP or DNR). Three numbers matter after an enforce battery:
  orphans  — observed non-safe requests with no decision within the window: traffic the layer never
             saw (first navigation of a fresh origin, unattached worker, …).
  leaks    — observed requests that COMPLETED while their decision was block: the block did not hold.
  blocked  — observed requests that errored and whose decision was block: refused as intended.
Exit status 1 when there is any leak, so it can gate a session.
"""
from __future__ import annotations

import argparse
import collections
import json
import pathlib
import sys

SAFE = {"GET", "HEAD", "OPTIONS"}


def load(p: pathlib.Path) -> list[dict]:
    if not p.exists():
        return []
    return [json.loads(l) for l in p.read_text().split("\n") if l.strip()]


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("session", type=pathlib.Path)
    ap.add_argument("--host", help="only requests whose URL contains this host")
    ap.add_argument("--window", type=float, default=3.0, help="seconds between observation and decision to pair them")
    ap.add_argument("--all-methods", action="store_true", help="include GET/HEAD/OPTIONS in the orphan check")
    a = ap.parse_args(argv)
    obs = load(a.session / "observations.jsonl")
    dec = load(a.session / "decisions.jsonl")
    if a.host:
        obs = [o for o in obs if a.host in (o.get("url") or "")]
        dec = [d for d in dec if a.host in (d.get("url") or "")]
    def key(r: dict) -> tuple[str, str]:
        # Fragments never go over the wire; strip them so both sides pair on the request URL.
        return str(r.get("method", "")).upper(), (r.get("url") or "").split("#", 1)[0]

    by_key: dict[tuple[str, str], list[dict]] = collections.defaultdict(list)
    for d in dec:
        by_key[key(d)].append(d)
    win = a.window * 1000
    orphans, leaks, blocked, allowed, monitored = [], [], [], [], []
    # One-to-one pairing: a decision explains at most one observation. Without this, two same-URL requests
    # in the same millisecond (an allowed query and a refused mutation) both grab the block decision and the
    # allowed one is reported as a leak. A worker request (tabId -1) never pairs with a tab decision: the
    # debugger never saw it. Among candidates, prefer the one whose expected outcome matches what was observed.
    used: set[int] = set()
    for o in sorted(obs, key=lambda o: o["ts"]):
        m = str(o.get("method", "")).upper()
        if m in SAFE and not a.all_methods:
            continue
        near = [d for d in by_key.get(key(o), []) if id(d) not in used and abs(d["ts"] - o["ts"]) <= win and (o.get("tabId") != -1 or d.get("tabId") == -1)]
        if not near:
            orphans.append(o)
            continue
        blocked_obs = o.get("outcome") != "completed"
        near.sort(key=lambda d: (((d.get("verdict") == "block" or d.get("action") == "fail") and d.get("enforced") is not False) != blocked_obs, abs(d["ts"] - o["ts"])))
        d = near[0]
        used.add(id(d))
        if d.get("verdict") == "block" or d.get("action") == "fail":
            # A monitor-mode decision (enforced=false) refuses nothing, so a completed request is not a leak.
            if d.get("enforced") is False:
                monitored.append((o, d))
            else:
                (leaks if o.get("outcome") == "completed" else blocked).append((o, d))
        else:
            allowed.append((o, d))
    print(f"observed {len(obs)} requests ({'all' if a.all_methods else 'non-safe'} methods checked), decisions {len(dec)}")
    print(f"  allowed {len(allowed)}   blocked-and-failed {len(blocked)}   monitor-passed {len(monitored)}   orphans {len(orphans)}   LEAKS {len(leaks)}")
    workers = [o for o in orphans if o.get("tabId") == -1]
    if workers:
        print(f"  of which from no tab (service/shared worker, never judged): {len(workers)}")
    for o in orphans[:20]:
        print(f"  orphan  {o.get('method')} {o.get('outcome')} {str(o.get('status'))} {(o.get('url') or '')[:110]}")
    for o, d in leaks[:20]:
        print(f"  LEAK    {o.get('method')} status={o.get('status')} decided={d.get('reason')} {(o.get('url') or '')[:100]}")
    return 1 if leaks else 0


if __name__ == "__main__":
    sys.exit(main())
