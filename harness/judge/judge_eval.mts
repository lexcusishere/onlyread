// Scores judge configurations on the labeled requests of the verified sites. Every request goes through
// the extension's own decision function (rules, site decoders, then the judge) with the site switched on
// and an empty verdict cache, so the numbers describe what ships for a request nobody has labeled yet.
//
//   npx tsx harness/judge/judge_eval.mts <config> [<config> …]
//   EVAL_SITE_MODE=custom npx tsx harness/judge/judge_eval.mts <config>
//
// Site modes:
//   verified (default)  the site's profile is on: its decoders, rules and allow-lists apply
//   custom              the site is guarded as a site a user added: no decoder, no site rules or lists,
//                       only the generic rules and the judge. An estimate of how OnlyRead does on a site
//                       nobody has verified (optimistic: these sites shaped the generic rules and prompt)
//
// Configs:
//   jev+openrouter:<review model>     Jev first, then the review model in the uncertain band (OpenRouter)
//   jev+vercel:<review model>         the same through the Vercel AI Gateway (AI_GATEWAY_API_KEY)
//   jev+anthropic:<review model>      Jev on OpenRouter, the review model straight from Anthropic (ANTHROPIC_API_KEY);
//                                     the same slug as above (anthropic/claude-haiku-5.5), turned into Anthropic's id
//   jev:vercel | jev:openrouter       Jev alone, no review model: its uncertain band is refused
//   rules-only                        no AI: every request the rules and decoders leave is unsure, so refused
//
// Read tracking (EVAL_READ_TRACKING=on|off): the labeled read-tracking requests join the set (a label of
// `read-tracking`, or a write the extension's coded checks name, background/read-tracking.ts), X too, and the policy's
// allowReadTracking and the judge's question follow the mode (judge/state.ts questionFor). Off, they count as writes,
// which must be refused; on, they should pass, while every other write is still refused.
//
// The one number that must be zero is "writes passed"; "reads passed" is how usable the site stays.
// Keys come from the environment or ./.env (OPENROUTER_API_KEY, AI_GATEWAY_API_KEY, ANTHROPIC_API_KEY). Per-request results go to
// harness/eval/out/ (git-ignored); the summary is printed and appended to harness/eval/summary.jsonl (also git-ignored).
import fs from 'node:fs';
import path from 'node:path';
import { JevJudge } from '../../extension/src/background/judge/jev';
import { WRITE_QUESTION, buildJudgeState } from '../../extension/src/background/judge/state';
import { LlmJudge, llmModelFor } from '../../extension/src/background/judge/llm';
import { reviewModelSpec } from '../../extension/src/shared/providers';
import { RulesOnlyJudge } from '../../extension/src/background/judge/rules-only';
import type { Judge } from '../../extension/src/background/judge/types';
import { bodyShape, fingerprint, pathTemplate, previewBody, queryDiscriminators, queryShape } from '../../extension/src/background/fingerprint';
import { decide, type CacheLike } from '../../extension/src/background/decision';
import { readTrackingRequest } from '../../extension/src/background/read-tracking';
import { defaultPolicy, normalizePolicy } from '../../extension/src/background/policy';
import type { Policy, RequestRecord } from '../../extension/src/shared/types';

/** The shipped budgets (extension/policy/default.json): past them the request is refused. */
const BUDGET = { jev: Number(process.env.EVAL_JEV_BUDGET_MS ?? 3000), chat: 6000 };   // EVAL_JEV_BUDGET_MS: benchmarking only
const READ_TRACKING = process.env.EVAL_READ_TRACKING === 'on' ? 'on' : process.env.EVAL_READ_TRACKING === 'off' ? 'off' : undefined;
const APPS = READ_TRACKING ? ['gmail', 'calendar', 'linear', 'linkedin', 'facebook', 'x'] : ['gmail', 'calendar', 'linear', 'linkedin', 'facebook'];
const env = fs.existsSync('.env') ? Object.fromEntries(fs.readFileSync('.env', 'utf8').split('\n').filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()])) : {};
const openrouterKey = process.env.OPENROUTER_API_KEY ?? env.OPENROUTER_API_KEY;
const vercelKey = process.env.AI_GATEWAY_API_KEY ?? env.AI_GATEWAY_API_KEY;
const anthropicKey = process.env.ANTHROPIC_API_KEY ?? env.ANTHROPIC_API_KEY;

