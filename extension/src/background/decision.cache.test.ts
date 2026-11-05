import { describe, it, expect } from 'vitest';
import { decide } from './decision';
import { fingerprint } from './fingerprint';
import { defaultPolicy } from './policy';
import { resolveEffective } from './sites';
import type { Policy, RequestRecord, Source } from '../shared/types';
type Verdict = 'allow' | 'block';
import type { Judge } from './judge/types';

// A saved verdict belongs to one operation. Only label verdicts are reused (decide() never
// saves a judge's), so each collision case seeds a label read allowance and checks that a different
// operation cannot use it. The judge here always refuses: a request gets through only by a wrong cache hit.
const policy = (): Policy => {
  const p = defaultPolicy();
  p.customSites = [{ id: 'ex', name: 'ex', domains: ['example.com', 'facebook.com', 'x.com'], enabled: true }];
  p.effective = resolveEffective(p);
  return p;
};
const rec = (url: string, body: string): RequestRecord => {
  const f = fingerprint('POST', url, 'application/json', body, true);
  return {
    ts: 0, tabId: 1, requestId: 'r', method: 'POST', url, host: f.host, path: f.path, queryKeys: f.queryKeys,
    contentType: 'application/json', resourceType: 'XHR', hasBody: true, bodyPreview: body, bodyShape: f.shape,
    fingerprint: f.fingerprint, lastUiActions: [],
  };
};
const memCache = () => {
  const m = new Map<string, { verdict: Verdict; pWrite: number; source: Source }>();
  return {
    m,
    get: async (fp: string) => m.get(fp),
    put: async (fp: string, verdict: Verdict, pWrite: number, source: Source) => { m.set(fp, { verdict, pWrite, source }); },
    touch: async () => {},
  };
};
const refusing = { name: 'jev', classify: async () => ({ pWrite: 0.99, latencyMs: 1, model: 'stub' }) } as unknown as Judge;

/** A label read label for `seed`, then `probe`: the probe must not be answered from that label. */
async function notReused(seed: [string, string], probe: [string, string]) {
  const cache = memCache();
  await cache.put(rec(...seed).fingerprint, 'allow', 0.01, 'label');
  const d = await decide(rec(...probe), { policy: policy(), judge: refusing, cache });
  expect(d.source).not.toBe('cache');
  expect(d.action).toBe('fail');
}
/** A label read label for `seed` is used for `probe` (same operation). */
async function reused(seed: [string, string], probe: [string, string]) {
  const cache = memCache();
  await cache.put(rec(...seed).fingerprint, 'allow', 0.01, 'label');
  const d = await decide(rec(...probe), { policy: policy(), judge: refusing, cache });
  expect(d).toMatchObject({ source: 'cache', reason: 'cached:label', action: 'continue' });
}

// The hit count is bookkeeping; a storage failure there must not fail (or delay) the request.
describe('cache bookkeeping is off the request path', () => {
  const read: [string, string] = ['https://example.com/rpc?action=read', '{"id":1}'];
  it('a label verdict is returned when touching its entry rejects, or throws', async () => {
    for (const touch of [async () => { throw new Error('QUOTA_BYTES'); }, () => { throw new Error('sync'); }]) {
      const cache = memCache();
      cache.touch = touch as () => Promise<void>;
      await cache.put(rec(...read).fingerprint, 'allow', 0.01, 'label');
      const d = await decide(rec(...read), { policy: policy(), judge: refusing, cache });
      expect(d).toMatchObject({ source: 'cache', reason: 'cached:label', action: 'continue' });
    }
  });
});

