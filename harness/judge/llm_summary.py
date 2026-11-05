#!/usr/bin/env python3
"""Summarize apps/<app>/scores.llm.*.jsonl the way the extension would act on them.

  python3 harness/judge/llm_summary.py apps/gmail

Columns: strict = scorer thresholds (write > 0.85 caught, non-write < 0.30 allowed);
effective = review-band behaviour (anything not < 0.30 fails closed)."""
import glob, json, math, os, sys

app = sys.argv[1] if len(sys.argv) > 1 else 'apps/gmail'
rows_by_model = {}
for f in sorted(glob.glob(os.path.join(app, 'scores.llm.*.jsonl'))):
    rows = [json.loads(l) for l in open(f) if l.strip()]
    if rows:
        rows_by_model[rows[0].get('model') or os.path.basename(f)[11:-6]] = rows

print(f"{'model':42s} {'n':>3s}  {'writes caught':>13s} {'writes stopped':>14s} {'reads passed':>12s} {'reads blocked':>13s}  {'p50 ms':>7s}")
for model, rows in rows_by_model.items():
    w = [r for r in rows if r['label'] == 'write']
    nw = [r for r in rows if r['label'] != 'write']
    p = lambda r: r['pWrite'] if isinstance(r['pWrite'], (int, float)) and not math.isnan(r['pWrite']) else float('nan')
    caught = sum(1 for r in w if p(r) > 0.85)
    stopped = sum(1 for r in w if not (p(r) < 0.30))
    passed = sum(1 for r in nw if p(r) < 0.30)
    blocked = sum(1 for r in nw if p(r) > 0.85)
    lat = sorted(r.get('latencyMs', 0) for r in rows)
    p50 = lat[len(lat) // 2] if lat else 0
    print(f"{model:42s} {len(rows):>3d}  {caught:>6d}/{len(w):<6d} {stopped:>7d}/{len(w):<6d} {passed:>5d}/{len(nw):<6d} {blocked:>6d}/{len(nw):<6d}  {p50:>7d}")