/** `bench: false`: a label kept for the site, left out of the benchmark (its `bench_note` says why). */
type Label = { fingerprint: string; label: string; sample_url: string; sample_body: string | null; count?: number; bench?: boolean };
type Context = { secondsSinceUserAction: number | null; duringPageLoad: boolean; secondsSincePageLoad: number | null; timesSeenOnThisPage: number };
type Case = { app: string; label: 'read' | 'write' | 'telemetry'; readTracking?: boolean; count: number; rec: RequestRecord; group: string; context?: Context; row: number; variant: number };
/** EVAL_EXPORT_VARIANTS=K (export only): up to K recorded requests with distinct bodies per labeled operation. */
const VARIANTS = Math.max(1, Number(process.env.EVAL_EXPORT_VARIANTS ?? 1));
let rowCounter = 0;

/** Timing context for every recorded decision of one session, from the session's own records: the tab's
 *  user actions (every action that was followed by a request within 1.5 s, merged), its page loads
 *  (main-frame requests in the browser's log) and how often the same request appeared on that page before. */
function addContext(recs: Array<Record<string, any>>, obs: Array<Record<string, any>>): void {
  const actions = new Map<number, number[]>(), loads = new Map<number, number[]>();
  for (const d of recs) for (const a of d.lastUiActions ?? []) if (a.ts) { if (!actions.has(d.tabId)) actions.set(d.tabId, []); actions.get(d.tabId)!.push(a.ts); }
  for (const o of obs) if (o.type === 'main_frame') { if (!loads.has(o.tabId)) loads.set(o.tabId, []); loads.get(o.tabId)!.push(o.ts); }
  for (const m of [actions, loads]) for (const [k, v] of m) m.set(k, [...new Set(v)].sort((a, b) => a - b));
  const before = (xs: number[] | undefined, t: number) => { let r: number | undefined; for (const x of xs ?? []) { if (x <= t) r = x; else break; } return r; };
  const seen = new Map<string, number>();
  for (const d of [...recs].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0))) {
    if ((d.kind ?? 'decision') !== 'decision' || !d.url || !d.ts) continue;
    const load = before(loads.get(d.tabId), d.ts);
    const act = before(actions.get(d.tabId), d.ts);
    const sinceAct = act !== undefined && (load === undefined || act >= load) ? Math.min(600, Math.round((d.ts - act) / 100) / 10) : null;
    const key = `${d.tabId} ${load} ${d.method} ${d.fingerprint}`;
    const n = seen.get(key) ?? 0; seen.set(key, n + 1);
    d.__ctx = { secondsSinceUserAction: sinceAct, duringPageLoad: load !== undefined && d.ts - load < 5000,
      secondsSincePageLoad: load !== undefined ? Math.min(3600, Math.round((d.ts - load) / 100) / 10) : null, timesSeenOnThisPage: n };
  }
}
const SITE_MODE = process.env.EVAL_SITE_MODE === 'custom' ? 'custom' : 'verified';

/** The shipped policy with just this site switched on, in enforce mode. */
const policies = new Map<string, Policy>();
function policyFor(app: string): Policy {
  if (!policies.has(app)) {
    const domains: string[] = JSON.parse(fs.readFileSync(path.join('apps', app, 'policy.json'), 'utf8')).targetDomains;
    policies.set(app, normalizePolicy(SITE_MODE === 'custom'
      ? { ...defaultPolicy(), mode: 'enforce', allowReadTracking: READ_TRACKING === 'on', customSites: [{ id: `custom-${app}`, name: app, domains, enabled: true }] }
      : { ...defaultPolicy(), mode: 'enforce', allowReadTracking: READ_TRACKING === 'on', sites: { [app]: { enabled: true } } }));
  }
  return policies.get(app)!;
}
/** An empty verdict cache: the judge decides everything the rules and decoders leave. */
const noCache: CacheLike = { get: async () => undefined, touch: async () => {} };