describe('saved label verdicts stay with their operation', () => {
  it('a sanity check: the same request does reuse its label label', () => reused(['https://example.com/rpc?action=read', '{"id":1}'], ['https://example.com/rpc?action=read', '{"id":1}']));

  it('?action=read does not cover ?action=delete', () => notReused(['https://example.com/rpc?action=read', '{"id":1}'], ['https://example.com/rpc?action=delete', '{"id":1}']));
  it('a selector no list names: ?procedure=read does not cover ?procedure=delete', () => notReused(['https://example.com/rpc?procedure=read', '{"id":1}'], ['https://example.com/rpc?procedure=delete', '{"id":1}']));

  // Third pass: numbers are not ids by spelling.
  for (const key of ['action', 'op', 'procedure']) {
    it(`numeric selector: ?${key}=1 does not cover ?${key}=2`, () => notReused([`https://example.com/rpc?${key}=1`, '{}'], [`https://example.com/rpc?${key}=2`, '{}']));
  }
  it('a key a reviewed schema lists as volatile does fold: Facebook\'s request counter', () => reused(['https://www.facebook.com/ajax/bnzai?__req=1f', '{}'], ['https://www.facebook.com/ajax/bnzai?__req=2a', '{}']));
  it('the same key on an endpoint the schema does not list keeps its value', () => notReused(['https://www.facebook.com/api/other?__req=1', '{}'], ['https://www.facebook.com/api/other?__req=2', '{}']));

  // Repeated selectors: whichever value the server honours, no reading is safe.
  it('a repeated selector cannot use a label, in either order', async () => {
    await notReused(['https://example.com/rpc?action=read&action=delete', '{}'], ['https://example.com/rpc?action=delete&action=read', '{}']);
    await notReused(['https://example.com/rpc?action=read&action=delete', '{}'], ['https://example.com/rpc?action=read&action=delete', '{}']); // =? itself
  });

  const bodies: [string, string, string][] = [
    ['a batch of reads vs one with a delete', '[{"action":"read","id":1}]', '[{"action":"read","id":1},{"action":"delete","id":2}]'],
    ['operation names with a space (pair A)', '[{"action":"read items","id":1}]', '[{"action":"delete items","id":1}]'],
    ['a known read, then an unrepresentable operation (pair B)', '[{"action":"read","id":1}]', '[{"action":"read","id":1},{"action":"delete items","id":2}]'],
    ['numeric body codes', '{"op":1,"id":1}', '{"op":2,"id":1}'],
    ['overlength operation names', `{"action":"read${'x'.repeat(40)}"}`, `{"action":"delete${'x'.repeat(40)}"}`],
  ];
  for (const [name, a, b] of bodies) {
    it(`body: ${name}`, () => notReused(['https://example.com/batch', a], ['https://example.com/batch', b]));
  }

  it('a label allow is not reused when part of the operation is unknown; a label block still holds', async () => {
    const cache = memCache();
    const long = rec('https://example.com/batch', JSON.stringify(Array.from({ length: 13 }, () => ({ action: 'read' }))));
    expect(long.fingerprint).toContain('more=?');
    await cache.put(long.fingerprint, 'allow', 0.01, 'label');
    expect((await decide(long, { policy: policy(), judge: refusing, cache })).source).not.toBe('cache');
    const odd = rec('https://example.com/rpc?op=' + 'x'.repeat(200), '{"id":1}');
    await cache.put(odd.fingerprint, 'block', 0.99, 'label');
    const d = await decide(odd, { policy: policy(), judge: { name: 'jev', classify: async () => ({ pWrite: 0.01, latencyMs: 1, model: 'stub' }) } as unknown as Judge, cache });
    expect(d).toMatchObject({ source: 'cache', action: 'fail' });
  });
});

// X runs the operation its queryId names; the fingerprint folds the queryId into {id}.
describe('an X GraphQL label allow holds only for the queryId it was recorded with', () => {
  const x = (id: string, name: string, bodyId = id): [string, string] => [`https://x.com/i/api/graphql/${id}/${name}`, JSON.stringify({ variables: { tweet_id: '123' }, queryId: bodyId })];
  it('the recorded queryId reuses the label', () => reused(x('F6gikc1Bwzry7oHMrdrYzg', 'usePremiumPaywallOnLoadMutation'), x('F6gikc1Bwzry7oHMrdrYzg', 'usePremiumPaywallOnLoadMutation')));
  it('another operation\'s queryId under the same name does not', () => notReused(x('F6gikc1Bwzry7oHMrdrYzg', 'usePremiumPaywallOnLoadMutation'), x('lI07N6Otwv1PhnEgXILM7A', 'usePremiumPaywallOnLoadMutation')));
  it('nor does a body that names another queryId', () => notReused(x('F6gikc1Bwzry7oHMrdrYzg', 'usePremiumPaywallOnLoadMutation'), x('F6gikc1Bwzry7oHMrdrYzg', 'usePremiumPaywallOnLoadMutation', 'lI07N6Otwv1PhnEgXILM7A')));
});

describe('judge verdicts are never reused', () => {
  it('a judged read does not answer the next request, even an identical one', async () => {
    const cache = memCache();
    let calls = 0;
    const counting = { name: 'jev', classify: async () => { calls++; return { pWrite: 0.01, latencyMs: 1, model: 'stub' }; } } as unknown as Judge;
    await decide(rec('https://example.com/rpc?action=read', '{}'), { policy: policy(), judge: counting, cache });
    await decide(rec('https://example.com/rpc?action=read', '{}'), { policy: policy(), judge: counting, cache });
    expect(calls).toBe(2);
    expect(cache.m.size).toBe(0);
  });
});
