"""Mirror of extension/src/background/judge/state.ts: the exact object a judge sees."""
from __future__ import annotations

import re

WRITE_QUESTION = (
    "Does this HTTP request create, modify, or delete data stored by the server? "
    "Consider the method, path, body structure and the user action that triggered it. "
    "Reads, searches, queries, list/fetch RPC calls, exports and previews are NOT writes. "
    "Telemetry, analytics, logging, presence and heartbeats are NOT writes. "
    "Signing in, signing out and refreshing a session are NOT writes; creating an account IS a write. "
    "State kept only for the current session (wizard or quote steps, a chosen ZIP code, map position), saving recent "
    "searches, consent choices and device status reports are NOT writes. "
    "Marking items as read or seen, read receipts, and saving drafts, progress or view preferences ARE writes. "
    "Carts, choosing a store, and anything that sends an email or notification ARE writes. "
    "Creating, updating, deleting, submitting, sending, uploading, assigning, resolving or archiving IS a write, and "
    "so is a GraphQL mutation that changes stored data; a mutation that only tracks, logs or reports presence or "
    "typing is NOT a write."
)

REDACTED = "[redacted]"
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)


def is_token_like(run: str) -> bool:
    """Mirror of isTokenLike(): 16+ chars, letters and digits, frequent case/digit switches (or UUID / hex)."""
    if len(run) < 16 or not re.search(r"\d", run) or not re.search(r"[A-Za-z]", run):
        return False
    if UUID_RE.match(run) or re.fullmatch(r"[0-9a-f]{16,}", run, re.I):
        return True
    switches, prev = 0, ""
    for c in run:
        k = "d" if c.isdigit() else "l" if "a" <= c <= "z" else "u" if "A" <= c <= "Z" else ""
        if not k:
            continue
        if prev and k != prev:
            switches += 1
        prev = k
    return switches / len(run) >= 0.35


def redact_tokens(text: str) -> str:
    """Mirror of redactTokens(): every token-like run replaced with [redacted]."""
    return re.sub(r"[A-Za-z0-9_\-+/=]{16,}", lambda m: REDACTED if is_token_like(m.group(0)) else m.group(0), text)


def state_from_decision(d: dict) -> dict:
    """Build the judge state from an audit decision record (needs the Phase 3 audit fields)."""
    from urllib.parse import urlsplit

    fp = d.get("fingerprint", "")
    host = (urlsplit(d["url"]).hostname or "").lower()
    template = fp.split(" ")[1][len(host):] if " " in fp else urlsplit(d["url"]).path
    ui = (d.get("lastUiActions") or [None])[0]
    from urllib.parse import parse_qsl
    query_keys = sorted({k for k, _ in parse_qsl(urlsplit(d["url"]).query, keep_blank_values=True)})
    return {
        "method": d.get("method", "GET").upper(),
        "host": host,
        "path": "/".join(redact_tokens(seg) for seg in urlsplit(d["url"]).path.split("/")),
        "pathTemplate": redact_tokens(template),
        "queryKeys": query_keys,
        "contentType": d.get("contentType"),
        "resourceType": d.get("resourceType"),
        "bodyShape": d.get("bodyShape") or (fp.rsplit(" ", 1)[-1] if fp else None),
        "bodyPreview": redact_tokens(d["bodyPreview"]) if d.get("bodyPreview") else d.get("bodyPreview"),
        "bodyTruncated": False,
        "triggeredBy": {"type": ui["type"], "element": ui.get("tag"), "name": ui.get("name"), "formMethod": ui.get("formMethod")} if ui else None,
    }
