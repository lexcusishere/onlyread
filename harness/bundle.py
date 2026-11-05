#!/usr/bin/env python3
"""Build the release: the zip for the Chrome Web Store, and the same files for someone to load unpacked.

    python3 harness/bundle.py            # build and verify the release zips
    npm run release                      # all checks first, then this with --strict

Builds the extension in distribution mode (ONLYREAD_DIST=1: no dev sink, no control channel and none of
its handlers, minified, no source maps), stages only the files Chrome needs at runtime, verifies the
staged release (below), and writes bundles/onlyread-<version>-webstore.zip (manifest at the zip root) and
bundles/onlyread-<version>.zip (everything under an `onlyread/` folder). Then it rebuilds in dev mode so
the loaded working copy keeps its dev sink.

Verification, any failure stops the release:
  - no development code or address in the bundle (control channel, dev handlers, localhost sink, maps);
  - LICENSE, NOTICE and THIRD_PARTY_NOTICES.txt are staged;
  - manifest version equals package.json's; no `key` (the working copy's is dropped when staging); every file the manifest and pages load is present;
  - the manifest's permissions are exactly the ones a permission table justifies: a Markdown file whose table names
    each permission in backticks in its first column, named by ONLYREAD_STORE_LISTING (environment or .env); the
    check is skipped with a note when nothing is named or the file is missing;
  - with --strict: the git tree is clean, so the zip matches a commit.
"""
from __future__ import annotations

import hashlib
import json
import re
import os
import pathlib
import shutil
import subprocess
import sys
import zipfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
EXT = ROOT / "extension"
# Files Chrome loads at runtime. Source, policy JSON and test vectors are compile-time only (bundled
# into dist/*.js by esbuild), so they are deliberately left out.
RUNTIME = ["manifest.json", "popup.html", "options.html", "setup.html", "ui.css", "welcome.css", "layout.css"]
# OnlyRead's license, its NOTICE (copyright, and the brand files the AGPL does not cover) and the licenses of the npm
# packages bundled into its scripts (written by scripts/build.mjs) go with every copy of the release.
LEGAL = {"LICENSE": ROOT / "LICENSE", "NOTICE": ROOT / "NOTICE", "THIRD_PARTY_NOTICES.txt": EXT / "dist" / "THIRD_PARTY_NOTICES.txt"}
DIST_JS = ["background.js", "popup.js", "options.js", "setup.js", "content.js", "whatsapp-socket.js", "telegram-worker.js"]


def run_build(dist: bool) -> None:
    env = {**os.environ, "ONLYREAD_DIST": "1"} if dist else os.environ
    subprocess.run(["npm", "run", "-s", "build"], cwd=ROOT, env=env, check=True)


# Strings only development code carries. Each must be absent from every shipped script.
DEV_MARKERS = {
    "__control": "the localhost control channel (control.ts)",
    "secrets:get": "the dev control handlers (dev-control.ts)",
    "debug:typed-secrets": "the dev control handlers (dev-control.ts)",
    "localhost:4173": "the dev sink address",
    "127.0.0.1:4179": "the dev reload signal (dev-reload.ts)",
    "dev:reload-pages": "the dev page reload (dev-reload.ts)",
    "sourceMappingURL": "a source map reference",
    "__ONLYREAD_DIST__": "an unresolved build flag",
    "__onlyread": "the e2e status hook",
}


def fail(msg: str) -> None:
    raise SystemExit(f"release check failed: {msg}")


def listing_path() -> pathlib.Path | None:
    """The permission table's file, named by ONLYREAD_STORE_LISTING in the environment or .env (relative to the repo
    root), or None when nothing is named."""
    raw = os.environ.get("ONLYREAD_STORE_LISTING", "")
    env = ROOT / ".env"
    if not raw and env.is_file():
        for line in env.read_text().split("\n"):
            if line.startswith("ONLYREAD_STORE_LISTING="):
                raw = line.split("=", 1)[1].strip()
    return (ROOT / pathlib.Path(raw).expanduser()).resolve() if raw else None


def justified_permissions() -> set[str] | None:
    """Permissions named in the permission table (first column, backticked), or None when no file is named or it is
    missing."""
    listing = listing_path()
    if listing is None or not listing.is_file():
        return None
    return set(re.findall(r"^\| `([A-Za-z]+)` \|", listing.read_text(), re.M))


def verify(stage: pathlib.Path) -> None:
    for js in (stage / "dist").glob("*.js"):
        code = js.read_text()
        for marker, what in DEV_MARKERS.items():
            if marker in code:
                fail(f"{js.name} contains {what} ({marker!r})")
    for name in LEGAL:
        if not (stage / name).is_file() or not (stage / name).read_text().strip():
            fail(f"{name} is not staged")
    man = json.loads((stage / "manifest.json").read_text())
    pkg = json.loads((ROOT / "package.json").read_text())
    if man["version"] != pkg["version"]:
        fail(f"manifest version {man['version']} != package.json {pkg['version']}")
    if "key" in man:
        fail("manifest carries a `key` (dev-only fixed id)")
    loaded = [man["background"]["service_worker"], man["action"]["default_popup"], man["options_page"],
              *man["action"]["default_icon"].values(), *man["icons"].values(),
              *(js for cs in man["content_scripts"] for js in cs["js"])]
    for page in stage.glob("*.html"):
        loaded += re.findall(r'<script[^>]*src="([^"]+)"', page.read_text())
        loaded += re.findall(r'<link[^>]*href="(?!https?:)([^"]+)"', page.read_text())
    for f in loaded:
        if not (stage / f).is_file():
            fail(f"{f} is loaded but not in the release")
    declared, justified = set(man["permissions"]), justified_permissions()
    if justified is None:
        print("note: no permission table named (ONLYREAD_STORE_LISTING) or the file is missing; permissions not checked against the store listing")
    elif declared != justified:
        fail(f"permissions differ from the permission table: undocumented {sorted(declared - justified)}, "
             f"documented but not requested {sorted(justified - declared)}")
    if any(f.suffix == ".map" or f.name.startswith(".") for f in stage.rglob("*")):
        fail("a source map or hidden file is staged")


