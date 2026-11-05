// Runs a Mind2Web raw-dump session (network HAR + Playwright action trace) through OnlyRead's decision
// pipeline, as a site a user added (no decoder, no site rules), with Jev alone. Mind2Web is CC BY 4.0
// (Deng et al., NeurIPS 2023); samples live in harness/eval/mind2web/ (git-ignored).
//
//   npx tsx harness/mind2web/mind2web.mts <sample dir> <guarded domain>      e.g. harness/eval/mind2web/delta delta.com
//
// The sample dir holds the unzipped session.har.zip (a .har plus body files) and trace/trace.trace from the
// task's trace.zip. Requests to other hosts are not guarded by OnlyRead, so they are counted, not judged.
import fs from 'node:fs';
import path from 'node:path';
import { JevJudge } from '../../extension/src/background/judge/jev';
import { bodyShape, pathTemplate, previewBody, queryShape } from '../../extension/src/background/fingerprint';
import { decide, type CacheLike } from '../../extension/src/background/decision';
import { defaultPolicy, normalizePolicy } from '../../extension/src/background/policy';
import type { RequestRecord, UiAction } from '../../extension/src/shared/types';

/** A HAR's `_file` names a body saved beside it; resolved only inside that folder, so a crafted dump cannot read other files. */
function bodyFile(dir: string, rel: string): string | undefined {
  const base = path.resolve(dir);
  const p = path.resolve(base, rel);
  return p.startsWith(base + path.sep) ? p : undefined;
}


const [dir, domain] = process.argv.slice(2);
if (!dir || !domain) { console.error('usage: npx tsx harness/mind2web/mind2web.mts <sample dir> <guarded domain>'); process.exit(2); }
const env = fs.existsSync('.env') ? Object.fromEntries(fs.readFileSync('.env', 'utf8').split('\n').filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()])) : {};
const key = process.env.OPENROUTER_API_KEY ?? env.OPENROUTER_API_KEY;
if (!key) { console.error('OPENROUTER_API_KEY is not set'); process.exit(2); }

type HarEntry = { startedDateTime: string; _resourceType?: string; request: { method: string; url: string; headers: { name: string; value: string }[]; postData?: { mimeType?: string; text?: string; _file?: string } } };
const harFile = fs.readdirSync(dir).find((f) => f.endsWith('.har'));
if (!harFile) { console.error(`no .har in ${dir}`); process.exit(2); }
const entries: HarEntry[] = JSON.parse(fs.readFileSync(path.join(dir, harFile), 'utf8')).log.entries;

// User actions from the Playwright trace: clicks, typing, selections, with wall-clock times.
const actions: UiAction[] = [];
const tracePath = path.join(dir, 'trace', 'trace.trace');
if (fs.existsSync(tracePath)) {
  for (const line of fs.readFileSync(tracePath, 'utf8').split('\n')) {
    if (!line) continue;
    const ev = JSON.parse(line);
    const m = ev.metadata ?? ev;
    const api: string = m.apiName ?? '';
    const type = /\.(click|dblclick|tap|check)$/.test(api) ? 'click' : /\.(fill|type|press|clear)$/.test(api) ? 'keydown' : /\.select_option$/.test(api) ? 'change' : null;
    if (type && m.wallTime) actions.push({ type, tag: 'element', ts: m.wallTime, url: '' } as UiAction);
  }
}
actions.sort((a, b) => a.ts - b.ts);

const guarded = (host: string) => host === domain || host.endsWith(`.${domain}`);
const policy = normalizePolicy({ ...defaultPolicy(), mode: 'enforce', customSites: [{ id: 'm2w', name: domain, domains: [domain], enabled: true }] });
const noCache: CacheLike = { get: async () => undefined, touch: async () => {} };
const judge = new JevJudge({ apiKey: key, endpoint: 'https://openrouter.ai/api/v1/systemone', model: 'typesafe/jev-1.13', budgetMs: 3000 });