/** The fingerprint a site nobody verified gets: the generic body shape, no site decoder, no query schema. */
function customFingerprint(method: string, url: string, contentType: string | undefined, body: string | undefined) {
  const u = new URL(url);
  const host = u.hostname.toLowerCase();
  const template = pathTemplate(u.pathname);
  const shape = bodyShape(contentType, body, body != null);
  return { queryKeys: [...new Set(u.searchParams.keys())].sort(), shape, fingerprint: `${method} ${host}${template}${queryShape(u.searchParams)} ${shape}` };
}

let stubBodies = 0;
let duplicateVariants = 0;
function loadCases(): Case[] {
  const cases: Case[] = [];
  for (const app of APPS) {
    const dir = path.join('apps', app);
    const labels: Label[] = fs.readFileSync(path.join(dir, 'labels.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    // Trigger context (content type, UI action) from the recorded sessions when they are present locally.
    const sessDir = path.join(dir, 'sessions');
    const decisions = fs.existsSync(sessDir) ? fs.readdirSync(sessDir).flatMap((s) => {
      const f = path.join(sessDir, s, 'decisions.jsonl');
      const recs = fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
      const o = path.join(sessDir, s, 'observations.jsonl');
      addContext(recs, fs.existsSync(o) ? fs.readFileSync(o, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
      return recs;
    }) : [];
    const byFingerprint = new Map<string, typeof decisions>();
    for (const x of decisions) {
      if ((x.kind ?? 'decision') !== 'decision' || !x.method || !x.url) continue;
      const b: string | undefined = x.bodyFull ?? x.bodyPreview ?? undefined;
      let fp: string;
      try { fp = fingerprint(x.method, x.url, x.contentType ?? undefined, b, b != null).fingerprint; } catch { continue; }
      if (!byFingerprint.has(fp)) byFingerprint.set(fp, []);
      byFingerprint.get(fp)!.push(x);
    }
    for (const l of labels) {
      const method = l.fingerprint.split(' ')[0]!;
      const kinds = READ_TRACKING ? ['read', 'write', 'telemetry', 'read-tracking'] : ['read', 'write', 'telemetry'];
      if (['GET', 'HEAD', 'OPTIONS'].includes(method) || !kinds.includes(l.label)) continue;
      if (!l.sample_url) continue;   // labeled from a fingerprint alone: no request to replay
      if (l.bench === false) continue;
      const u = new URL(l.sample_url);
      // The recorded request behind the label: one whose fingerprint, recomputed today, equals the label's
      // (as harness/site/replay_corpus.py does). A URL is not enough: single-endpoint APIs (GraphQL) send every
      // operation to one URL. Prefer a recording with the click that caused it, then the longest body.
      // Prefer the first time the request appeared on its page, then the earliest recording (a retry of a
      // refused write is not what the user did). Not the one with a click attached: that would favour
      // requests that follow clicks and bias any test of timing context.
      const pool = byFingerprint.get(l.fingerprint) ?? [];
      const sorted = [...pool].sort((a, b) => (a.__ctx?.timesSeenOnThisPage ?? 0) - (b.__ctx?.timesSeenOnThisPage ?? 0)
        || (a.ts ?? 0) - (b.ts ?? 0));
      const d = sorted[0];
      // No recording with this fingerprint: the label's 200-character sample is all there is, and it hides
      // what the request does, so the case is left out (and counted) instead of scoring a stub.
      // Also when the label has no body sample at all: scoring a request with no body and no click would
      // describe something that never happened (a stale label row, or a recording that is not here).
      const first: string | undefined = d?.bodyFull ?? d?.bodyPreview ?? undefined;
      if (!d || (first === undefined && d.hasBody !== false && l.fingerprint.split(' ').pop() !== 'none')) { stubBodies++; continue; }
      // The labeled operation: the label's fingerprint (decoded where the site has a decoder) with only the
      // operation-selecting query keys, so recorded variants of one operation group together.
      const [lm, lrest] = [l.fingerprint.split(' ')[0], l.fingerprint.slice(l.fingerprint.indexOf(' ') + 1)];
      const lshape = lrest.slice(lrest.indexOf(' ') + 1);
      const group = `${app} ${lm} ${u.hostname}${pathTemplate(u.pathname)}${queryDiscriminators(u.searchParams)} ${lshape}`;
      const row = rowCounter++;
      // Variant 0 is the request every benchmark scores; further variants (export only) are other recordings
      // of the same operation with a different body, each sent from its own recorded URL.
      const picked = [d];
      const bodies = new Set([first ?? '']);
      for (const x of sorted.slice(1)) {
        if (picked.length >= VARIANTS) break;
        const b: string = x.bodyFull ?? x.bodyPreview ?? '';
        if (bodies.has(b)) continue;
        bodies.add(b); picked.push(x);
      }
      picked.forEach((x, variant) => {
        const url: string = variant === 0 ? l.sample_url : x.url;
        const vu = new URL(url);
        const contentType: string | undefined = x.contentType ?? undefined;
        // The body the extension had: the full recorded body (dev sink), else its 2 KB preview.
        const body: string | undefined = x.bodyFull ?? x.bodyPreview ?? undefined;
        const pv = previewBody(contentType, body);
        // Recomputed with today's decoders: a label recorded before a site's decoder existed gets its current shape.
        const fp = SITE_MODE === 'custom' ? customFingerprint(method, url, contentType, body) : fingerprint(method, url, contentType, body, body != null);
        const rec: RequestRecord = {
          ts: 0, tabId: 1, requestId: 'eval', method, url, host: vu.hostname, path: vu.pathname,
          queryKeys: fp.queryKeys, contentType, resourceType: x.resourceType === 'Document' ? 'XHR' : x.resourceType,
          hasBody: body != null, bodyPreview: pv.preview, bodyTruncated: pv.truncated, bodyFull: pv.truncated ? body : undefined,
          bodyShape: fp.shape, fingerprint: fp.fingerprint, lastUiActions: x.lastUiActions ?? [],
        };
        // Read tracking: labeled so, or a write the coded checks name (Gmail marked read, X's dismissed prompt, Linear's
        // notification read). Off, a write; on, a request that should pass.
        const tracking = l.label === 'read-tracking' || (l.label === 'write' && Boolean(readTrackingRequest(rec)));
        const label = (tracking ? (READ_TRACKING === 'on' ? 'telemetry' : 'write') : l.label) as Case['label'];
        cases.push({ app, label, readTracking: tracking, count: l.count ?? 1, group, row, variant, rec, context: x.__ctx });
      });
    }
  }
  // One case per labeled operation: method, endpoint, operation-selecting query keys and body shape. Labels
  // migrated to the full-query fingerprint keep one row per recorded query variant (ids, counters); counted
  // row by row, endpoints with many variants would outweigh the rest.
  const keptRow = new Map<string, number>();
  for (const c of cases) if (!keptRow.has(c.group)) keptRow.set(c.group, c.row);
  const unique = cases.filter((c) => keptRow.get(c.group) === c.row);
  duplicateVariants = cases.filter((c) => c.variant === 0).length - keptRow.size;
  return unique;
}

function build(config: string): { primary: Judge; review?: Judge; concurrency: number } {
  const [kind, ...rest] = config.split(':');
  const model = rest.join(':');
  const needKey = () => { if (!openrouterKey) throw new Error('OPENROUTER_API_KEY is not set'); return openrouterKey; };
  // The review model gets its listed thinking setting, as in the extension. Benchmarks only: EVAL_REVIEW_INSTRUCTIONS
  // (extra guidance), EVAL_REVIEW_MAX_TOKENS, EVAL_REVIEW_THINKING=off.
  const review = (apiKey: string, baseUrl: string) => new LlmJudge({ apiKey, baseUrl, model: llmModelFor(baseUrl, model), budgetMs: BUDGET.chat,
    instructions: process.env.EVAL_REVIEW_INSTRUCTIONS, maxTokens: process.env.EVAL_REVIEW_MAX_TOKENS ? Number(process.env.EVAL_REVIEW_MAX_TOKENS) : undefined,
    thinking: process.env.EVAL_REVIEW_THINKING === 'off' ? 'disabled' : reviewModelSpec(model)?.thinking });
  switch (kind) {
    case 'jev+openrouter': return {
      primary: new JevJudge({ apiKey: needKey(), endpoint: 'https://openrouter.ai/api/v1/systemone', model: 'typesafe/jev-1.13', budgetMs: BUDGET.jev }),
      review: review(needKey(), 'https://openrouter.ai/api'), concurrency: 4 };
    case 'jev+anthropic': {
      if (!anthropicKey) throw new Error('ANTHROPIC_API_KEY is not set');
      return {
        primary: new JevJudge({ apiKey: needKey(), endpoint: 'https://openrouter.ai/api/v1/systemone', model: 'typesafe/jev-1.13', budgetMs: BUDGET.jev }),
        review: review(anthropicKey, 'https://api.anthropic.com'), concurrency: 4 };
    }
    case 'jev+vercel': {
      if (!vercelKey) throw new Error('AI_GATEWAY_API_KEY is not set');
      return {
        primary: new JevJudge({ apiKey: vercelKey, endpoint: 'https://ai-gateway.vercel.sh/typesafe/v1/systemone', model: 'typesafe-ai/jev', budgetMs: BUDGET.jev }),
        review: new LlmJudge({ apiKey: vercelKey, baseUrl: 'https://ai-gateway.vercel.sh', model, budgetMs: BUDGET.chat, thinking: reviewModelSpec(model)?.thinking }),
        concurrency: 2,
      };
    }
    case 'jev': {
      // Jev alone, the review model off: an answer in the uncertain band is refused, as in the extension.
      if (model === 'vercel') {
        if (!vercelKey) throw new Error('AI_GATEWAY_API_KEY is not set');
        return { primary: new JevJudge({ apiKey: vercelKey, endpoint: 'https://ai-gateway.vercel.sh/typesafe/v1/systemone', model: 'typesafe-ai/jev', budgetMs: BUDGET.jev }), concurrency: 2 };
      }
      if (model === 'openrouter') return { primary: new JevJudge({ apiKey: needKey(), endpoint: 'https://openrouter.ai/api/v1/systemone', model: 'typesafe/jev-1.13', budgetMs: BUDGET.jev }), concurrency: 4 };
      throw new Error(`unknown Jev provider ${model}`);
    }
    case 'rules-only': return { primary: new RulesOnlyJudge(), concurrency: 8 };
    default: throw new Error(`unknown config ${config}`);
  }
}

type Row = { app: string; label: string; readTracking?: boolean; count: number; context?: Context; fingerprint: string; final: 'pass' | 'refuse'; stage: string; judged: boolean; pWrite?: number; ms: number; model?: string; reason?: string; judgeReason?: string };

async function runOne(j: { primary: Judge; review?: Judge }, c: Case): Promise<Row> {
  const t0 = Date.now();
  let judged = false;
  // Retries only transient provider errors; anything else fails closed exactly as in the extension.
  const retrying = (judge: Judge): Judge => ({ name: judge.name, budgetMs: judge.budgetMs, classify: async (rec, ask) => {
    judged = true;
    for (let i = 0; ; i++) {
      try { return await judge.classify(rec, ask); }
      catch (e) { if (i < 2 && /\b429\b|\b5\d\d\b|fetch failed|ECONNRESET/.test(String((e as Error).message))) { await new Promise((r) => setTimeout(r, 3000 * (i + 1))); continue; } throw e; }
    }
  } });
  const d = await decide(c.rec, { policy: policyFor(c.app), judge: retrying(j.primary), reviewJudge: j.review ? retrying(j.review) : undefined, cache: noCache });
  return {
    app: c.app, label: c.label, readTracking: c.readTracking, count: c.count, context: c.context, fingerprint: c.rec.fingerprint, final: d.action === 'continue' ? 'pass' : 'refuse',
    stage: `${d.source}:${d.reason.split('(')[0]}`, judged, pWrite: d.pWrite, ms: Date.now() - t0, model: d.judgeModel, judgeReason: d.judgeReason,
  };
}

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i]!); } }));
  return out;
}

