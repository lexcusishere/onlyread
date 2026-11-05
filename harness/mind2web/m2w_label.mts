// Turns bulk-downloaded Mind2Web raw-dump tasks (harness/eval/mind2web/fetch_bulk.py) into training examples for
// the read/write judge, labeling a request only where the label is certain:
//   graphql    the body carries GraphQL text: `mutation …` → write, `query …` / `{ … }` → read
//   telemetry  a known analytics / monitoring / anti-abuse protocol endpoint (vendor list below), or one of the
//              shipped telemetryAllow patterns
// Everything else is kept with label null (counted, not trained on). The judge state is built by the extension's
// own code (fingerprint, previewBody, buildJudgeState), so the examples look exactly like production input.
//
//   npx tsx harness/mind2web/m2w_label.mts [bulk dir]      → <bulk dir>/../labeled.jsonl and a summary
//   M2W_INCLUDE=<file of annotation ids (JSON list)> limits the run to those tasks (batched labeling).
import fs from 'node:fs';
import path from 'node:path';
import { fingerprint, previewBody } from '../../extension/src/background/fingerprint';
import { buildJudgeState } from '../../extension/src/background/judge/state';
import { defaultPolicy } from '../../extension/src/background/policy';
import type { RequestRecord, UiAction } from '../../extension/src/shared/types';

/** A HAR's `_file` names a body saved beside it; resolved only inside that folder, so a crafted dump cannot read other files. */
function bodyFile(dir: string, rel: string): string | undefined {
  const base = path.resolve(dir);
  const p = path.resolve(base, rel);
  return p.startsWith(base + path.sep) ? p : undefined;
}


const bulk = process.argv[2] ?? 'harness/eval/mind2web/bulk';
const outPath = path.join(bulk, '..', 'labeled.jsonl');
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

