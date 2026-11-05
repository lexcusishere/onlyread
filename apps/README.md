# apps/: one directory per target system

Everything specific to a target application lives here, so a system can be picked up
again later without hunting through the repo.

    apps/<app>/
      site.json              display name, description, official icon URL, verified flag (marketplace tile), and an
                             optional domainsNote printed under the README's Domains line
      policy.json            domains, telemetry and blocked-path lists for the site profile (built by harness/site/build_site.py)
      sessions/<name>/       recorded sessions (decisions, observations, system, server-log, netlog)
      labels.jsonl           read/write/telemetry label per endpoint, from the recorded test sessions
      query-schema.json      the reviewed query schema: which query keys are volatile per endpoint (harness/site/query_schema.py,
                             build_site.py compiles every site's into the extension)
      replay.jsonl           the labeled requests the CI replay sends (harness/site/replay_corpus.py, e2e/replay.spec.ts)
      scores.jev.jsonl       offline Jev score per labeled endpoint (harness/judge/judge_jev.py --all, OpenRouter or gateway)
      scores.jev.live.jsonl  best live Jev score per endpoint from the sessions (rebuild: harness/site/app_report.py apps/<app>)
      scores.llm.<model>.jsonl  offline LLM scores (harness/judge/judge_llm.mts), git-ignored. Summary: harness/judge/llm_summary.py apps/<app>
      cache.json             verdict-cache import built from labels (harness/site/labels_to_cache.py)
      coverage.json          what was tested: passes / refused (and leakCheck) for README.md and docs/SITES.md. outOfScope goes
                             on the site's card too
      how-it-works.md        optional: a site with a mechanism of its own explains it, and build_site.py appends it to README.md
      README.md              what was tested and how, written by harness/site/build_site.py from site.json, coverage.json
                             and how-it-works.md

Typical loop for a new app (the extension side is driven with `harness/ctl.py`: policy, mode, secrets, cache import, reload):

    python3 harness/site/sink_dump.py apps/<app>/sessions/<name> --domains <domains>
    python3 harness/site/label.py apps/<app>/sessions --labels apps/<app>/labels.jsonl   # then review every '?'
    python3 harness/site/app_report.py apps/<app>
    python3 harness/lib/evaluate.py --labels apps/<app>/labels.jsonl --scores apps/<app>/scores.jev.jsonl
    python3 harness/site/compare.py apps/<app>/sessions --labels apps/<app>/labels.jsonl
    python3 harness/site/labels_to_cache.py apps/<app>/labels.jsonl --out apps/<app>/cache.json

`apps/fixture/` holds the bring-up sessions against the local fixture app and the real-profile
Claude in Chrome gate.

Each app also ships as a site profile the popup can switch on: `python3 harness/site/build_site.py <app> "<Name>"`
turns `apps/<app>/policy.json` (domains, telemetry, blocked paths, shapes) and `apps/<app>/cache.json`
into `extension/policy/sites/<app>.json`, and writes `docs/SITES.md` from every app's `coverage.json`. Re-run it after relabeling. Judge settings in the app
policy files are informational now. The global policy holds them.

## Sessions are local only

`apps/<app>/sessions/` holds raw sink dumps: request bodies, account identifiers, message text and
session tokens. The directory is git-ignored and is never published. Everything derived from it and
meant to be shared (`labels.jsonl`, `scores.*.jsonl`, `cache.json`, `coverage.json`, `README.md`) is
scrubbed of account identifiers before commit. Run the identifier check in `harness/scrub_check.py`
before publishing.