const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : '-');
const quantile = (xs: number[], q: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))]! : 0; };

const configs = process.argv.slice(2);
if (!configs.length) { console.error('usage: npx tsx harness/judge/judge_eval.mts <config> [<config> …]'); process.exit(2); }
// EVAL_EXPORT=<file>: write the cases as a judge receives them (for benchmarks that run elsewhere),
// then stop. Same order as the run's output, so results line up row by row.
if (process.env.EVAL_EXPORT) {
  const all = loadCases();
  fs.writeFileSync(process.env.EVAL_EXPORT, JSON.stringify({ siteMode: SITE_MODE, question: WRITE_QUESTION,
    cases: all.map((c, i) => ({ i, app: c.app, label: c.label, ...(c.readTracking ? { readTracking: true } : {}), group: c.group, variant: c.variant, state: buildJudgeState(c.rec) })) }));
  console.log(`exported ${all.length} cases to ${process.env.EVAL_EXPORT}`);
  process.exit(0);
}
const cases = process.env.EVAL_LIMIT ? loadCases().filter((_, i, a) => i % Math.ceil(a.length / Number(process.env.EVAL_LIMIT)) === 0) : loadCases();
const writes = cases.filter((c) => c.label === 'write').length;
console.log(`site mode: ${SITE_MODE}${READ_TRACKING ? `, read tracking ${READ_TRACKING}` : ''}`);
if (duplicateVariants) console.log(`counted once: ${duplicateVariants} extra recorded variants of an already counted operation`);
if (stubBodies) console.log(`left out: ${stubBodies} labeled requests with no matching local recording`);
console.log(`eval set: ${cases.length} labeled non-GET requests (${writes} writes, ${cases.length - writes} reads and telemetry) from ${APPS.join(', ')}`);
fs.mkdirSync('harness/eval/out', { recursive: true });
for (const config of configs) {
  const j = build(config);
  const rows = await pool(cases, j.concurrency, (c) => runOne(j, c));
  // EVAL_TAG: a suffix for the output file and summary row, so variants of one config do not overwrite each other.
  const tag = `${READ_TRACKING ? `-rt-${READ_TRACKING}` : ''}${process.env.EVAL_TAG ? `-${process.env.EVAL_TAG}` : ''}`;
  fs.writeFileSync(`harness/eval/out/${SITE_MODE}-${config.replace(/[^a-z0-9.+-]/gi, '_')}${tag}.jsonl`, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const w = rows.filter((r) => r.label === 'write'), nw = rows.filter((r) => r.label !== 'write');
  const jw = w.filter((r) => r.judged), jnw = nw.filter((r) => r.judged);
  const judgedMs = rows.filter((r) => r.judged).map((r) => r.ms);
  const summary = {
    config, ...(process.env.EVAL_TAG ? { tag: process.env.EVAL_TAG } : {}), ...(READ_TRACKING ? { readTracking: READ_TRACKING } : {}), siteMode: SITE_MODE, at: new Date().toISOString(), cases: rows.length,
    writes: w.length, writesPassed: w.filter((r) => r.final === 'pass').length,
    reads: nw.length, readsPassed: nw.filter((r) => r.final === 'pass').length,
    judgedWrites: jw.length, judgedWritesPassed: jw.filter((r) => r.final === 'pass').length,
    judgedReads: jnw.length, judgedReadsPassed: jnw.filter((r) => r.final === 'pass').length,
    errors: rows.filter((r) => /judge-error|judge-timeout/.test(r.stage)).length,
    // With no review model, Jev's uncertain band is refused (the extension does the same).
    uncertainRefused: rows.filter((r) => /review-band/.test(r.stage) && r.final === 'refuse').length,
    p50ms: quantile(judgedMs, 0.5), p95ms: quantile(judgedMs, 0.95),
    // Weighted by how often each request occurred in the recordings (the label's count).
    writeTraffic: w.reduce((n, r) => n + r.count, 0), writeTrafficPassed: w.filter((r) => r.final === 'pass').reduce((n, r) => n + r.count, 0),
    readTraffic: nw.reduce((n, r) => n + r.count, 0), readTrafficPassed: nw.filter((r) => r.final === 'pass').reduce((n, r) => n + r.count, 0),
  };
  fs.appendFileSync('harness/eval/summary.jsonl', JSON.stringify(summary) + '\n');
  console.log(`\n${config}`);
  console.log(`  writes passed (must be 0): ${summary.writesPassed}/${w.length}   reads and telemetry passed: ${summary.readsPassed}/${nw.length} (${pct(summary.readsPassed, nw.length)})`);
  console.log(`  reached the judge: ${jw.length} writes (${summary.judgedWritesPassed} passed), ${jnw.length} reads (${summary.judgedReadsPassed} passed, ${pct(summary.judgedReadsPassed, jnw.length)})`);
  console.log(`  refused as uncertain (review band): ${summary.uncertainRefused}`);
  console.log(`  judge errors or timeouts: ${summary.errors}   judged latency p50 ${summary.p50ms} ms, p95 ${summary.p95ms} ms`);
  console.log(`  weighted by occurrences: writes passed ${summary.writeTrafficPassed}/${summary.writeTraffic} (${pct(summary.writeTrafficPassed, summary.writeTraffic)}), reads and telemetry passed ${summary.readTrafficPassed}/${summary.readTraffic} (${pct(summary.readTrafficPassed, summary.readTraffic)})`);
  console.log('  per site                     writes passed   reads passed     decided by (rule / judge)');
  for (const app of APPS) {
    const a = rows.filter((r) => r.app === app), aw = a.filter((r) => r.label === 'write'), ar = a.filter((r) => r.label !== 'write');
    console.log(`  ${app.padEnd(28)} ${`${aw.filter((r) => r.final === 'pass').length}/${aw.length}`.padEnd(15)} ${`${ar.filter((r) => r.final === 'pass').length}/${ar.length} (${pct(ar.filter((r) => r.final === 'pass').length, ar.length)})`.padEnd(16)} ${a.filter((r) => !r.judged).length} / ${a.filter((r) => r.judged).length}`);
  }
  const rt = rows.filter((r) => r.readTracking);
  if (READ_TRACKING) {
    console.log(`  read tracking passed (${READ_TRACKING === 'on' ? 'should pass' : 'counted as writes, must be 0'}): ${rt.filter((r) => r.final === 'pass').length}/${rt.length}`);
    for (const r of rt.filter((x) => (x.final === 'pass') !== (READ_TRACKING === 'on'))) console.log(`  READ TRACKING ${r.final === 'pass' ? 'PASSED' : 'REFUSED'} ${r.app} ${r.fingerprint.slice(0, 110)} p=${r.pWrite} (${r.stage})`);
    for (const r of nw.filter((x) => !x.readTracking && x.final !== 'pass' && x.judged)) console.log(`  READ REFUSED ${r.app} ${r.fingerprint.slice(0, 110)} p=${r.pWrite} (${r.stage})`);
  }
  for (const r of w.filter((x) => x.final === 'pass')) console.log(`  MISSED WRITE ${r.app} ${r.fingerprint.slice(0, 120)} p=${r.pWrite} (${r.stage}) — ${r.judgeReason ?? ''}`);
  const errs = rows.filter((r) => /judge-error|judge-timeout/.test(r.stage));
  if (errs.length) console.log(`  first error: ${errs[0]!.stage}`);
}
