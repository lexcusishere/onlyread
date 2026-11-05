"""Fingerprints for the Python harness, computed by the extension's own code.

There is one implementation: extension/src/background/fingerprint.ts and its site codecs (codecs/). This module
starts harness/lib/fp_cli.mts once per process (via the pinned tsx) and asks it over stdin/stdout, so harness results can
never drift from what the extension computes. The functions and the Fingerprinted fields keep the names the
harness scripts already use.
"""
from __future__ import annotations

import atexit
import json
import os
import subprocess
import threading
from dataclasses import dataclass

_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_proc: subprocess.Popen | None = None
_lock = threading.Lock()


@dataclass(frozen=True)
class Fingerprinted:
    host: str
    path: str
    query_keys: tuple[str, ...]
    template: str
    shape: str
    fingerprint: str


def _close(proc: subprocess.Popen) -> None:
    proc.stdin.close()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()
    proc.stdout.close()


def _ask(req: dict) -> dict:
    global _proc
    with _lock:
        if _proc is None or _proc.poll() is not None:
            _proc = subprocess.Popen(["npx", "--no-install", "tsx", os.path.join("harness", "lib", "fp_cli.mts")], cwd=_ROOT, text=True,
                                     stdin=subprocess.PIPE, stdout=subprocess.PIPE, bufsize=1)
            atexit.register(_close, _proc)
        _proc.stdin.write(json.dumps(req) + "\n")
        _proc.stdin.flush()
        line = _proc.stdout.readline()
    if not line:
        raise RuntimeError("fp_cli.mts exited (is node/npx available?)")
    out = json.loads(line)
    if "error" in out:
        raise ValueError(out["error"])
    return out


def fingerprint(method: str, url: str, content_type: str | None, body: str | None, has_body: bool) -> Fingerprinted:
    r = _ask({"op": "fp", "method": method, "url": url, "contentType": content_type, "body": body, "hasBody": has_body})
    return Fingerprinted(r["host"], r["path"], tuple(r["queryKeys"]), r["template"], r["shape"], r["fingerprint"])


def fingerprint_observation(obs: dict) -> str:
    """Best-effort fingerprint from a webRequest observation (no content-type header available)."""
    return _ask({"op": "obs", "obs": {k: obs.get(k) for k in ("method", "url", "bodyPreview", "bodyFull")}})["fingerprint"]


_constants: dict | None = None


def __getattr__(name: str):
    # SAFE_METHODS and QUERY_DISCRIMINATOR_KEYS come from the extension too, fetched on first use.
    global _constants
    if name in ("SAFE_METHODS", "QUERY_DISCRIMINATOR_KEYS"):
        if _constants is None:
            c = _ask({"op": "constants"})
            _constants = {"SAFE_METHODS": set(c["SAFE_METHODS"]), "QUERY_DISCRIMINATOR_KEYS": list(c["QUERY_DISCRIMINATOR_KEYS"])}
        return _constants[name]
    raise AttributeError(name)
