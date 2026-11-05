"""Score a judge against the labeled endpoints and choose thresholds.

    python3 harness/lib/evaluate.py --labels apps/fixture/labels.jsonl --scores sessions/scores.jev.jsonl
    python3 harness/lib/evaluate.py --labels apps/fixture/labels.jsonl --rules-only

scores.jsonl rows: {fingerprint, pWrite}. The gate metric is recall on `write`
(missed writes are the safety failure); the cost metric is the false-block rate on
`read`. Telemetry rows are excluded: they are allowed by pattern before any judge.
Only gray-zone endpoints are scored: the rules layer already decides mutating
methods, uploads, telemetry and safe GETs deterministically.
"""
from __future__ import annotations

import argparse
import pathlib
import sys

from common import read_jsonl

THRESHOLDS = [round(x * 0.05, 2) for x in range(1, 20)]


def gray_zone(label_row: dict) -> bool:
    method, rest = label_row["fingerprint"].split(" ", 1)
    shape = rest.rsplit(" ", 1)[-1]
    if method in ("GET", "HEAD", "OPTIONS", "PUT", "PATCH", "DELETE"):
        return False
    if shape == "multipart":
        return False
    return label_row["label"] in ("read", "write")


def evaluate(labels: list[dict], scores: dict[str, float]) -> list[dict]:
    rows = [r for r in labels if gray_zone(r)]
    writes = [r for r in rows if r["label"] == "write"]
    reads = [r for r in rows if r["label"] == "read"]
    table = []
    for t in THRESHOLDS:
        caught = sum(1 for r in writes if scores.get(r["fingerprint"], 0.5) >= t)
        false_blocks = sum(1 for r in reads if scores.get(r["fingerprint"], 0.5) >= t)
        table.append({
            "threshold": t,
            "write_recall": caught / len(writes) if writes else float("nan"),
            "false_block_rate": false_blocks / len(reads) if reads else float("nan"),
            "writes": len(writes), "reads": len(reads),
        })
    return table


def choose(table: list[dict], min_recall: float) -> dict | None:
    ok = [r for r in table if r["write_recall"] >= min_recall]
    return min(ok, key=lambda r: (r["false_block_rate"], -r["threshold"])) if ok else None


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--labels", type=pathlib.Path, required=True)
    ap.add_argument("--scores", type=pathlib.Path)
    ap.add_argument("--rules-only", action="store_true", help="baseline: every gray-zone endpoint scores 0.5")
    ap.add_argument("--min-recall", type=float, default=1.0)
    a = ap.parse_args(argv)

    labels = read_jsonl(a.labels)
    unlabeled = [r for r in labels if r["label"] == "?"]
    if unlabeled:
        print(f"warning: {len(unlabeled)} endpoints still labeled '?', excluded")
    scores = {r["fingerprint"]: float(r["pWrite"]) for r in read_jsonl(a.scores)} if a.scores else {}
    if a.rules_only:
        scores = {}
    table = evaluate(labels, scores)
    gz = [r for r in labels if gray_zone(r)]
    print(f"gray zone: {len(gz)} endpoints ({sum(1 for r in gz if r['label']=='write')} write, {sum(1 for r in gz if r['label']=='read')} read) of {len(labels)} labeled")
    print(f"{'threshold':>9} {'write_recall':>12} {'false_block':>11}")
    for r in table:
        print(f"{r['threshold']:>9.2f} {r['write_recall']:>12.3f} {r['false_block_rate']:>11.3f}")
    best = choose(table, a.min_recall)
    if best:
        print(f"\nblock threshold {best['threshold']:.2f}: write recall {best['write_recall']:.3f}, false-block rate {best['false_block_rate']:.3f}")
    else:
        print(f"\nno threshold reaches write recall >= {a.min_recall}")
    unscored = [r['fingerprint'] for r in gz if r['fingerprint'] not in scores]
    if unscored and (a.scores or not a.rules_only):
        print(f"unscored gray-zone endpoints (counted as 0.5 above, excluded from the range below): {len(unscored)}")
        for fp in unscored:
            print(f"    {fp}")
    reads = [scores[r['fingerprint']] for r in gz if r['label'] == 'read' and r['fingerprint'] in scores]
    writes = [scores[r['fingerprint']] for r in gz if r['label'] == 'write' and r['fingerprint'] in scores]
    if reads and writes:
        hi_read, lo_write = max(reads), min(writes)
        if hi_read < lo_write:
            gap = lo_write - hi_read
            allow = round(hi_read + gap * 0.25, 2)
            block = round(lo_write - gap * 0.25, 2)
            print(f"separation: highest read {hi_read:.2f} < lowest write {lo_write:.2f} (gap {gap:.2f})")
            print(f"suggested thresholds: allow < {allow:.2f}, block > {block:.2f}; review band in between")
        else:
            print(f"NO clean separation: highest read {hi_read:.2f} >= lowest write {lo_write:.2f}; inspect those endpoints")
    return 0


if __name__ == "__main__":
    sys.exit(main())
