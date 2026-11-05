"""Build or update the labeling sheet: one row per unique endpoint fingerprint.

    python3 harness/site/label.py apps/<app>/sessions/<name> [more sessions...] --labels apps/fixture/labels.jsonl

Each row: {fingerprint, label, count, methods, sample_url, sample_body, heuristic, note}
label ∈ read | write | telemetry | ? . Heuristics pre-fill the obvious cases; every '?'
is reviewed by a human (or an LLM with human review) before the sheet is used.
Existing labels are preserved; only counts and samples refresh.
"""
from __future__ import annotations

import argparse
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "lib"))  # shared harness modules
from common import Session, is_target, iter_sessions, path_of, read_jsonl, write_jsonl

TELEMETRY_HINTS = ("/collect", "/beacon", "analytics", "/telemetry", "/metrics", "/track", "/ping", "/heartbeat", "/log")
WRITE_WORDS = ("create", "update", "delete", "remove", "save", "submit", "send", "upload", "mark", "assign", "resolve", "close", "archive", "approve", "publish", "invite", "add", "edit", "set", "toggle", "move", "rename", "reply", "comment", "post", "import", "sync", "reset", "logout", "login")
READ_WORDS = ("search", "query", "list", "get", "fetch", "find", "lookup", "autocomplete", "suggest", "export", "download", "preview", "render", "count", "check", "validate", "graphql")


def heuristic(fp: str, sample_url: str, types: set[str] | None = None) -> tuple[str, str]:
    method, rest = fp.split(" ", 1)
    shape = rest.rsplit(" ", 1)[-1]
    path = path_of(sample_url).lower()
    if types and ("websocket" in types or "WebSocket" in types) or sample_url.startswith("ws"):
        return "write", "websocket upgrade: frames cannot be inspected, policy treats the channel as a write"
    if method in ("PUT", "PATCH", "DELETE"):
        return "write", "mutating method"
    if shape == "multipart":
        return "write", "upload"
    if any(h in path for h in TELEMETRY_HINTS):
        return "telemetry", "telemetry path"
    if shape.startswith("gql:mutation") or shape.startswith("gql[]:") and "mutation" in shape:
        return "write", "graphql mutation"
    if shape.startswith("gql:query") or shape == "gql[]:query":
        return "read", "graphql query"
    if method in ("GET", "HEAD", "OPTIONS"):
        if any(w in path for w in ("mark-read", "delete", "remove", "toggle")):  # a sign-out is a read (ARCHITECTURE.md, What counts as a write)
            return "?", "GET with write-looking path"
        return "read", "safe method"
    if any(w in path.split("/")[-1] for w in READ_WORDS):
        return "?", "POST with read-looking path (verify)"
    if any(w in path for w in WRITE_WORDS):
        return "?", "POST with write-looking path (verify)"
    return "?", "POST, unknown semantics"


def collect(sessions: list[Session]) -> dict[str, dict]:
    rows: dict[str, dict] = {}
    for s in sessions:
        domains = s.target_domains()
        seen_ids: set[str] = set()
        for src, items in (("decision", s.decisions), ("observation", s.observations)):
            for x in items:
                url = x.get("url", "")
                if not url.startswith(("http", "ws")) or not is_target(x.get("host") or url.split("/")[2].split(":")[0], domains):
                    continue
                fp = x.get("fingerprint")
                if not fp:
                    continue
                r = rows.setdefault(fp, {"fingerprint": fp, "label": "?", "count": 0, "methods": set(), "types": set(), "sample_url": url, "sample_body": None, "sources": set()})
                if x.get("type") or x.get("resourceType"):
                    r["types"].add(x.get("type") or x.get("resourceType"))
                key = f"{src}:{x.get('requestId', id(x))}"
                if key not in seen_ids:
                    seen_ids.add(key)
                    if src == "observation":
                        r["count"] += 1
                r["methods"].add(x.get("method", "?"))
                r["sources"].add(src)
                if x.get("reason") == "static-asset":
                    r["static"] = True
                if r["sample_body"] is None and x.get("bodyPreview"):
                    r["sample_body"] = x["bodyPreview"][:200]
    return rows


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("sessions", nargs="+")
    ap.add_argument("--labels", type=pathlib.Path, required=True)
    a = ap.parse_args(argv)

    existing = {r["fingerprint"]: r for r in read_jsonl(a.labels)}
    rows = collect(list(iter_sessions(a.sessions)))
    out = []
    for fp, r in sorted(rows.items()):
        h_label, h_why = ("read", "static-asset") if r.get("static") else heuristic(fp, r["sample_url"], r["types"])
        prev = existing.get(fp, {})
        out.append({
            "fingerprint": fp,
            "label": prev.get("label", h_label),
            "count": r["count"],
            "methods": sorted(r["methods"]),
            "types": sorted(r["types"]),
            "sample_url": r["sample_url"],
            "sample_body": r["sample_body"],
            "heuristic": h_label,
            "heuristic_why": h_why,
            "note": prev.get("note", ""),
        })
    # Keep labels for endpoints not seen this time.
    seen = {r["fingerprint"] for r in out}
    out.extend(v for k, v in existing.items() if k not in seen)
    n = write_jsonl(a.labels, out)
    todo = [r for r in out if r["label"] == "?"]
    static = sum(1 for r in out if r["heuristic_why"] == "static-asset")
    print(f"{n} endpoints → {a.labels} ({static} static assets auto-labeled read); {len(todo)} need a human label:")
    for r in todo:
        print(f"  {r['fingerprint']}   ({r['heuristic_why']}; sample {r['sample_body']!r})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
