#!/usr/bin/env python3
"""Build apps/<app>/replay.jsonl: one replayable request per labeled fingerprint, for the CI replay test
(e2e/replay.spec.ts). Labels keep only a 200-character body sample, which cuts JSON bodies mid-way; this
takes the body from the recorded sessions instead (the extension's 2 KB preview, which keeps the
structure), with the recorded content type and resource type.

    python3 harness/site/replay_corpus.py linear

Needs the site's recorded sessions (apps/<app>/sessions/, private, never committed). The output is
committed, so run `npm run scrub` before committing it.
"""
import glob
import json
import os
import sys
from urllib.parse import quote

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, "harness", "lib"))
from fingerprint import fingerprint  # noqa: E402  (the extension's own fingerprint code, via fp_cli.mts)


def private_ids():
    """The owner's identifiers (ONLYREAD_PRIVATE_IDS in .env, same list the scrub check uses), longest first."""
    raw = os.environ.get("ONLYREAD_PRIVATE_IDS", "")
    env = os.path.join(ROOT, ".env")
    if not raw and os.path.exists(env):
        for line in open(env):
            if line.startswith("ONLYREAD_PRIVATE_IDS="):
                raw = line.split("=", 1)[1].strip()
    return sorted({x.strip() for x in raw.split(",") if x.strip()}, key=len, reverse=True)


def stand_in(ident):
    """A neutral replacement that keeps the body valid: digits stay digits (JSON numbers, ids in paths)."""
    if ident.isdigit():
        return "9" * len(ident)
    if "@" in ident:
        return "user@example.com"
    return "redacted"


def scrub(text, ids):
    if not text:
        return text
    for ident in ids:
        rep = stand_in(ident)
        for form in {ident, quote(ident, safe=""), quote(ident)}:
            text = text.replace(form, rep if form == ident else quote(rep, safe=""))
    return text


def parses(body, content_type):
    if not body:
        return False
    if "json" in (content_type or ""):
        try:
            json.loads(body)
            return True
        except ValueError:
            return False
    return True


def main(app):
    app_dir = os.path.join(ROOT, "apps", app)
    labels = [json.loads(l) for l in open(os.path.join(app_dir, "labels.jsonl")) if l.strip()]
    # Index every recorded decision by the fingerprint today's decoders give it, and replay only recordings
    # whose fingerprint equals their label's. Labels made before a site's decoder existed can cover a shape
    # that mixed reads and writes; those are reported as stale instead of replayed with the wrong label.
    recorded = {}
    for f in sorted(glob.glob(os.path.join(app_dir, "sessions", "*", "decisions.jsonl"))):
        for line in open(f):
            d = json.loads(line)
            if d.get("kind", "decision") != "decision" or not d.get("method") or not d.get("url"):
                continue
            body = d.get("bodyFull") or d.get("bodyPreview")
            try:
                fp = fingerprint(d["method"], d["url"], d.get("contentType"), body, body is not None).fingerprint
            except Exception:
                fp = d.get("fingerprint")
            if fp:
                recorded.setdefault(fp, []).append(d)

    ids = private_ids()
    out, missing, sockets = [], [], []
    for lab in labels:
        if lab["label"] not in ("read", "write", "telemetry"):
            continue
        # A WebSocket upgrade cannot be sent with fetch(); the `websockets` rule that governs it is tested
        # by the fixture suite (e2e/phase0.spec.ts), so it is listed here instead of replayed.
        if lab.get("sample_url", "").startswith(("ws://", "wss://")):
            sockets.append(lab["fingerprint"])
            continue
        method = lab["fingerprint"].split(" ")[0]
        entry = {"label": lab["label"], "fingerprint": lab["fingerprint"], "method": method, "url": lab["sample_url"]}
        if method not in ("GET", "HEAD", "OPTIONS"):
            # The longest recorded body that still parses: the most faithful replay.
            bodiless = lab["fingerprint"].endswith(" none")
            cands = [d for d in recorded.get(lab["fingerprint"], []) if bodiless or parses(d.get("bodyFull") or d.get("bodyPreview"), d.get("contentType"))]
            if not cands:
                missing.append(lab["fingerprint"])
                continue
            best = max(cands, key=lambda d: len(d.get("bodyFull") or d.get("bodyPreview") or ""))
            body = None if bodiless else (best.get("bodyFull") or best.get("bodyPreview"))
            entry.update({"url": best["url"], "contentType": best.get("contentType"), "body": body, "resourceType": best.get("resourceType")})
        else:
            entry["resourceType"] = (recorded.get(lab["fingerprint"]) or [{}])[0].get("resourceType")
        out.append(entry)

    # The file is committed: the owner's identifiers never go in it.
    for e in out:
        e["url"] = scrub(e["url"], ids)
        if e.get("body"):
            e["body"] = scrub(e["body"], ids)

    path = os.path.join(app_dir, "replay.jsonl")
    with open(path, "w") as fh:
        for e in out:
            fh.write(json.dumps(e, ensure_ascii=False) + "\n")
    by = {}
    for e in out:
        by[e["label"]] = by.get(e["label"], 0) + 1
    print(f"{path}: {len(out)} requests {by}")
    if sockets:
        print(f"  not replayable (WebSocket upgrades, covered by e2e/phase0.spec.ts): {len(sockets)}")
    if missing:
        print(f"  skipped {len(missing)} labeled requests with no recording that parses and decodes to the label:")
        for fp in missing:
            print(f"    {fp}")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "linear")
