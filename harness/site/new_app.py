#!/usr/bin/env python3
"""Scaffold apps/<app> for a new system.

    python3 harness/site/new_app.py notion "Notion" notion.so www.notion.so

Creates apps/<app>/{site.json, policy.json, coverage.json, sessions/} from the
defaults, with the site marked unverified. Follow "Adding a site" in CONTRIBUTING.md from there."""
import json, pathlib, sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
if len(sys.argv) < 4:
    sys.exit(__doc__)
app, name, domains = sys.argv[1], sys.argv[2], sys.argv[3:]
d = ROOT / "apps" / app
if d.exists():
    sys.exit(f"{d} already exists")
(d / "sessions").mkdir(parents=True)
default = json.loads((ROOT / "extension" / "policy" / "default.json").read_text())
policy = {"targetDomains": domains, "websockets": default["websockets"]}
policy["telemetryAllow"] = list(default["telemetryAllow"])
policy["blockedGetPaths"] = list(default["blockedGetPaths"])
policy["blockedShapes"] = list(default.get("blockedShapes", []))
(d / "policy.json").write_text(json.dumps(policy, indent=2) + "\n")
(d / "site.json").write_text(json.dumps({"name": name, "description": "", "iconUrl": None, "verified": False}, indent=1) + "\n")
(d / "coverage.json").write_text(json.dumps({"testedOn": "", "passes": [], "refused": []}, indent=1) + "\n")
print(f"created {d.relative_to(ROOT)}: site.json policy.json coverage.json sessions/ (build_site.py writes README.md)")
print("next: python3 harness/site/build_site.py %s && npm run build && python3 harness/ctl.py reload && python3 harness/ctl.py site %s on" % (app, app))
print('      then follow "Adding a site" in CONTRIBUTING.md (monitor session first, enforce last)')
