#!/usr/bin/env python3
"""Drive the extension through the dev control channel (fixture server on :4173).

    python3 harness/ctl.py status
    python3 harness/ctl.py site calendar on   # switch a built-in site on (or off)
    python3 harness/ctl.py policy my-policy.json [--mode enforce|monitor]   # a whole policy, as policy-get prints it; default keeps the mode
    python3 harness/ctl.py mode enforce
    python3 harness/ctl.py cache-import apps/calendar/cache.json
    python3 harness/ctl.py cache-clear | audit-clear | judge-test | policy-get
    python3 harness/ctl.py secrets            # pushes provider keys from .env (OPENROUTER_API_KEY → OpenRouter, AI_GATEWAY_API_KEY → Vercel AI Gateway, ANTHROPIC_API_KEY → Anthropic, which has no field in the UI)
    python3 harness/ctl.py reload             # chrome.runtime.reload(): picks up a new build from disk
    python3 harness/ctl.py instances          # extension instances (Chrome profiles) polling the fixture
    ONLYREAD_INSTANCE=<id> python3 harness/ctl.py …   # address one when several profiles run the extension
    python3 harness/ctl.py set reviewBand '"llm"'   # patch one policy field (JSON value), mode preserved
    python3 harness/ctl.py sites              # built-in and custom sites with their on/off state
    python3 harness/ctl.py site gmail on      # guard a site (imports its tested verdicts); off to stop
    python3 harness/ctl.py site-add example.com | site-remove example.com

Requires the fixture server (fixtures/testapp/server.ts) and a policy whose devSink points at it.
"""
from __future__ import annotations

import argparse, json, os, pathlib, sys, time, urllib.error, urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
BASE = os.environ.get("ONLYREAD_CONTROL", "http://localhost:4173")
INSTANCE = os.environ.get("ONLYREAD_INSTANCE")  # which extension instance (Chrome profile) to address; auto when only one is live



# .env variable → provider id in the extension's `secrets.keys` (shared/providers.ts).
ENV_KEYS = (("OPENROUTER_API_KEY", "openrouter"), ("AI_GATEWAY_API_KEY", "vercel"), ("ANTHROPIC_API_KEY", "anthropic"))

def _req(method: str, path: str, body: dict | None = None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method, headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=10) as r:
        return r.status, json.loads(r.read() or b"null")


def send(command: dict, timeout: float = 20.0) -> dict:
    body = dict(command)
    if INSTANCE:
        body["instance"] = INSTANCE
    try:
        _, r = _req("POST", "/__control", body)
    except urllib.error.HTTPError as e:
        if e.code == 409:
            info = json.loads(e.read() or b"{}")
            return {"ok": False, "error": info.get("error"), "instances": info.get("instances"), "hint": "set ONLYREAD_INSTANCE=<id> (see: ctl.py instances)"}
        raise
    cid = r["id"]
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            status, res = _req("GET", f"/__control/result/{cid}")
        except urllib.error.HTTPError as e:
            if e.code == 202:
                time.sleep(0.4); continue
            raise
        if status == 202:
            time.sleep(0.4); continue
        return res
    return {"ok": False, "error": f"no answer from the extension within {timeout:.0f}s (is it loaded, and is devSink set to {BASE}?)"}


def env_value(name: str) -> str | None:
    if os.environ.get(name):
        return os.environ[name]
    env = ROOT / ".env"
    if env.exists():
        for line in env.read_text().split("\n"):
            if line.startswith(name + "="):
                return line.split("=", 1)[1].strip().strip('"')
    return None