// Protocol endpoints whose purpose is fixed by the vendor: analytics, ads conversion, RUM/monitoring, anti-bot.
const TELEMETRY: [string, RegExp][] = [
  ['adobe-analytics', /\/b\/ss\//],
  ['adobe-edge', /(^|\.)adobedc\.net\/ee\//],
  ['google-analytics', /(^|\.)(google-analytics\.com|analytics\.google\.com)\/|\/[gjr]\/collect\b|\/ccm\/collect\b/],
  ['google-ads', /(^|\.)(doubleclick\.net|googleadservices\.com|googlesyndication\.com)\/|google\.[a-z.]+\/pagead\//],
  ['facebook-pixel', /(^|\.)facebook\.com\/tr\b/],
  ['tealeaf', /\/TealeafTarget/i],
  ['sentry', /\/api\/\d+\/(envelope|store)\/|(^|\.)sentry\.io\//],
  ['newrelic', /(^|\.)(bam|bam-cell)(\.eu01)?\.nr-data\.net\//],
  ['datadog', /browser-intake-[\w-]*datadoghq\.(com|eu)\/|\/api\/v2\/(rum|logs)\b/],
  ['segment', /(^|\.)(api\.segment\.io|api\.segment\.com|cdn\.segment\.com)\//],
  ['amplitude', /(^|\.)amplitude\.com\/(2\/httpapi|batch)/],
  ['mixpanel', /(^|\.)mixpanel\.com\/(track|engage|decide)/],
  ['hotjar', /(^|\.)hotjar\.(com|io)\//],
  ['quantummetric', /(^|\.)quantummetric\.com\//],
  ['dynatrace', /\/rb_[\w-]+|(^|\.)(dynatrace|dynatrace-managed)\.com\/bf/],
  ['mpulse', /(^|\.)go-mpulse\.net\//],
  ['optimizely', /(^|\.)logx\.optimizely\.com\//],
  ['bing-uet', /(^|\.)bat\.bing\.com\//],
  ['clarity', /(^|\.)clarity\.ms\//],
  ['contentsquare', /(^|\.)contentsquare\.net\//],
  ['fullstory', /(^|\.)fullstory\.com\/rec\//],
  ['heap', /(^|\.)heapanalytics\.com\//],
  ['criteo', /(^|\.)criteo\.(com|net)\//],
  ['taboola', /(^|\.)taboola\.com\//],
  ['outbrain', /(^|\.)outbrain\.com\//],
  ['linkedin-insight', /px\.ads\.linkedin\.com\//],
  ['tiktok-pixel', /analytics\.tiktok\.com\//],
  ['snap-pixel', /tr\.snapchat\.com\//],
  ['pinterest-tag', /ct\.pinterest\.com\//],
  ['twitter-pixel', /(analytics\.twitter\.com|t\.co\/i\/adsct)/],
  ['perimeterx', /(^|\.)(perimeterx\.net|px-cdn\.net|px-cloud\.net)\/|\/api\/v2\/collector\b/],
  ['akamai-bot', /\/akam\/\d+\//],
  ['onetrust', /(^|\.)(onetrust\.com|cookielaw\.org)\//],
  ['branch', /(^|\.)api2?\.branch\.io\//],
  ['braze', /(^|\.)sdk\.[\w.-]*braze\.(com|eu)\/api\/v3\/data/],
  ['qualtrics', /(^|\.)qualtrics\.com\//],
];
const SHIPPED = defaultPolicy().telemetryAllow;

function telemetryRule(url: string, body: string | undefined): string | null {
  const u = url.replace(/^https?:\/\//, '');
  for (const [name, re] of TELEMETRY) if (re.test(u)) return name;
  if (body && /^\s*\{?\s*"?sensor_data"?\s*[:=]/.test(body)) return 'akamai-bot';
  const hit = SHIPPED.find((p) => url.includes(p));
  return hit ? `shipped:${hit}` : null;
}

/** GraphQL text in the body: write if any operation is a mutation, read if all are queries. Persisted queries
 * (an operationName with no text) are not labeled here; their names are kept for the declared-label step. */
function graphqlRule(body: string | undefined): { label: 'read' | 'write'; op: string } | null {
  if (!body) return null;
  let docs: string[] = [];
  try {
    const j = JSON.parse(body);
    for (const o of Array.isArray(j) ? j : [j]) if (o && typeof o === 'object' && typeof o.query === 'string') docs.push(o.query);
  } catch {
    try { const q = new URLSearchParams(body).get('query'); if (q) docs = [q]; } catch { /* not a form */ }
  }
  if (!docs.length) return null;
  let kinds: string[] = [];
  for (const d of docs) {
    const text = d.replace(/#[^\n]*/g, '');
    const ops = [...text.matchAll(/(?:^|\})\s*(query|mutation|subscription)\b\s*(\w*)/g)].map((m) => `${m[1]} ${m[2]}`.trim());
    if (!ops.length && /^\s*\{/.test(text)) ops.push('query');   // shorthand query
    kinds = kinds.concat(ops);
  }
  if (!kinds.length || kinds.some((k) => k.startsWith('subscription'))) return null;
  return kinds.some((k) => k.startsWith('mutation')) ? { label: 'write', op: kinds.join(',') } : { label: 'read', op: kinds.join(',') };
}

function persistedName(body: string | undefined): string | null {
  if (!body) return null;
  try {
    const j = JSON.parse(body);
    const o = Array.isArray(j) ? j[0] : j;
    if (o && typeof o === 'object' && typeof o.operationName === 'string' && typeof o.query !== 'string') return o.operationName;
  } catch { /* not JSON */ }
  return null;
}

// eTLD+1, good enough for Mind2Web's sites (two-letter country second levels like co.uk, com.au).
function site(host: string): string {
  const p = host.split('.');
  const two = p.slice(-2);
  return p.length > 2 && two[1]!.length === 2 && /^(co|com|org|net|gov|ac|edu)$/.test(two[0]!) ? p.slice(-3).join('.') : two.join('.');
}

type Entry = { startedDateTime: string; _resourceType?: string; request: { method: string; url: string; headers: { name: string; value: string }[]; postData?: { mimeType?: string; text?: string; _file?: string; params?: { name: string; value: string }[] } } };

function actionsOf(dir: string): UiAction[] {
  const p = path.join(dir, 'trace.trace');
  if (!fs.existsSync(p)) return [];
  const out: UiAction[] = [];
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    if (!line) continue;
    let ev: any; try { ev = JSON.parse(line); } catch { continue; }
    const m = ev.metadata ?? ev;
    const api: string = m.apiName ?? '';
    if (!m.wallTime) continue;
    // The extension records clicks, Enter and submits; typing itself is not an action it records.
    if (/\.(click|dblclick|tap|check)$/.test(api)) out.push({ type: 'click', tag: 'element', ts: m.wallTime, url: '' });
    else if (/\.press$/.test(api) && /enter/i.test(m.params?.key ?? '')) out.push({ type: 'enter', tag: 'element', ts: m.wallTime, url: '' });
    else if (/\.select_?option$/i.test(api)) out.push({ type: 'click', tag: 'select', ts: m.wallTime, url: '' });
  }
  return out.sort((a, b) => a.ts - b.ts);
}

const out = fs.createWriteStream(outPath);
const tally: Record<string, number> = {};
const inc = (k: string, n = 1) => { tally[k] = (tally[k] ?? 0) + n; };
const sitesWith: Record<string, Set<string>> = {};
const unlabeledShapes: Record<string, number> = {};
let tasks = 0;

const include = process.env.M2W_INCLUDE ? new Set<string>(JSON.parse(fs.readFileSync(process.env.M2W_INCLUDE, 'utf8'))) : null;
for (const id of fs.readdirSync(bulk)) {
  if (include && !include.has(id)) continue;
  const dir = path.join(bulk, id);
  if (!fs.existsSync(path.join(dir, '.done'))) continue;
  tasks++;
  if (process.env.M2W_PROGRESS) console.error(`${tasks} ${id}`);
  const task = JSON.parse(fs.readFileSync(path.join(dir, 'task.json'), 'utf8'));
  const entries: Entry[] = JSON.parse(fs.readFileSync(path.join(dir, 'session.har'), 'utf8')).log.entries;
  const doc = entries.find((e) => e._resourceType === 'document') ?? entries[0];
  const domain = doc ? site(new URL(doc.request.url).hostname) : '';
  const actions = actionsOf(dir);
  for (const [entry, e] of entries.entries()) {
    const method = e.request.method.toUpperCase();
    inc('requests');
    if (SAFE.has(method)) continue;
    let u: URL; try { u = new URL(e.request.url); } catch { continue; }
    if (!/^https?:$/.test(u.protocol)) continue;
    inc('write-capable');
    const party = u.hostname === domain || u.hostname.endsWith(`.${domain}`) ? 'first' : 'third';
    const pd = e.request.postData;
    // Playwright's HAR keeps the body in a side file and leaves `text` empty; forms may come only as `params`.
    let body: string | undefined = pd?.text || undefined;
    const file = pd?._file ? bodyFile(dir, pd._file) : undefined;
    if (body === undefined && file && fs.existsSync(file)) {
      try { body = new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(file)); } catch { body = undefined; }
    }
    if (body !== undefined && body.length > 1_000_000) body = undefined;   // uploads and media: not judged as text
    if (body === undefined && pd?.params?.length) body = new URLSearchParams(pd.params.map((p) => [p.name, p.value])).toString();
    const ct = e.request.headers.find((h) => h.name.toLowerCase() === 'content-type')?.value ?? pd?.mimeType;
    const fp = fingerprint(method, e.request.url, ct, body, Boolean(pd));
    const pv = previewBody(ct, body);
    const ts = Date.parse(e.startedDateTime);
    const rec: RequestRecord = {
      ts, tabId: 1, requestId: `${id}-${tally['write-capable']}`, method, url: e.request.url, host: fp.host, path: fp.path,
      queryKeys: fp.queryKeys, contentType: ct, resourceType: e._resourceType === 'document' ? 'Document' : 'XHR',
      hasBody: Boolean(pd), bodyPreview: pv.preview, bodyTruncated: pv.truncated, bodyFull: pv.truncated ? body : undefined,
      bodyShape: fp.shape, fingerprint: fp.fingerprint,
      lastUiActions: actions.filter((a) => a.ts <= ts && ts - a.ts <= 1500).reverse(),
    };
    const tel = telemetryRule(e.request.url, body);
    const gql = tel ? null : graphqlRule(body);
    const label = tel ? 'telemetry' : gql ? gql.label : null;
    const rule = tel ? `telemetry:${tel}` : gql ? `graphql:${gql.op.slice(0, 60)}` : null;
    const pname = label ? null : persistedName(body);
    inc(`${party}:${label ?? 'unlabeled'}`);
    if (rule) inc(`rule ${party} ${rule.split(':').slice(0, 2).join(':').replace(/^graphql:.*/, `graphql:${label}`)}`);
    if (label) (sitesWith[`${party}:${label}`] ??= new Set()).add(task.website);
    if (!label && party === 'first') { unlabeledShapes[`${method} ${fp.shape.split(/[=:,]/)[0]}`] = (unlabeledShapes[`${method} ${fp.shape.split(/[=:,]/)[0]}`] ?? 0) + 1; if (pname) inc('first: persisted-graphql (name only)'); }
    out.write(JSON.stringify({ task: id, entry, website: task.website, domain, party, label, rule, persistedName: pname, group: `${task.website} ${fp.fingerprint}`, state: buildJudgeState(rec) }) + '\n');
  }
}
out.end();

console.log(`${tasks} tasks, ${tally.requests} requests, ${tally['write-capable']} write-capable (POST/PUT/PATCH/DELETE)\n`);
for (const party of ['first', 'third']) {
  const n = ['read', 'write', 'telemetry', 'unlabeled'].map((l) => tally[`${party}:${l}`] ?? 0);
  console.log(`${party}-party: ${n.reduce((a, b) => a + b, 0)}  read=${n[0]} write=${n[1]} telemetry=${n[2]} unlabeled=${n[3]}`);
  for (const l of ['read', 'write', 'telemetry']) if (sitesWith[`${party}:${l}`]) console.log(`   ${l} found on ${sitesWith[`${party}:${l}`]!.size} websites`);
}
console.log('\nby rule:');
for (const [k, v] of Object.entries(tally).filter(([k]) => k.startsWith('rule ')).sort((a, b) => b[1] - a[1]).slice(0, 30)) console.log(`  ${String(v).padStart(6)}  ${k.slice(5)}`);
if (tally['first: persisted-graphql (name only)']) console.log(`\nfirst-party persisted GraphQL (name only, for the declared-label step): ${tally['first: persisted-graphql (name only)']}`);
console.log('\nfirst-party unlabeled, by method and body kind:');
for (const [k, v] of Object.entries(unlabeledShapes).sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`  ${String(v).padStart(6)}  ${k}`);
console.log(`\n→ ${outPath}`);