def git_state(strict: bool) -> str:
    head = subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=ROOT, capture_output=True, text=True).stdout.strip()
    dirty = subprocess.run(["git", "status", "--porcelain", "--untracked-files=no"], cwd=ROOT, capture_output=True, text=True).stdout.strip()
    if dirty and strict:
        fail("uncommitted changes; a release must match a commit (commit, or drop --strict for a test build)")
    return f"{head}{' + uncommitted changes' if dirty else ''}"


def main() -> int:
    strict = "--strict" in sys.argv
    commit = git_state(strict)
    version = json.loads((EXT / "manifest.json").read_text())["version"]
    out_dir = ROOT / "bundles"
    out_dir.mkdir(exist_ok=True)
    zip_path = out_dir / f"onlyread-{version}.zip"
    stage = ROOT / "bundles" / "_stage" / "onlyread"

    print("building distribution bundle (ONLYREAD_DIST=1)…")
    run_build(dist=True)
    try:
        if stage.exists():
            shutil.rmtree(stage.parent)
        stage.mkdir(parents=True)
        for name in RUNTIME:
            shutil.copy2(EXT / name, stage / name)
        # The working copy's `key` pins dev builds to the store's ID; the store refuses an upload that carries one, and an
        # unpacked copy with it would collide with the store install, so the release goes without it.
        staged = json.loads((stage / "manifest.json").read_text())
        if staged.pop("key", None) is not None:
            (stage / "manifest.json").write_text(json.dumps(staged, indent=2, ensure_ascii=False) + "\n")
        (stage / "dist").mkdir()
        for js in DIST_JS:
            src = EXT / "dist" / js
            if not src.exists():
                raise SystemExit(f"missing built file: {src} (build failed?)")
            shutil.copy2(src, stage / "dist" / js)
        shutil.copytree(EXT / "assets", stage / "assets")
        for name, src in LEGAL.items():
            if not src.is_file():
                raise SystemExit(f"missing {src}")
            shutil.copy2(src, stage / name)
        # Release manifest: declarativeNetRequestFeedback only feeds the dev-only onRuleMatchedDebug logger.
        man = json.loads((stage / "manifest.json").read_text())
        man["permissions"] = [p for p in man["permissions"] if p != "declarativeNetRequestFeedback"]
        # The account page frames the settings page only from Pro's own origin in a release: the local mock's origins are
        # for development (a release's service address is always Pro's, policy.ts normalizePolicy).
        for war in man.get("web_accessible_resources", []):
            war["matches"] = [m for m in war["matches"] if m.startswith("https://pro.onlyread.ai/")]
        (stage / "manifest.json").write_text(json.dumps(man, indent=2) + "\n")

        # The shipped default policy carries the dev sink URL; the dist build ignores it at runtime, but a
        # release must not contain a localhost endpoint at all (store review, and no accidental reporting).
        bg = (stage / "dist" / "background.js").read_text()
        for lit in ('"http://localhost:4173/__audit"', "'http://localhost:4173/__audit'"):
            bg = bg.replace(lit, "null")
        (stage / "dist" / "background.js").write_text(bg)
        verify(stage)

        with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
            for f in sorted(stage.rglob("*")):
                if f.is_file():
                    z.write(f, f.relative_to(stage.parent))
        # Chrome Web Store upload: manifest.json at the zip root.
        store_zip = out_dir / f"onlyread-{version}-webstore.zip"
        with zipfile.ZipFile(store_zip, "w", zipfile.ZIP_DEFLATED) as z:
            for f in sorted(stage.rglob("*")):
                if f.is_file():
                    z.write(f, f.relative_to(stage))
        size_kb = zip_path.stat().st_size / 1024
        files = sum(1 for _ in stage.rglob("*") if _.is_file())
    finally:
        shutil.rmtree(stage.parent, ignore_errors=True)
        print("restoring the dev build…")
        run_build(dist=False)

    sha = hashlib.sha256(store_zip.read_bytes()).hexdigest()[:16]
    print(f"\n  release checks passed · version {version} · commit {commit}")
    print(f"  {store_zip.relative_to(ROOT)}  (Chrome Web Store upload, sha256 {sha}…)")
    print(f"  {zip_path.relative_to(ROOT)}  ({files} files, {size_kb:.0f} KB, to load unpacked)\n")
    print("Send that zip. Tell your friend to:")
    print("  1. Unzip it (gives an `onlyread` folder).")
    print("  2. Open chrome://extensions, turn on Developer mode (top right).")
    print("  3. Click 'Load unpacked' and pick the `onlyread` folder.")
    print("  4. A setup window opens: Continue signs in to OnlyRead Pro, the AI judge; or open")
    print("     'Your own key' and paste a provider key, then Save and test.")
    print("  5. Try the demo on one of the sites offered (or Skip demo): one change, refused.")
    print("  6. Switch on more sites from the popup or the settings page. Chrome shows a")
    print("     'started debugging this browser' banner while a site is guarded: that is how")
    print("     OnlyRead inspects requests.")
    print("  A release always enforces, and guards during agent sessions by default (settings:")
    print("  When to protect -> Always to guard all the time).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
