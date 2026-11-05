"""Fail if publishable files (what git would commit) contain API keys or known account identifiers.

    python3 harness/scrub_check.py            # exit 1 and list offending files

Identifiers come from ONLYREAD_PRIVATE_IDS in .env (comma-separated: emails, numeric account ids,
profile slugs, names), so the list itself is never committed. The domain of each private email is checked
on its own too (a workspace name turns up in calendar and label names without the address), and so is any
LinkedIn profile URN that is not the test placeholder (ACoAAA000…TEST01), and any WhatsApp user or group id.
Session and CSRF tokens (fb_dtsg, lsd, Google's at/SID/gsessionid, …), Google API keys, and in recorded data real-looking
UUIDs and Gmail ids, are flagged unless they are same-length placeholders.
Each identifier is also looked for URL-encoded and base64-encoded (at all three byte alignments, standard and
URL-safe alphabets), since sites carry account ids inside base64 payloads (Calendar's cid, Facebook's node ids).
"""
from __future__ import annotations
import base64, os, pathlib, re, subprocess, sys, urllib.parse

ROOT = pathlib.Path(__file__).resolve().parent.parent
KEY = re.compile(r"sk-or-v1-[A-Za-z0-9]{20,}|vck_[A-Za-z0-9]{20,}|sk-ant-[A-Za-z0-9_-]{20,}")
SKIP_DIRS = {"node_modules", ".git", "sessions", "test-results", "bundles", "output"}
SKIP_FILES = {".env", "package-lock.json"}
PUBLIC_MAIL = {"gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "yahoo.com", "icloud.com", "proton.me"}
SYNTHETIC_URNS = {"ACoAAB1x2y3Z4a5b6C7d8E9f0"}   # made-up values in test vectors
# WhatsApp account identifiers: a user or group JID, or a group id on its own (also as it sits in a stanza's packed
# digits, which read as the same decimal string in hex). The test vectors use zeros.
WHATSAPP_ID = re.compile(r"\b(?!0+@)\d{6,20}@(?:s\.whatsapp\.net|c\.us|g\.us|lid)\b|120363(?!0{12})\d{12}")
# Session and CSRF tokens sites put in query strings and form or JSON bodies (Facebook, Google, LinkedIn). They log
# no one in without the cookies, but they are tied to the recording account's session: recordings carry
# same-length placeholders instead (REDACTED…X, or zeros for numeric ones).
TOKEN_PARAM = re.compile(r'(?:[?&;"]|^)(fb_dtsg|fb_dtsg_ag|lsd|jazoest|__hsi|__s|at|SID|gsessionid|secid|session_id)'
                         r'(?:=|\\?"\s*:\s*\\?")([^&"`\\\s{}]{5,})', re.M)
# WhatsApp's protocol token dictionary (extension/src/inpage/wap-tokens.json) carries one Google key of its own
GOOGLE_KEY = re.compile(r"AIza(?!SyREDACTED|SyDR5yfaG7OG8sMTUj8kfQEb8T9pN8BM6Lk)[0-9A-Za-z_-]{35}")
# Real-looking ids in recorded data (apps/): UUIDs other than the 00000000-0000-4000-8000-… placeholders, Gmail
# thread and message ids, Gmail Message-IDs, Facebook's web session id.
UUID = re.compile(r"(?!00000000-0000-4000-8000-)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
GMAIL_ID = re.compile(r"(?:thread|msg)-[af]:r-?(?!9{14})\d{15,20}")
MESSAGE_ID = re.compile(r"<(?!RE\W*DA)[^<>\"\\\s]{20,80}@mail\.gmail")
FB_SESSION = re.compile(r'webSessionId\W{1,8}[a-z0-9]{6}:(?!sess\d\d)[a-z0-9]{6}:')
SYNTHETIC_TOKENS = {"NAfw:15:1790589725", "NAcN8sZqk2bB0xYzQ1r4T7u%3A17%3A1712345678", "NAfy-token:12:1700000000", "25582", "AFoagUX1"}


def placeholder(v: str) -> bool:
    core = re.sub(r"%[0-9A-Fa-f]{2}|[^A-Za-z0-9]", "", v)
    return (v in SYNTHETIC_TOKENS or "{" in v or v.startswith("00000000-0000-4000-8000-")
            or bool(re.fullmatch(r"R(?:E(?:D(?:A(?:C(?:T(?:E(?:D\d*X*)?)?)?)?)?)?)?|0{2,}\d{0,3}|9{5,}\d?|X+", core)))


def token_hits(s: str, recorded: bool, vectors: bool) -> int:
    """recorded: apps/** (captured traffic). vectors: *.vectors.json (hand-written, but some started as captures)."""
    n = sum(1 for m in TOKEN_PARAM.finditer(s) if not placeholder(m.group(2))) + len(GOOGLE_KEY.findall(s))
    if recorded or vectors:
        n += len(GMAIL_ID.findall(s)) + len(MESSAGE_ID.findall(s)) + len(FB_SESSION.findall(s))
    if recorded:
        n += len(UUID.findall(s))
    return n


PROFILE_URN = re.compile(r"urn:li:(?:fsd_profile|fs_miniProfile|member):(?!ACoAAA0+TEST01)(?!ACoAAA0{7})(?!(?:" + "|".join(SYNTHETIC_URNS) + r")\b)[A-Za-z0-9_-]{8,}")


def private_ids() -> list[str]:
    raw = os.environ.get("ONLYREAD_PRIVATE_IDS", "")
    env = ROOT / ".env"
    if not raw and env.exists():
        for line in env.read_text().split("\n"):
            if line.startswith("ONLYREAD_PRIVATE_IDS="):
                raw = line.split("=", 1)[1]
    return [x.strip() for x in raw.split(",") if x.strip()]


def encoded_forms(i: str) -> list[str]:
    """The URL-encoded form and the base64 runs that encode the identifier wherever it falls in a longer payload:
    with 0, 1 or 2 bytes before it, only the characters that depend on the identifier's bytes alone."""
    out = {urllib.parse.quote(i, safe=""), urllib.parse.quote(i)} - {i}
    b = i.encode()
    for k in range(3):
        enc = base64.b64encode(bytes(k) + b).decode()
        core = enc[-(-8 * k // 6):8 * (k + len(b)) // 6]
        if len(core) >= 8:
            out |= {core, core.replace("+", "-").replace("/", "_")}
    return sorted(out)


def publishable() -> list[pathlib.Path]:
    """Files git would commit: tracked, plus untracked ones not ignored. Ignored local data (recorded
    sessions, benchmark exports, downloaded datasets) is never published, so it is not checked."""
    out = subprocess.run(["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], cwd=ROOT, capture_output=True, check=True).stdout
    return [ROOT / f for f in out.decode().split("\0") if f]


def main() -> int:
    ids = private_ids()
    ids += sorted({i.split("@", 1)[1] for i in ids if "@" in i} - PUBLIC_MAIL)
    pat = re.compile("|".join(re.escape(i) for i in ids), re.I) if ids else None
    enc = sorted({f for i in ids for f in encoded_forms(i)})
    enc_pat = re.compile("|".join(re.escape(f) for f in enc)) if enc else None   # base64 is case-sensitive
    bad = []
    for p in publishable():
        if not p.is_file() or p.name in SKIP_FILES or SKIP_DIRS & set(p.relative_to(ROOT).parts):
            continue
        try:
            s = p.read_text()
        except (UnicodeDecodeError, OSError):
            continue
        rel = p.relative_to(ROOT)
        hits = token_hits(s, rel.parts[0] == "apps", rel.name.endswith(".vectors.json")) + len(KEY.findall(s)) + len(PROFILE_URN.findall(s)) + len(WHATSAPP_ID.findall(s)) + (len(pat.findall(s)) if pat else 0) + (len(enc_pat.findall(s)) if enc_pat else 0)
        if hits:
            bad.append((hits, str(p.relative_to(ROOT))))
    for n, f in sorted(bad, reverse=True):
        print(f"{n:5d} {f}")
    if not ids:
        print("note: ONLYREAD_PRIVATE_IDS is not set; only API keys were checked")
    print("clean" if not bad else f"{len(bad)} file(s) need scrubbing")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
