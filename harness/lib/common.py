"""Shared loaders and joins for the OnlyRead measurement harness. Stdlib only."""
from __future__ import annotations

import json
import pathlib
from dataclasses import dataclass, field
from typing import Iterable, Iterator
from urllib.parse import urlsplit

from fingerprint import fingerprint, fingerprint_observation

SESSION_FILES = {
    "decisions": "decisions.jsonl",
    "observations": "observations.jsonl",
    "system": "system.jsonl",
    "netlog": "netlog.jsonl",
    "server_log": "server-log.json",
}


def read_jsonl(path: pathlib.Path) -> list[dict]:
    if not path.exists():
        return []
    out = []
    with path.open() as f:
        for line in f:
            line = line.strip()
            if line:
                out.append(json.loads(line))
    return out


def write_jsonl(path: pathlib.Path, rows: Iterable[dict]) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    n = 0
    with path.open("w") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
            n += 1
    return n


def host_of(url: str) -> str:
    try:
        return (urlsplit(url).hostname or "").lower()
    except ValueError:
        return ""


def path_of(url: str) -> str:
    try:
        return urlsplit(url).path
    except ValueError:
        return url


def is_target(host: str, domains: Iterable[str]) -> bool:
    h = host.lower()
    return any(h == d.lower() or h.endswith("." + d.lower()) for d in domains)


@dataclass
class Session:
    dir: pathlib.Path
    decisions: list[dict] = field(default_factory=list)
    observations: list[dict] = field(default_factory=list)
    system: list[dict] = field(default_factory=list)
    netlog: list[dict] = field(default_factory=list)
    server_log: list[dict] = field(default_factory=list)

    @classmethod
    def load(cls, d: pathlib.Path) -> "Session":
        s = cls(dir=d)
        s.decisions = [x for x in read_jsonl(d / SESSION_FILES["decisions"]) if x.get("kind", "decision") == "decision"]
        s.observations = read_jsonl(d / SESSION_FILES["observations"])
        s.system = read_jsonl(d / SESSION_FILES["system"])
        s.netlog = read_jsonl(d / SESSION_FILES["netlog"])
        sl = d / SESSION_FILES["server_log"]
        s.server_log = json.loads(sl.read_text()) if sl.exists() else []
        # The observer keeps a 2 KB raw preview; a JSON body cut there decodes as unparseable, which the live
        # extension (full body) never produced. Borrow the paired decision's full body for such observations,
        # pairing the way leak_check does: same method and URL, nearest ts within 3 s.
        by_key: dict[tuple[str, str], list[dict]] = {}
        for d in s.decisions:
            if d.get("bodyFull") and d.get("url"):
                by_key.setdefault((d.get("method", "").upper(), d["url"].split("#", 1)[0]), []).append(d)
        for o in s.observations:
            if "fingerprint" in o:
                continue
            # The observer's preview is 2048 *bytes*, so a body with multibyte text is cut before 2048 chars;
            # a decision only carries bodyFull when its own preview was truncated, so borrow whenever one pairs.
            prev = o.get("bodyPreview")
            if prev is not None and o.get("url"):
                near = [d for d in by_key.get((o.get("method", "").upper(), o["url"].split("#", 1)[0]), [])
                        if abs(d.get("ts", 0) - o.get("ts", 0)) <= 3000]
                if near:
                    d = min(near, key=lambda d: abs(d["ts"] - o["ts"]))
                    o["fingerprint"] = fingerprint(o.get("method", "POST"), o["url"], d.get("contentType"), d["bodyFull"], True).fingerprint
                    continue
            o["fingerprint"] = fingerprint_observation(o)
        return s

    def target_domains(self) -> list[str]:
        cfg = self.dir / "session.json"
        if cfg.exists():
            return json.loads(cfg.read_text()).get("targetDomains", [])
        return sorted({host_of(d["url"]) for d in self.decisions if d.get("url", "").startswith("http")})


def split_sink(rows: list[dict]) -> dict[str, list[dict]]:
    """Split a /__audit dump ({kind, payload}[]) into decisions / observations / system."""
    out: dict[str, list[dict]] = {"decisions": [], "observations": [], "system": []}
    for r in rows:
        kind, payload = r.get("kind"), r.get("payload", {})
        if kind == "decision":
            (out["system"] if payload.get("kind") == "system" else out["decisions"]).append(payload)
        elif kind == "observation":
            out["observations"].append(payload)
        elif kind == "system":
            out["system"].append(payload)
    return out


def nearest_join(left: list[dict], right: list[dict], key, window_ms: int = 3000) -> dict[int, int | None]:
    """Greedy nearest-in-time join of left rows to right rows sharing key(row). Returns left index → right index."""
    by_key: dict[object, list[tuple[int, dict]]] = {}
    for j, r in enumerate(right):
        by_key.setdefault(key(r), []).append((j, r))
    used: set[int] = set()
    out: dict[int, int | None] = {}
    for i, l in enumerate(left):
        best, best_dt = None, None
        for j, r in by_key.get(key(l), []):
            if j in used:
                continue
            dt = abs(float(r.get("ts", 0)) - float(l.get("ts", 0)))
            if dt <= window_ms and (best_dt is None or dt < best_dt):
                best, best_dt = j, dt
        if best is not None:
            used.add(best)
        out[i] = best
    return out


def iter_sessions(paths: Iterable[str]) -> Iterator[Session]:
    for p in paths:
        d = pathlib.Path(p)
        if (d / SESSION_FILES["decisions"]).exists() or (d / SESSION_FILES["observations"]).exists():
            yield Session.load(d)
        else:
            for sub in sorted(x for x in d.iterdir() if x.is_dir()):
                if (sub / SESSION_FILES["decisions"]).exists() or (sub / SESSION_FILES["observations"]).exists():
                    yield Session.load(sub)
