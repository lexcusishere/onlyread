// The live AI judge: with an OpenRouter key (the default own-key provider), Jev and the review model, called for
// real with the shipped settings, still tell gray-zone reads from writes, every request is judged afresh (a judge's
// verdict is never reused), and the judge keeps up with a burst like a busy page's. The rest of the suite uses
// recorded or stand-in judges; only this one would notice OpenRouter changing its API, the model being retired, the
// state we send drifting, or the judge growing slower than OnlyRead waits.
//
// Not part of `npm run e2e`: it makes paid calls and depends on a service we do not run. `npm run e2e:live` runs it
// (before each release; .github/workflows/live.yml nightly), retrying twice. A failure says which kind it is: the
// judge was slow or unreachable (a timeout or a network error: OpenRouter, worth a retry) or it judged wrongly (a
// read refused or a write allowed on its own verdict: ours to look into). Skipped when no key is set or OpenRouter
// refuses the preflight.
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { PROVIDERS } from '../extension/src/shared/providers';
import { Harness, ROOT } from './helpers';

test.describe.configure({ mode: 'serial' });

function loadKey(): string | undefined {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  const env = path.join(ROOT, '.env');
  if (!fs.existsSync(env)) return undefined;
  return fs.readFileSync(env, 'utf8').split('\n').find((l) => l.startsWith('OPENROUTER_API_KEY='))?.split('=')[1]?.trim();
}

const KEY = loadKey();
const JEV = PROVIDERS.openrouter.jev;
const h = new Harness(4221);
let ready = false;
let note = 'no OPENROUTER_API_KEY';
const SEARCH = 'POST localhost/api/search json:q';
const CREATE = 'POST localhost/api/items json:name';

type Decision = { fingerprint: string; verdict?: string; source?: string; reason: string; pWrite?: number; enforced?: boolean; latencyMs?: number };
const decisions = async (fp: string) => ((await h.audit()) as Decision[]).filter((e) => e.fingerprint === fp);
const show = (e: Decision | undefined) => (e ? `${e.verdict}/${e.source}/${e.reason} p=${e.pWrite} ${e.latencyMs ?? '?'} ms` : 'no decision');

/** The judge did not answer in time, or could not be reached: OpenRouter's side, not a wrong verdict. Thrown as its own
 *  error, so the run says so and the retry tries again. */
const unanswered = (e: Decision | undefined) => Boolean(e && /^(judge-timeout|judge-error)/.test(e.reason));
function failIfUnanswered(what: string, es: (Decision | undefined)[]): void {
  const slow = es.filter(unanswered);
  if (slow.length) throw new Error(`OpenRouter slow or unreachable (${what}): ${slow.map(show).join('; ')}`);
}

test.beforeAll(async () => {
  if (!KEY) return;
  const r = await fetch(JEV.endpoint, {
    method: 'POST', headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: JEV.model, state: 'ping', questions: { q: { type: 'noul', instructions: 'Is this a ping?' } } }),
  });
  ready = r.ok;
  if (!r.ok) note = `openrouter ${r.status}: ${(await r.text()).slice(0, 160)}`;
  console.log(`[live] preflight: ${ready ? 'ok' : note}`);
  if (!ready) return;
  // The shipped judge settings (default model, time limits: the harness takes them from default.json), with the
  // review model on for the gray band.
  await h.start({ mode: 'enforce', reviewBand: 'llm' });
  await h.sw.evaluate(async (key) => { await chrome.storage.local.set({ secrets: { keys: { openrouter: key } } }); }, KEY);
  await h.waitFor(async () => (await h.status()).judge === 'jev', 'jev selected');
});
test.afterAll(async () => { if (ready) await h.stop(); });

test('live: Jev lets a POST search through and blocks a POST create', async () => {
  test.skip(!ready, note);
  const searchResult = await h.pageFetch('POST', '/api/search', '{"q":"a"}');
  const createResult = await h.pageFetch('POST', '/api/items', '{"name":"jev-should-block"}');
  await h.waitFor(async () => (await decisions(CREATE)).length > 0, 'create decision');
  const search = (await decisions(SEARCH)).at(-1);
  const create = (await decisions(CREATE)).at(-1);
  console.log(`[live] search → ${searchResult}  ${show(search)}`);
  console.log(`[live] create → ${createResult}  ${show(create)}`);
  failIfUnanswered('search and create', [search, create]);
  expect(searchResult, `a read refused on the judge's verdict: ${show(search)}`).toBe('status:200');
  expect(search?.verdict === 'allow' || (search?.verdict === 'review' && !search.enforced), `the read's verdict: ${show(search)}`).toBe(true);
  expect(createResult, `a write let through on the judge's verdict: ${show(create)}`).toMatch(/^error:/);
  expect(create?.enforced).toBe(true);
  expect((await h.serverLog()).filter((e) => e.method === 'POST' && e.path === '/api/items')).toEqual([]);
});

test('live: a second identical request is judged again, not answered from a saved verdict', async () => {
  test.skip(!ready, note);
  const before = (await decisions(SEARCH)).length;
  const result = await h.pageFetch('POST', '/api/search', '{"q":"b"}');
  await h.waitFor(async () => (await decisions(SEARCH)).length > before, 'second decision');
  const searches = await decisions(SEARCH);
  failIfUnanswered('the second search', [searches.at(-1)]);
  expect(result, `the read's verdict: ${show(searches.at(-1))}`).toBe('status:200');
  expect(searches.every((e) => e.source !== 'cache')).toBe(true);
});

test('live: the judge keeps up with a burst of reads (a busy page)', async () => {
  test.skip(!ready, note);
  const N = 20;
  const before = (await decisions(SEARCH)).length;
  const t0 = Date.now();
  const results = await h.page.evaluate(async (n) => Promise.all(Array.from({ length: n }, async (_, i) => {
    try { return `status:${(await fetch('/api/search', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ q: `burst-${i}` }) })).status}`; }
    catch (e) { return `error:${(e as Error).name}`; }
  })), N);
  const ms = Date.now() - t0;
  // Every one of the burst's decisions, once the log holds them all (allowed decisions are written in batches).
  await h.waitFor(async () => (await decisions(SEARCH)).length >= before + N, 'the burst\'s decisions');
  const burst = (await decisions(SEARCH)).slice(before, before + N);
  const reasons = burst.reduce<Record<string, number>>((m, e) => { m[e.reason] = (m[e.reason] ?? 0) + 1; return m; }, {});
  const lat = burst.map((e) => e.latencyMs ?? 0).sort((a, b) => a - b);
  console.log(`[live] burst of ${N}: ${results.filter((r) => r === 'status:200').length} passed in ${ms} ms; judge latency p50=${lat[Math.floor(N / 2)]} ms max=${lat[N - 1]} ms; reasons ${JSON.stringify(reasons)}`);
  failIfUnanswered('the burst', burst);
  expect(results.filter((r) => r !== 'status:200'), `reads refused on the judge's verdict: ${JSON.stringify(reasons)}`).toEqual([]);
});
