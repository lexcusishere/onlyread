"""Coverage report: what left the browser vs what the interception layer decided.

    python3 harness/site/compare.py apps/<app>/sessions/<name> [more...] --labels apps/fixture/labels.jsonl

Ground truths, strongest first: NetLog (extension-independent) → webRequest observer
(inside the extension, no debugger needed) → decisions (debugger Fetch layer + DNR).

Coverage = write attempts caught (blocked, or would-block in monitor mode) / write
attempts observed. Every uncaught write lands in a bucket that names why.
"""
from __future__ import annotations

import argparse
import collections
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "lib"))  # shared harness modules
from common import Session, host_of, is_target, iter_sessions, nearest_join, path_of, read_jsonl

CAUGHT_VERDICTS = ("block", "review")  # review resolves to fail while reviewBand=block


def bucket_uncaught(obs: dict, decision: dict | None, first_ts_by_tab: dict[int, float]) -> str:
    if decision is not None:
        return "judged-allow" if decision.get("verdict") == "allow" else "other"
    t = obs.get("type", "")
    if t == "websocket":
        return "websocket"
    if t == "main_frame":
        return "before-attach"
    first = first_ts_by_tab.get(obs.get("tabId", -1))
    if first is not None and float(obs.get("ts", 0)) - first < 1500:
        return "before-attach"
    if obs.get("initiator", "").startswith("chrome-extension://"):
        return "extension-origin"
    return "not-intercepted"


def analyse(s: Session, labels: dict[str, str]) -> dict:
    domains = s.target_domains()
    obs = [o for o in s.observations if is_target(host_of(o["url"]), domains)]
    dec = [d for d in s.decisions if d.get("url", "").startswith(("http", "ws")) and is_target(host_of(d["url"]), domains)]
    key = lambda r: (r.get("method", "").upper(), r["url"])  # noqa: E731
    join = nearest_join(obs, dec, key)
    first_ts_by_tab: dict[int, float] = {}
    for o in obs:
        tid = o.get("tabId", -1)
        first_ts_by_tab[tid] = min(first_ts_by_tab.get(tid, float("inf")), float(o.get("ts", 0)))

    counts = collections.Counter()
    buckets: dict[str, list[str]] = collections.defaultdict(list)
    write_attempts = write_caught = 0
    gray = judged = 0
    rules_caught_writes = 0
    for i, o in enumerate(obs):
        d = dec[join[i]] if join[i] is not None else None
        label = labels.get(o["fingerprint"]) or (labels.get(d["fingerprint"]) if d and d.get("fingerprint") else None) or "?"
        counts["observed"] += 1
        counts["intercepted" if d else "not-intercepted"] += 1
        if d and d.get("source") in ("rules-only", "jev", "llm", "cache"):
            judged += 1
        if d and d.get("verdict") == "review":
            gray += 1
        if label == "write":
            write_attempts += 1
            if d and d.get("verdict") in CAUGHT_VERDICTS:
                write_caught += 1
                if d.get("source") in ("rule", "dnr"):
                    rules_caught_writes += 1
            else:
                buckets[bucket_uncaught(o, d, first_ts_by_tab)].append(f"{o['method']} {path_of(o['url'])}")
    # NetLog: anything the browser sent that the observer never saw.
    ext_down = []
    if s.netlog:
        nl = [n for n in s.netlog if is_target(host_of(n["url"]), domains)]
        j2 = nearest_join(nl, obs, key)
        ext_down = [f"{n['method']} {path_of(n['url'])}" for i, n in enumerate(nl) if j2[i] is None]
    return {
        "session": s.dir.name,
        "domains": domains,
        "observed": counts["observed"],
        "intercepted": counts["intercepted"],
        "judged": judged,
        "gray_zone_review": gray,
        "write_attempts": write_attempts,
        "write_caught": write_caught,
        "rules_caught_writes": rules_caught_writes,
        "coverage": (write_caught / write_attempts) if write_attempts else None,
        "buckets": dict(buckets),
        "netlog_requests": len(s.netlog),
        "extension_down": ext_down,
        "unlabeled_fingerprints": sorted({o["fingerprint"] for o in obs if o["fingerprint"] not in labels}),
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("sessions", nargs="+")
    ap.add_argument("--labels", type=pathlib.Path, required=True)
    a = ap.parse_args(argv)
    labels = {r["fingerprint"]: r["label"] for r in read_jsonl(a.labels)}
    total_attempts = total_caught = 0
    for s in iter_sessions(a.sessions):
        r = analyse(s, labels)
        total_attempts += r["write_attempts"]; total_caught += r["write_caught"]
        cov = "n/a" if r["coverage"] is None else f"{r['coverage']:.1%}"
        print(f"\n== {r['session']}  domains={','.join(r['domains'])}")
        print(f"  observed {r['observed']}  intercepted {r['intercepted']}  judged {r['judged']}  review-band {r['gray_zone_review']}")
        print(f"  write attempts {r['write_attempts']}  caught {r['write_caught']}  (by rules alone {r['rules_caught_writes']})  coverage {cov}")
        for b, items in sorted(r["buckets"].items()):
            print(f"  miss bucket {b}: {len(items)}")
            for it in items[:8]:
                print(f"      {it}")
        if r["netlog_requests"]:
            print(f"  netlog {r['netlog_requests']} requests; sent but unobserved by extension: {len(r['extension_down'])}")
            for it in r["extension_down"][:8]:
                print(f"      {it}")
        else:
            print("  netlog: not recorded for this session (extension-down bucket unavailable)")
        if r["unlabeled_fingerprints"]:
            print(f"  unlabeled fingerprints: {len(r['unlabeled_fingerprints'])} (run label.py)")
    if total_attempts:
        print(f"\nTOTAL coverage {total_caught}/{total_attempts} = {total_caught/total_attempts:.1%}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
