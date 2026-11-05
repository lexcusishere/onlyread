"""Score every labeled gray-zone endpoint with Jev through the gateway.

    python3 harness/judge/judge_jev.py sessions --labels apps/fixture/labels.jsonl --out sessions/scores.jev.jsonl [--dry-run]

Builds the same judge state the extension sends (from a representative decision record
per fingerprint), calls the TypeSafe-compatible endpoint, and writes {fingerprint, pWrite,
latencyMs, model}. Feed the output to evaluate.py to choose thresholds. Reads
AI_GATEWAY_API_KEY from the environment or from ./.env.
"""
from __future__ import annotations

import argparse
import json
import os
import pathlib
import sys
import time
import urllib.error
import urllib.request

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "lib"))  # shared harness modules
from common import iter_sessions, read_jsonl, write_jsonl
from evaluate import gray_zone
from fingerprint import fingerprint
from state import WRITE_QUESTION, state_from_decision

ROOT = pathlib.Path(__file__).resolve().parents[2]


PROVIDERS = {
    # name: (env var, base URL, System One path, default model)
    "openrouter": ("OPENROUTER_API_KEY", "https://openrouter.ai/api", "/v1/systemone", "typesafe/jev-1.13"),
    "gateway": ("AI_GATEWAY_API_KEY", "https://ai-gateway.vercel.sh", "/typesafe/v1/systemone", "typesafe-ai/jev"),
}


def _env_value(name: str) -> str | None:
    if os.environ.get(name):
        return os.environ[name]
    env = ROOT / ".env"
    if env.exists():
        for line in env.read_text().split("\n"):
            if line.startswith(name + "="):
                return line.split("=", 1)[1].strip().strip('"')
    return None


def load_provider(preferred: str | None = None) -> tuple[str, str] | None:
    """Return (provider, key). OpenRouter first (paid, no free-tier 429 bursts), then the gateway."""
    order = [preferred] if preferred else ["openrouter", "gateway"]
    for name in order:
        key = _env_value(PROVIDERS[name][0])
        if key:
            return name, key
    return None


RETRY_STATUS = {429, 500, 502, 503, 529}


def call_jev(key: str, base: str, model: str, state: dict, timeout: float = 20.0, attempts: int = 5, path: str = "/typesafe/v1/systemone") -> tuple[float, int, str]:
    body = {"model": model, "state": state, "questions": {"write": {"type": "noul", "instructions": WRITE_QUESTION}}}
    data = json.dumps(body).encode()
    delay = 1.0
    for attempt in range(attempts):
        req = urllib.request.Request(f"{base.rstrip('/')}{path}", data=data,
                                     headers={"authorization": f"Bearer {key}", "content-type": "application/json"}, method="POST")
        t0 = time.time()
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                resp = json.load(r)
            ms = int((time.time() - t0) * 1000)
            return float(resp["answers"]["write"]["noul"]), ms, resp.get("model", model)
        except urllib.error.HTTPError as e:
            if e.code in RETRY_STATUS and attempt < attempts - 1:
                # Free-tier rate limits are per model and low; back off and try again.
                e.read()
                time.sleep(delay)
                delay = min(delay * 2, 8.0)
                continue
            raise
    raise RuntimeError("unreachable")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("sessions", nargs="+")
    ap.add_argument("--labels", type=pathlib.Path, required=True)
    ap.add_argument("--out", type=pathlib.Path, required=True)
    ap.add_argument("--provider", choices=sorted(PROVIDERS), help="openrouter or gateway (default: first with a key, OpenRouter preferred)")
    ap.add_argument("--base", help="override the provider base URL")
    ap.add_argument("--model", help="override the provider default model")
    ap.add_argument("--all", action="store_true", help="score every labeled endpoint, not only the gray zone")
    ap.add_argument("--dry-run", action="store_true", help="print the states without calling the gateway")
    ap.add_argument("--pace", type=float, default=0.5, help="seconds to wait between calls (free-tier rate limits)")
    a = ap.parse_args(argv)

    labels = read_jsonl(a.labels)
    targets = {r["fingerprint"]: r for r in labels if a.all or gray_zone(r)}
    # Representative decision per fingerprint: prefer one with a body preview and a UI action.
    rep: dict[str, dict] = {}
    for s in iter_sessions(a.sessions):
        for d in s.decisions:
            # Match on the recorded fingerprint and on one recomputed with the current fingerprint
            # rules, so labels produced after a fingerprint-format upgrade still find their decisions.
            keys = {d.get("fingerprint")}
            if d.get("method") and d.get("url"):
                try:
                    body = d.get("bodyFull") or d.get("bodyPreview")
                    keys.add(fingerprint(d["method"], d["url"], d.get("contentType"), body, body is not None).fingerprint)
                except Exception:
                    pass
            for fp in keys:
                if fp in targets:
                    score = (d.get("bodyPreview") is not None) + (bool(d.get("lastUiActions")))
                    if fp not in rep or score > rep[fp]["_score"]:
                        rep[fp] = {**d, "_score": score}
    missing = [fp for fp in targets if fp not in rep]
    if missing:
        print(f"warning: {len(missing)} labeled endpoints have no decision record to build state from:")
        for fp in missing:
            print("   ", fp)

    prov = load_provider(a.provider)
    if not a.dry_run and not prov:
        print("no Jev credentials: set OPENROUTER_API_KEY or AI_GATEWAY_API_KEY (env or .env)", file=sys.stderr)
        return 2
    provider, key = prov or ("gateway", "")
    _, default_base, path, default_model = PROVIDERS[provider]
    base, model_id = a.base or default_base, a.model or default_model
    if not a.dry_run:
        print(f"provider: {provider} ({base}{path}, {model_id})")
    rows = []
    for fp, d in rep.items():
        state = state_from_decision(d)
        if a.dry_run:
            print(f"{targets[fp]['label']:6} {fp}\n   {json.dumps(state)}")
            continue
        try:
            p, ms, model = call_jev(key, base, model_id, state, path=path)
            rows.append({"fingerprint": fp, "label": targets[fp]["label"], "pWrite": p, "latencyMs": ms, "model": model})
            print(f"{targets[fp]['label']:6} p={p:.3f} {ms:4d}ms  {fp}")
            time.sleep(a.pace)
        except urllib.error.HTTPError as e:
            msg = e.read().decode()[:300]
            print(f"HTTP {e.code} for {fp}: {msg}", file=sys.stderr)
            if e.code in (401, 403):
                return 3
        except Exception as e:  # noqa: BLE001
            print(f"error for {fp}: {e}", file=sys.stderr)
    if not a.dry_run:
        n = write_jsonl(a.out, rows)
        print(f"{n} scores → {a.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