def main(argv: list[str] | None = None) -> int:
    global INSTANCE
    if not INSTANCE:
        INSTANCE = env_value("ONLYREAD_INSTANCE")  # .env may pin the profile under test
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("status"); sub.add_parser("policy-get"); sub.add_parser("cache-clear"); sub.add_parser("audit-clear")
    sub.add_parser("judge-test"); sub.add_parser("reload"); sub.add_parser("secrets"); sub.add_parser("rules"); sub.add_parser("audit")
    p = sub.add_parser("policy"); p.add_argument("file", type=pathlib.Path); p.add_argument("--mode", choices=["monitor", "enforce"])
    m = sub.add_parser("mode"); m.add_argument("mode", choices=["monitor", "enforce"])
    ss = sub.add_parser("session"); ss.add_argument("state", choices=["start", "end"])
    g = sub.add_parser("guard"); g.add_argument("--enabled", choices=["true", "false"]); g.add_argument("--mode", choices=["monitor", "enforce"]); g.add_argument("--attach", choices=["always", "agent-session"])
    c = sub.add_parser("cache-import"); c.add_argument("file", type=pathlib.Path)
    n = sub.add_parser("notice-test"); n.add_argument("tab_id", type=int)
    sub.add_parser("sites"); sub.add_parser("obs-clear"); sub.add_parser("instances"); sub.add_parser("setup"); sub.add_parser("secrets-pull"); sub.add_parser("targets"); sub.add_parser("typed-secrets"); ba = sub.add_parser("blockall"); ba.add_argument("state", choices=["on", "off"]); sw = sub.add_parser("sw-stop"); sw.add_argument("tab_id", type=int)
    se = sub.add_parser("set"); se.add_argument("key"); se.add_argument("value", help="JSON, e.g. '\"llm\"' or '{\"allow\":0.3}'")
    st = sub.add_parser("site"); st.add_argument("id"); st.add_argument("state", choices=["on", "off"])
    sa = sub.add_parser("site-add"); sa.add_argument("host")
    sr = sub.add_parser("site-remove"); sr.add_argument("id")
    a = ap.parse_args(argv)

    if a.cmd == "status":
        res = send({"type": "status:get"})
    elif a.cmd == "policy-get":
        res = send({"type": "policy:get"})
    elif a.cmd == "policy":
        policy = json.loads(a.file.read_text())
        if a.mode:
            policy["mode"] = a.mode
        res = send({"type": "policy:set", "policy": policy, "keepMode": a.mode is None})
    elif a.cmd == "mode":
        res = send({"type": "mode:set", "mode": a.mode})
    elif a.cmd == "session":
        res = send({"type": "session:set", "active": a.state == "start"})
    elif a.cmd == "guard":
        msg = {"type": "guard:set"}
        if a.enabled is not None: msg["enabled"] = a.enabled == "true"
        if a.mode is not None: msg["mode"] = a.mode
        if a.attach is not None: msg["attachWhen"] = a.attach
        res = send(msg)
    elif a.cmd == "cache-import":
        raw = json.loads(a.file.read_text())
        entries = raw.get("entries", raw) if isinstance(raw, dict) else {e["fingerprint"]: e for e in raw}
        res = send({"type": "cache:import", "entries": entries}, timeout=60)
    elif a.cmd == "cache-clear":
        res = send({"type": "cache:clear"})
    elif a.cmd == "audit":
        res = send({"type": "audit:list"}, timeout=30)
        if res.get("ok") and isinstance(res.get("result"), list):
            rows = res["result"]
            print(f"{len(rows)} audit entries; last 40 non-GET:")
            for e in [r for r in rows if r.get("method") != "GET"][-40:]:
                print(time.strftime("%H:%M:%S", time.localtime(e.get("ts", 0) / 1000)), (e.get("fingerprint") or "").split(" ", 1)[-1][:70], e.get("verdict"), e.get("source"), (e.get("reason") or "")[:24], "enf=", e.get("enforced"))
            return 0
    elif a.cmd == "set":
        cur = send({"type": "policy:get"})
        if not cur.get("ok"):
            res = cur
        else:
            policy = cur["result"]; policy[a.key] = json.loads(a.value)
            res = send({"type": "policy:set", "policy": policy, "keepMode": True})
            if res.get("ok"): res = {"ok": True, a.key: res["result"].get(a.key)}
    elif a.cmd == "instances":
        _, rows = _req("GET", "/__control/instances")
        if not rows:
            print("no extension instance has polled the fixture yet"); return 1
        for r in sorted(rows, key=lambda x: x["ageMs"]):
            live = "live" if r["ageMs"] < 10_000 else f"seen {r['ageMs']//1000}s ago"
            print(f"  {r['id']:8s} {live:14s} {r['label']}")
        print("select one with ONLYREAD_INSTANCE=<id> when several are live")
        return 0
    elif a.cmd == "obs-clear":
        res = send({"type": "observations:clear"})
    elif a.cmd == "sites":
        res = send({"type": "sites:list"})
        if res.get("ok"):
            for v in res["result"]:
                print(f"  [{'on ' if v['enabled'] else 'off'}] {v['id']:10s} {v['name']:16s} {', '.join(v['domains'])}{'' if v['builtin'] else '  (custom)'}")
            return 0
    elif a.cmd == "site":
        res = send({"type": "site:set", "id": a.id, "enabled": a.state == "on"})
    elif a.cmd == "site-add":
        res = send({"type": "site:add", "host": a.host})
    elif a.cmd == "site-remove":
        res = send({"type": "site:remove", "id": a.id})
    elif a.cmd == "notice-test":
        res = send({"type": "notice:test", "tabId": a.tab_id})
    elif a.cmd == "rules":
        res = send({"type": "rules:list"})
    elif a.cmd == "audit-clear":
        res = send({"type": "audit:clear"})
    elif a.cmd == "setup":
        res = send({"type": "setup:open"})
    elif a.cmd == "judge-test":
        res = send({"type": "judge:test"}, timeout=30)
    elif a.cmd == "sw-stop":
        res = send({"type": "sw:stop", "tabId": a.tab_id})
    elif a.cmd == "blockall":
        res = send({"type": "blockall:set", "on": a.state == "on"})
    elif a.cmd == "targets":
        res = send({"type": "debug:targets"})
    elif a.cmd == "typed-secrets":
        res = send({"type": "debug:typed-secrets"})  # a count and lengths, never the values
    elif a.cmd == "secrets-pull":
        # Write the extension's stored keys into .env (never printed); report only short digests.
        import hashlib
        got = send({"type": "secrets:get"})
        sec = (got.get("result") or {}).get("secrets") or {}
        env = ROOT / ".env"
        lines = env.read_text().split("\n") if env.exists() else []
        def digest(v): return hashlib.sha256(v.encode()).hexdigest()[:8] if v else "-"
        report = {}
        keys = sec.get("keys") or {}
        for var, key in ENV_KEYS:
            new = (keys.get(key) or "").strip()
            if not new:
                report[var] = "extension has none"; continue
            old = env_value(var) or ""
            if old == new:
                report[var] = f"already in sync ({digest(new)})"; continue
            found = False
            for i, l in enumerate(lines):
                if l.startswith(var + "="):
                    lines[i] = f"{var}={new}"; found = True
            if not found:
                lines.append(f"{var}={new}")
            report[var] = f"updated {digest(old)} -> {digest(new)}"
        env.write_text("\n".join(lines).rstrip("\n") + "\n")
        res = {"ok": True, "env": str(env), "keys": report}
    elif a.cmd == "secrets":
        keys = {key: env_value(var) for var, key in ENV_KEYS if env_value(var)}
        res = send({"type": "secrets:set", "secrets": {"keys": keys}})
        if isinstance(res, dict) and "result" in res:
            res = {"ok": res.get("ok"), "keys_set": sorted(keys)}   # never echo key material
    elif a.cmd == "reload":
        res = send({"type": "reload"})
        if res.get("ok"):
            t0 = time.time()
            while time.time() - t0 < 30:
                time.sleep(1.5)
                back = send({"type": "status:get"}, timeout=6)
                if back.get("ok"):
                    res = {"ok": True, "reloaded": True, "status": back.get("result")}; break
            else:
                res = {"ok": False, "error": "extension did not come back within 30s"}
    else:
        ap.error("unknown command")
    print(json.dumps(res, indent=1)[:4000])
    return 0 if res.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