function bodyOf(e: HarEntry): string | undefined {
  const pd = e.request.postData;
  if (!pd) return undefined;
  if (pd.text) return pd.text;
  if (!pd._file) return undefined;
  const file = bodyFile(dir!, pd._file);
  if (!file) return undefined;
  const buf = fs.readFileSync(file);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { return undefined; }
}

const rows: { host: string; method: string; url: string; shape: string; stage: string; final: string; p?: number; afterAction: boolean }[] = [];
let thirdParty = 0, safe = 0;
const work = entries.filter((e) => {
  const u = new URL(e.request.url);
  if (['GET', 'HEAD', 'OPTIONS'].includes(e.request.method)) { safe++; return false; }
  if (!guarded(u.hostname)) { thirdParty++; return false; }
  return true;
});
await Promise.all(Array.from({ length: 4 }, async (_, w) => {
  for (let i = w; i < work.length; i += 4) {
    const e = work[i]!;
    const u = new URL(e.request.url);
    const ct = e.request.headers.find((h) => h.name.toLowerCase() === 'content-type')?.value ?? e.request.postData?.mimeType;
    const body = bodyOf(e);
    const hasBody = Boolean(e.request.postData);
    const ts = Date.parse(e.startedDateTime);
    const recent = actions.filter((a) => a.ts <= ts && ts - a.ts <= 1500).reverse();
    const shape = bodyShape(ct, body, hasBody);
    const pv = previewBody(ct, body);
    const rec: RequestRecord = {
      ts, tabId: 1, requestId: `m2w-${i}`, method: e.request.method, url: e.request.url, host: u.hostname, path: u.pathname,
      queryKeys: [...new Set(u.searchParams.keys())].sort(), contentType: ct, resourceType: e._resourceType === 'document' ? 'Document' : 'XHR',
      hasBody, bodyPreview: pv.preview, bodyTruncated: pv.truncated, bodyFull: pv.truncated ? body : undefined,
      bodyShape: shape, fingerprint: `${e.request.method} ${u.hostname}${pathTemplate(u.pathname)}${queryShape(u.searchParams)} ${shape}`, lastUiActions: recent,
    };
    const d = await decide(rec, { policy, judge, cache: noCache });
    rows.push({ host: u.hostname, method: e.request.method, url: e.request.url, shape, stage: `${d.source}:${d.reason.split('(')[0]}`, final: d.action === 'continue' ? 'pass' : 'refuse', p: d.pWrite, afterAction: recent.length > 0 });
  }
}));

const by = (f: (r: (typeof rows)[number]) => string) => rows.reduce<Record<string, number>>((m, r) => { const k = f(r); m[k] = (m[k] ?? 0) + 1; return m; }, {});
const zone = (r: (typeof rows)[number]) => (r.stage.startsWith('rule:') ? `rule (${r.stage.slice(5)})` : r.final === 'pass' ? 'allowed by Jev' : /review-band/.test(r.stage) ? 'second judge' : 'refused by Jev');
console.log(`${path.basename(dir)} (${domain}): ${entries.length} requests: ${safe} GET/HEAD/OPTIONS (allowed by rule), ${thirdParty} write-capable to other hosts (not guarded), ${rows.length} write-capable to ${domain} judged`);
console.log(`user actions in the trace: ${actions.length}; bodies found for ${work.filter((e) => bodyOf(e) !== undefined).length} of ${work.length}`);
console.log('where the judged requests land:', by(zone));
for (const r of [...rows].sort((a, b) => (b.p ?? 0) - (a.p ?? 0))) {
  console.log(`  ${zone(r).padEnd(18)} ${r.p !== undefined ? r.p.toFixed(2) : '  - '} ${r.afterAction ? 'after action' : '            '} ${r.method} ${r.url.replace(/\?.*/, '').slice(0, 90)}  ${r.shape.slice(0, 40)}`);
}
