"""Rebuild <app>/scores.jev.live.jsonl from live decisions and print the per-operation table.

    python3 harness/site/app_report.py apps/linear

Best source per fingerprint: jev/llm > cache; rules-only never counts. Reads
<app>/sessions/*/decisions.jsonl, writes <app>/scores.jev.live.jsonl (the offline scorer owns
<app>/scores.jev.jsonl; the two are kept apart so a report rebuild never clobbers offline scores).
"""
import collections, json, pathlib, sys

RANK = {'jev': 3, 'llm': 3, 'cache': 2}


def main(app_dir: str) -> int:
    app = pathlib.Path(app_dir)
    sessions = sorted(p for p in (app / 'sessions').iterdir() if (p / 'decisions.jsonl').exists())
    dec = []
    for s in sessions:
        for line in open(s / 'decisions.jsonl'):
            d = json.loads(line); d['_session'] = s.name; dec.append(d)
    best = {}
    for d in dec:
        if d.get('pWrite') is None or d['source'] not in RANK:
            continue
        fp = d['fingerprint']
        if fp not in best or RANK[d['source']] > RANK[best[fp]['source']]:
            best[fp] = d
    out = app / 'scores.jev.live.jsonl'
    out.write_text(''.join(json.dumps({'fingerprint': fp, 'pWrite': d['pWrite'], 'latencyMs': d.get('latencyMs'), 'model': d.get('judgeModel'), 'session': d['_session']}) + '\n' for fp, d in best.items()))
    op = lambda fp: fp.split('gql:')[1] if 'gql:' in fp else fp.split(' ', 1)[1] if ' ' in fp else fp
    outcome = lambda p: 'BLOCK' if p > 0.85 else ('review' if p >= 0.30 else 'allow')
    muts = sorted([d for d in best.values() if 'gql:mutation' in d['fingerprint']], key=lambda d: (-d['pWrite'], d['fingerprint']))
    others = sorted([d for d in best.values() if 'gql:mutation' not in d['fingerprint']], key=lambda d: -d['pWrite'])
    print(f"{app}: sessions {len(sessions)}, decisions {len(dec)}, scored endpoints {len(best)}")
    print(f"\nmutations ({len(muts)}):")
    for d in muts:
        print(f"  {op(d['fingerprint'])[:60]:60} {d['pWrite']:.2f}  {outcome(d['pWrite'])}")
    print("\nother judged endpoints, highest first:")
    for d in others[:10]:
        print(f"  {op(d['fingerprint'])[:60]:60} {d['pWrite']:.2f}  {outcome(d['pWrite'])}")
    print("\noutcomes for mutations:", dict(collections.Counter(outcome(d['pWrite']) for d in muts)))
    print(f"scores → {out}")
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else 'apps/linear'))
