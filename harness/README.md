# harness

Measurement and site-onboarding tools for the extension. Python 3.11+, standard library only. The
TypeScript tools run with `npx tsx`. Run everything from the repository root.

| Folder | What is there |
|---|---|
| `./` | Everyday tools: `ctl.py` (drive the extension through the dev control channel), `scrub_check.py` (no keys or account identifiers in what git would commit), `bundle.py` (release zip), `chrome/launch.sh` |
| `lib/` | Shared code: `fingerprint.py` (the extension's own fingerprinting, through `fp_cli.mts`), `state.py` (the judge state and question), `common.py` (session loaders), `evaluate.py` (score a judge against labels), `redaction_measure.mts` (what the preview redactor leaves, over the recorded sessions, the Mind2Web recordings and planted secrets), `test_fingerprint.py` |
| `site/` | Adding and verifying a site, in workflow order: `new_app.py`, `build_site.py`, `sink_dump.py`, `label.py`, `labels_to_cache.py`, `query_schema.py`, `replay_corpus.py`, `leak_check.py`, `compare.py`, `netlog.py`, `app_report.py`, `record_fixture_session.mts` |
| `judge/` | Scoring judges on the labeled requests: `judge_eval.mts` (the real `decide()` end to end), `judge_jev.py`, `judge_llm.mts` and `llm_summary.py` |
| `mind2web/` | Running Mind2Web recordings through the pipeline (`mind2web.mts`) and turning them into labeled examples (`m2w_label.mts`) |
| `eval/` | Local results and downloaded datasets (git-ignored) |

The full add-a-site workflow is in [Adding a site](../CONTRIBUTING.md#adding-a-site).

Scripts in `site/`, `judge/` and `mind2web/` import the shared modules by adding `lib/` to `sys.path`
themselves, so each one runs directly: `python3 harness/site/label.py …`.
