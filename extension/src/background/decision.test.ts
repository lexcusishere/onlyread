import { describe, it, expect } from 'vitest';
import { decide, isTargetHost, matchesAny, type CacheLike } from './decision';
import { fingerprint } from './fingerprint';
import type { Policy, RequestRecord, Source } from '../shared/types';
import type { Judge } from './judge/types';
import { defaultPolicy } from './policy';
import { resolveEffective } from './sites';

const policy = (): Policy => { const p = defaultPolicy(); p.effective = resolveEffective(p); return p; };

function rec(method: string, url: string, opts: { contentType?: string; body?: string; resourceType?: string } = {}): RequestRecord {
  const hasBody = opts.body !== undefined || opts.contentType?.startsWith('multipart') === true;
  const fp = fingerprint(method, url, opts.contentType, opts.body, hasBody);
  return {
    ts: 0, tabId: 1, requestId: 'r', method, url, host: fp.host, path: fp.path, queryKeys: fp.queryKeys,
    contentType: opts.contentType, resourceType: opts.resourceType ?? 'Fetch', hasBody, bodyPreview: opts.body,
    bodyShape: fp.shape, fingerprint: fp.fingerprint, lastUiActions: [],
  };
}

function memCache(): CacheLike & { store: Map<string, { verdict: 'allow' | 'block'; pWrite: number; source: Source }> } {
  const store = new Map();
  return {
    store,
    async get(fp) { return store.get(fp); },
    async touch() {},
  };
}

const fixedJudge = (pWrite: number, delayMs = 0): Judge => ({
  name: 'jev',
  classify: () => new Promise((r) => setTimeout(() => r({ pWrite, latencyMs: delayMs, model: 'fake' }), delayMs)),
});

describe('the judge\'s question', () => {
  it('tells the judges whether read tracking is allowed, so Jev asks the question that lets it through', async () => {
    const asks: unknown[] = [];
    const judge: Judge = { name: 'jev', classify: async (_rec, ask) => { asks.push(ask); return { pWrite: 0.1, latencyMs: 0, model: 'fake' }; } };
    const req = rec('POST', 'http://localhost/api/thing', { body: '{"a":1}' });
    await decide(req, { policy: { ...policy(), allowReadTracking: false }, judge, cache: memCache() });
    await decide(req, { policy: { ...policy(), allowReadTracking: true }, judge, cache: memCache() });
    expect(asks).toEqual([{ readTracking: false, binary: false }, { readTracking: true, binary: false }]);
  });
});

describe('binaryBody', () => {
  it('knows a compressed body by its first byte, and a binary one by its control characters; text is neither', async () => {
    const { binaryBody } = await import('./decision');
    expect(binaryBody('\u001f\u0008\u0000\u000bgarbled')).toBe(true); // gzip, as the report's preview kept it
    expect(binaryBody('\u0001\u0002\u0003\u0004\u0005\u0006abcd')).toBe(true);
    expect(binaryBody('[null,[[[1,["thread-f:1"]]]]]')).toBe(false);
    expect(binaryBody('{"a":1}')).toBe(false);
    expect(binaryBody(undefined)).toBe(false);
  });
});

describe('isTargetHost', () => {
  it('matches exact host and subdomains only', () => {
    expect(isTargetHost('app.example.com', ['example.com'])).toBe(true);
    expect(isTargetHost('example.com', ['example.com'])).toBe(true);
    expect(isTargetHost('notexample.com', ['example.com'])).toBe(false);
    expect(isTargetHost('localhost', ['localhost'])).toBe(true);
  });
});

describe('matchesAny (boundary-aware)', () => {
  it('matches a path pattern only at URL token boundaries', () => {
    expect(matchesAny('/logout', ['/logout'])).toBe(true);
    expect(matchesAny('/logout?next=1', ['/logout'])).toBe(true);
    expect(matchesAny('/api/logout/', ['/logout'])).toBe(true);
    expect(matchesAny('/client/assets/LogoutHelper.DKqVb-Lu.js', ['/logout'])).toBe(false);
    expect(matchesAny('/mark-reader.js', ['/mark-read'])).toBe(false);
  });
  it('a path pattern names an endpoint: it must end the path, not merely a segment', () => {
    expect(matchesAny('/mark-read/3', ['/mark-read'])).toBe(false);
    expect(matchesAny('crm.example.com/api/analytics/dashboards/42/delete', ['/analytics'])).toBe(false);
    expect(matchesAny('crm.example.com/collect-payment', ['/collect'])).toBe(false);
    expect(matchesAny('crm.example.com/beacon-settings/update', ['/beacon'])).toBe(false);
    expect(matchesAny('crm.example.com/csi-admin/users/remove', ['/csi'])).toBe(false);
    expect(matchesAny('crm.example.com/collect_all', ['/collect'])).toBe(false);
    expect(matchesAny('crm.example.com/collect.php/delete', ['/collect'])).toBe(false);
    expect(matchesAny('crm.example.com/api/analytics.delete', ['/analytics'])).toBe(false); // an RPC verb, not an extension
    expect(matchesAny('crm.example.com/api/telemetry.disable', ['/telemetry'])).toBe(false);
    expect(matchesAny('d.btttag.com/analytics.rcv', ['/analytics'])).toBe(true);           // Blue Triangle's beacon
    expect(matchesAny('www.facebook.com/tr/delete', ['www.facebook.com/tr'])).toBe(false); // host-qualified alike
    expect(matchesAny('crm.example.com/g/collect', ['/collect'])).toBe(true);    // the endpoint may sit under a prefix
    expect(matchesAny('crm.example.com/collect/', ['/collect'])).toBe(true);     // a trailing slash
    expect(matchesAny('crm.example.com/TealeafTarget.jsp', ['/TealeafTarget'])).toBe(true); // a file extension
    expect(matchesAny('crm.example.com/collect?v=2', ['/collect'])).toBe(true);
    expect(matchesAny('www.facebook.com/tr/', ['www.facebook.com/tr'])).toBe(true);
    expect(matchesAny('crm.example.com/b/ss/suite/1/JS-2', ['/b/ss/'])).toBe(true); // a trailing '/' is still a prefix
  });
  it('a trailing * makes a pattern a prefix with no after-boundary (obfuscated beacon stems)', () => {
    expect(matchesAny('www.linkedin.com/to11y4RusOFiHW6hy', ['/to11y*'])).toBe(true);
    expect(matchesAny('www.linkedin.com/to11y', ['/to11y*'])).toBe(true);
    expect(matchesAny('www.linkedin.com/tapiXk6B6min7N0?x=1', ['/tapi*'])).toBe(true);
    expect(matchesAny('www.linkedin.com/xto11y4Rus', ['/to11y*'])).toBe(false); // before-boundary still required
    expect(matchesAny('www.linkedin.com/to11y4Rus', ['/to11y'])).toBe(false);   // without * the old boundary rule holds
  });
  it('re: patterns are case-sensitive regexes over the haystack as given, and anchor to the host', () => {
    const re = ['re:^www\\.linkedin\\.com/(?=[^/?]*[A-Z])(?=[^/?]*[a-z])[A-Za-z0-9_-]{10,20}$'];
    for (const u of ['www.linkedin.com/Pa1FOe_96X54V', 'www.linkedin.com/zUklB8OWfeyL40l6OlM', 'www.linkedin.com/eRhmgktggvkANc', 'www.linkedin.com/abwh8FQWk0']) {
      expect(matchesAny(u, re), u).toBe(true);
    }
    expect(matchesAny('www.linkedin.com/notifications', re)).toBe(false);   // lowercase-only real path
    expect(matchesAny('www.linkedin.com/Pa1FOe_96X54V?x=1', re)).toBe(false); // anchored: a query breaks it
    expect(matchesAny('www.linkedin.com/voyager/api/graphql', re)).toBe(false);
    expect(matchesAny('www.linkedin.com/psettings/seen-receipts', re)).toBe(false);
    expect(matchesAny('mail.google.com/Pa1FOe_96X54V', re)).toBe(false);     // other host
    expect(matchesAny('www.linkedin.com/Pa1FOe_96X54V', ['re:['])).toBe(false); // invalid regex never matches
    expect(matchesAny('www.linkedin.com/Pa1FOe_96X54V', ['re:'])).toBe(false);  // empty regex would match everything
  });

  it('matches vendor hostnames for telemetry', () => {
    expect(matchesAny('browser-intake-datadoghq.com/api/v2/rum', ['datadoghq'])).toBe(true);
    expect(matchesAny('o123.ingest.sentry.io/api/1/envelope/', ['sentry'])).toBe(true);
    expect(matchesAny('app.example.com/api/sentry-settings', ['sentry'])).toBe(true); // '-' is a boundary: acceptable
    expect(matchesAny('app.example.com/api/segments', ['segment'])).toBe(false);
  });
});

describe('decide: rules layer', () => {
  it('blocks mutating methods regardless of judge', async () => {
    const d = await decide(rec('DELETE', 'http://localhost/api/items/1'), { policy: policy(), judge: fixedJudge(0), cache: memCache() });
    expect(d).toMatchObject({ verdict: 'block', action: 'fail', reason: 'mutating-method' });
  });

  it('blocks a POST page load (form submit / posted navigation) as post-navigation', async () => {
    const deps = { policy: policy(), judge: fixedJudge(0.01), cache: memCache() };
    const nav = rec('POST', 'http://localhost/api/items', { contentType: 'application/x-www-form-urlencoded', body: 'name=x', resourceType: 'Document' });
    expect(await decide(nav, deps)).toMatchObject({ verdict: 'block', action: 'fail', source: 'rule', reason: 'post-navigation' });
    const xhr = rec('POST', 'http://localhost/api/items', { contentType: 'application/x-www-form-urlencoded', body: 'name=x', resourceType: 'XHR' });
    expect((await decide(xhr, deps)).reason).not.toBe('post-navigation');
  });
  it('blocks multipart uploads when uploads are off', async () => {
    const d = await decide(rec('POST', 'http://localhost/upload', { contentType: 'multipart/form-data; boundary=x' }), { policy: policy(), judge: fixedJudge(0), cache: memCache() });
    expect(d.reason).toBe('upload');
  });
  it('allows telemetry paths without judging', async () => {
    const judge: Judge = { name: 'jev', classify: async () => { throw new Error('should not be called'); } };
    const d = await decide(rec('POST', 'http://localhost/collect', { body: '{}' }), { policy: policy(), judge, cache: memCache() });
    expect(d).toMatchObject({ verdict: 'allow', reason: 'telemetry' });
  });
  it('lets Reddit\'s analytics through as telemetry, on Reddit only, and still asks about the vote itself', async () => {
    const p = defaultPolicy(); p.sites = { ...p.sites, reddit: { enabled: true } }; p.effective = resolveEffective(p);
    const never: Judge = { name: 'jev', classify: async () => { throw new Error('should not be called'); } };
    // The event batch that records a click on upvote: analytics, though it names the vote (the review model refused it).
    const events = rec('POST', 'https://www.reddit.com/svc/shreddit/events', { contentType: 'application/json', body: '{"CSRF":"x","info":[{"source":"post","action":"click","noun":"upvote"}]}' });
    expect(await decide(events, { policy: p, judge: never, cache: memCache() })).toMatchObject({ verdict: 'allow', reason: 'telemetry' });
    for (const url of ['https://www.reddit.com/svc/shreddit/perfMetrics', 'https://w3-reporting.reddit.com/reports', 'https://www.reddit.com/svc/shreddit/client-errors', 'https://pi.reddit.com/v4/p', 'https://error-tracking.reddit.com/o418887/api/1/envelope/']) {
      expect(await decide(rec('POST', url, { contentType: 'application/json', body: '{}' }), { policy: p, judge: never, cache: memCache() })).toMatchObject({ verdict: 'allow', reason: 'telemetry' });
    }
    // The vote goes to the judge (and is refused).
    const vote = rec('POST', 'https://www.reddit.com/svc/shreddit/graphql', { contentType: 'application/json', body: '{"operation":"UpdatePostVoteState","variables":{"input":{"postId":"t3_1","voteState":"UP"}},"csrf_token":"x"}' });
    expect(await decide(vote, { policy: p, judge: fixedJudge(0.96), cache: memCache() })).toMatchObject({ verdict: 'block' });
    // Another site's path of the same name is not Reddit's analytics.
    const other = { ...p, sites: { ...p.sites, x: { enabled: true } } }; other.effective = resolveEffective(other);
    expect((await decide(rec('POST', 'https://x.com/svc/shreddit/events', { contentType: 'application/json', body: '{"a":1}' }), { policy: other, judge: fixedJudge(0.96), cache: memCache() })).reason).not.toBe('telemetry');
  });
  it('allows GET unless the path is a known side-effect', async () => {
    const p = policy(); p.effective.blockedGetPaths = ['/logout', '/mark-read'];
    const deps = { policy: p, judge: fixedJudge(1), cache: memCache() };
    expect((await decide(rec('GET', 'http://localhost/api/items'), deps)).reason).toBe('safe-method');
    expect((await decide(rec('GET', 'http://localhost/app.js', { resourceType: 'Script' }), deps)).reason).toBe('static-asset');
    expect((await decide(rec('GET', 'http://localhost/mark-read/3'), deps))).toMatchObject({ verdict: 'block', reason: 'blocked-get-path' });
  });
  it('blocks a query-fragment GET path (DNR-aligned matcher), and does not over-block an asset', async () => {
    const p = policy(); p.effective.blockedGetPaths = ['action=RESPOND'];
    const deps = { policy: p, judge: fixedJudge(1), cache: memCache() };
    // '?' is not a token boundary, so a plain token match misses this; the DNR matcher catches it.
    expect((await decide(rec('GET', 'http://localhost/calendar/event?action=RESPOND&x=1'), deps))).toMatchObject({ verdict: 'block', reason: 'blocked-get-path' });
    // A path that merely contains the letters is not a match (separator rule).
    expect((await decide(rec('GET', 'http://localhost/api/action=RESPONDER'), deps)).reason).toBe('safe-method');
  });
});

describe('decide: judge layer', () => {
  const post = () => rec('POST', 'http://localhost/api/items', { contentType: 'application/json', body: '{"name":"x"}' });

  it('allows below the allow threshold', async () => {
    const d = await decide(post(), { policy: policy(), judge: fixedJudge(0.02), cache: memCache() });
    expect(d).toMatchObject({ verdict: 'allow', source: 'jev', reason: 'p<allow', pWrite: 0.02 });
  });
  it('blocks above the block threshold', async () => {
    const d = await decide(post(), { policy: policy(), judge: fixedJudge(0.9), cache: memCache() });
    expect(d).toMatchObject({ verdict: 'block', action: 'fail', reason: 'p>block' });
  });
  it('judges every request: a judge verdict is never reused, only label ones are', async () => {
    const cache = memCache();
    let calls = 0;
    const counting: Judge = { name: 'jev', classify: async () => { calls++; return { pWrite: 0.02, latencyMs: 0, model: 'fake' }; } };
    await decide(post(), { policy: policy(), judge: counting, cache });
    await decide(post(), { policy: policy(), judge: counting, cache });
    expect(calls).toBe(2);
    // A judge verdict left in storage (an older version saved them) is ignored too.
    cache.store.set(post().fingerprint, { verdict: 'allow', pWrite: 0.01, source: 'jev' });
    const d = await decide(post(), { policy: policy(), judge: fixedJudge(0.9), cache });
    expect(d).toMatchObject({ verdict: 'block', source: 'jev' });
  });
  it('review band is a distinct verdict that still fails the request', async () => {
    const p = policy(); p.reviewBand = 'block';
    const d = await decide(post(), { policy: p, judge: fixedJudge(0.5), cache: memCache() });
    expect(d).toMatchObject({ verdict: 'review', action: 'fail', reason: 'review-band:block' });
  });
  it('uses the cache before calling the judge', async () => {
    const cache = memCache();
    cache.store.set(post().fingerprint, { verdict: 'allow', pWrite: 0.01, source: 'label' });
    const judge: Judge = { name: 'jev', classify: async () => { throw new Error('should not be called'); } };
    const d = await decide(post(), { policy: policy(), judge, cache });
    expect(d).toMatchObject({ verdict: 'allow', source: 'cache', reason: 'cached:label' });
  });
  it('fails closed on judge timeout', async () => {
    const p = policy(); p.judge.timeoutMs = 20;
    const d = await decide(post(), { policy: p, judge: fixedJudge(0, 200), cache: memCache() });
    expect(d).toMatchObject({ verdict: 'block', action: 'fail', reason: 'judge-timeout' });
  });
  it('fails closed on judge error', async () => {
    const judge: Judge = { name: 'jev', classify: async () => { throw new Error('boom'); } };
    const d = await decide(post(), { policy: policy(), judge, cache: memCache() });
    expect(d.reason).toBe('judge-error:boom');
    expect(d.action).toBe('fail');
  });

  describe('review band with an LLM second opinion', () => {
    const llm = (p: number, reason = 'because'): Judge => ({ name: 'llm', classify: async () => ({ pWrite: p, latencyMs: 5, model: 'anthropic/claude-haiku-4.5', reason }) });
    const withLlm = () => { const p = policy(); p.reviewBand = 'llm'; return p; };

    it('lets the second judge clear a read', async () => {
      const cache = memCache();
      const d = await decide(post(), { policy: withLlm(), judge: fixedJudge(0.5), cache, reviewJudge: llm(0.02) });
      expect(d).toMatchObject({ verdict: 'review', action: 'continue', source: 'llm', judgeReason: 'because' });
      expect(d.reason).toMatch(/llm-allow\(p1=0.50\)/);
      expect(cache.store.size).toBe(0); // not saved: the next request is judged again
    });
    it('lets the second judge confirm a write', async () => {
      const d = await decide(post(), { policy: withLlm(), judge: fixedJudge(0.5), cache: memCache(), reviewJudge: llm(0.95) });
      expect(d).toMatchObject({ verdict: 'review', action: 'fail', source: 'llm' });
      expect(d.reason).toMatch(/llm-block/);
    });
    it('still fails when both are unsure, and when the second judge errors', async () => {
      expect((await decide(post(), { policy: withLlm(), judge: fixedJudge(0.5), cache: memCache(), reviewJudge: llm(0.4) }))).toMatchObject({ action: 'fail', reason: expect.stringMatching(/llm-unsure/) });
      const broken: Judge = { name: 'llm', classify: async () => { throw new Error('gateway down'); } };
      expect((await decide(post(), { policy: withLlm(), judge: fixedJudge(0.5), cache: memCache(), reviewJudge: broken }))).toMatchObject({ action: 'fail', reason: 'review-band:llm-error:gateway down' });
    });
    it('uses its own lines: Jev at 0.32 passes (allow 0.35), the review model at 0.32 stays unsure (reviewAllow 0.30)', async () => {
      const split = () => { const p = withLlm(); p.thresholds = { allow: 0.35, block: 0.75, reviewAllow: 0.3, reviewBlock: 0.75 }; return p; };
      const unused: Judge = { name: 'llm', classify: async () => { throw new Error('should not be called'); } };
      expect((await decide(post(), { policy: split(), judge: fixedJudge(0.32), cache: memCache(), reviewJudge: unused })).action).toBe('continue');
      expect((await decide(post(), { policy: split(), judge: fixedJudge(0.5), cache: memCache(), reviewJudge: llm(0.32) }))).toMatchObject({ action: 'fail', reason: expect.stringMatching(/llm-unsure/) });
    });
    it('does not consult the second judge when the primary is confident', async () => {
      const never: Judge = { name: 'llm', classify: async () => { throw new Error('should not be called'); } };
      expect((await decide(post(), { policy: withLlm(), judge: fixedJudge(0.01), cache: memCache(), reviewJudge: never })).verdict).toBe('allow');
    });
  });

  describe('opaque bodies never auto-allow', () => {
    // A positional-array body on an endpoint no codec decodes (the Gmail sync channel itself is now decoded).
    const gmailSend = () => rec('POST', 'https://mail.google.com/sync/u/2/i/bv?c=18', { contentType: 'application/json', body: '[[null,null,2],[[[6,["thread-a:r-1"]]]]]' });
    it('sends a low-scoring positional-array body to the review band instead of allowing it', async () => {
      const p = policy(); p.effective.targetDomains = ['mail.google.com'];
      const d = await decide(gmailSend(), { policy: p, judge: fixedJudge(0.23), cache: memCache() });
      expect(d.verdict).toBe('review');
      expect(d.action).toBe('fail');
      expect(d.reason).toMatch(/opaque-body/);
    });
    it('still allows keyed JSON below the threshold', async () => {
      const d = await decide(post(), { policy: policy(), judge: fixedJudge(0.05), cache: memCache() });
      expect(d.verdict).toBe('allow');
    });
    it('can be switched off', async () => {
      const p = policy(); p.opaqueToReview = false;
      const d = await decide(gmailSend(), { policy: p, judge: fixedJudge(0.23), cache: memCache() });
      expect(d.verdict).toBe('allow');
    });
  });
});

describe('decoded writes (blockedShapes)', () => {
  const gcal = 'https://calendar.google.com/calendar/u/2/sync.sync?hl=en';
  const ct = 'application/x-www-form-urlencoded';
  const freq = (ops: unknown) => new URLSearchParams({ cwuik: 'k', 'f.req': JSON.stringify([[[null, 3], 's', null, null, ops, null, null, [], null, null, null, null, null, []], 20000]), hl: 'en', secid: 's' }).toString();
  it('blocks a decoded sync.sync mutation by rule, without asking the judge', async () => {
    const p = { ...policy(), effective: { ...policy().effective, targetDomains: ['calendar.google.com'], blockedShapes: ['gcal:sync:w', 'gtasks:sync:w'] } };
    const d = await decide(rec('POST', gcal, { contentType: ct, body: freq([[5, [[['defaultCalMode', 'month']]], null, null, null, 1]]) }), { policy: p, judge: fixedJudge(0), cache: memCache() });
    expect(d).toMatchObject({ verdict: 'block', action: 'fail', source: 'rule', reason: 'decoded-write' });
  });
  it('lets a decoded poll reach the judge like any other request', async () => {
    const p = { ...policy(), effective: { ...policy().effective, targetDomains: ['calendar.google.com'], blockedShapes: ['gcal:sync:w', 'gtasks:sync:w'] } };
    const d = await decide(rec('POST', gcal, { contentType: ct, body: freq(null) }), { policy: p, judge: fixedJudge(0.1), cache: memCache() });
    expect(d.verdict).toBe('allow');
    expect(d.source).toBe('jev');
  });
});

describe('read-tracking shapes (opt-in)', () => {
  const gql = 'https://client-api.linear.app/graphql';
  const ct = 'application/json';
  const body = (op: string, root = op[0]!.toLowerCase() + op.slice(1)) => JSON.stringify({ operationName: op, query: `mutation ${op} { ${root}(input: {}) { success } }`, variables: {} });
  const withList = (allow: boolean) => ({ ...policy(), allowReadTracking: allow, effective: { ...policy().effective, readTrackingShapes: ['gql:mutation:ViewPreferencesCreate'] } });

  it('allows a listed read-tracking shape by rule only when opted in', async () => {
    const d = await decide(rec('POST', gql, { contentType: ct, body: body('ViewPreferencesCreate') }), { policy: withList(true), judge: fixedJudge(0.99), cache: memCache() });
    expect(d).toMatchObject({ verdict: 'allow', action: 'continue', source: 'rule', reason: 'read-tracking' });
  });

  it('does not take the operationName as proof: another root field, an alias or a second operation goes to the judge', async () => {
    const forged = [
      body('ViewPreferencesCreate', 'issueDelete'),
      body('ViewPreferencesCreate', 'viewPreferencesCreate(input: {}) { success } issueDelete'),
      body('ViewPreferencesCreate', 'viewPreferencesCreate: issueDelete'),
      JSON.stringify({ operationName: 'ViewPreferencesCreate', query: 'mutation ViewPreferencesCreate { viewPreferencesCreate(input: {}) { success } } mutation X { issueDelete(id: "1") { success } }' }),
      JSON.stringify({ operationName: 'ViewPreferencesCreate', query: 'mutation ViewPreferencesCreate { viewPreferencesCreate(input: {}) { success } }', extensions: {} }),
    ];
    for (const b of forged) {
      const d = await decide(rec('POST', gql, { contentType: ct, body: b }), { policy: withList(true), judge: fixedJudge(0.99), cache: memCache() });
      expect(d.reason).not.toBe('read-tracking');
      expect(d.verdict).toBe('block');
    }
  });

  it('sends the same shape to the judge when the opt-in is off (default)', async () => {
    const d = await decide(rec('POST', gql, { contentType: ct, body: body('ViewPreferencesCreate') }), { policy: withList(false), judge: fixedJudge(0.99), cache: memCache() });
    expect(d.reason).not.toBe('read-tracking');
    expect(d.source).toBe('jev');
    expect(d.verdict).toBe('block');
  });

  // LinkedIn's "seen" requests (its profile's readTrackingShapes): refused like any write unless opted in; its other
  // writes on the same endpoint stay refused either way.
  it('lets LinkedIn\'s "seen" requests through only when opted in', async () => {
    const li = (allow: boolean) => { const p = { ...defaultPolicy(), allowReadTracking: allow, sites: { linkedin: { enabled: true } } }; return { ...p, effective: resolveEffective(p) }; };
    const rsc = (id: string) => rec('POST', 'https://www.linkedin.com/flagship-web/rsc-action/actions/server-request', { contentType: ct, body: JSON.stringify({ requestId: id, serverRequest: { requestId: id }, states: [] }) });
    const seen = rsc('com.linkedin.sdui.requests.notifications.markNotificationsSeen');
    expect(await decide(seen, { policy: li(true), judge: fixedJudge(0.99), cache: memCache() })).toMatchObject({ verdict: 'allow', reason: 'read-tracking' });
    expect(await decide(seen, { policy: li(false), judge: fixedJudge(0.99), cache: memCache() })).toMatchObject({ verdict: 'block', reason: 'decoded-write' });
    expect(await decide(rsc('com.linkedin.sdui.requests.profile.profilePolicyNotice'), { policy: li(true), judge: fixedJudge(0.99), cache: memCache() })).toMatchObject({ reason: 'read-tracking' });
    // The messaging badge: only its own address and body ({"until"}) are read-tracking; the same body elsewhere is not.
    const badge = (path: string) => rec('POST', `https://www.linkedin.com${path}`, { contentType: ct, body: '{"until":1700000000000}' });
    expect(await decide(badge('/voyager/api/voyagerMessagingDashMessagingBadge?action=markAllMessagesAsSeen'), { policy: li(true), judge: fixedJudge(0.99), cache: memCache() })).toMatchObject({ verdict: 'allow', reason: 'read-tracking' });
    expect(await decide(badge('/voyager/api/voyagerMessagingDashMessagingBadge?action=markAllMessagesAsSeen'), { policy: li(false), judge: fixedJudge(0.01), cache: memCache() })).toMatchObject({ verdict: 'block', reason: 'decoded-write' });
    expect(await decide(badge('/voyager/api/somethingElse'), { policy: li(true), judge: fixedJudge(0.99), cache: memCache() })).not.toMatchObject({ reason: 'read-tracking' });
    // A repeated selector (`action=?`): the server may run the other one, so no rule allow holds.
    expect(await decide(badge('/voyager/api/voyagerMessagingDashMessagingBadge?action=markAllMessagesAsSeen&action=x'), { policy: li(true), judge: fixedJudge(0.99), cache: memCache() })).toMatchObject({ verdict: 'block', reason: 'decoded-write' });
    const react = rsc('com.linkedin.sdui.reactions.create');
    expect(await decide(react, { policy: li(true), judge: fixedJudge(0.01), cache: memCache() })).toMatchObject({ verdict: 'block', reason: 'decoded-write' });
  });

  // LinkedIn messaging (the messaging codec): writes refused whatever the judge says, the implicit ones read-tracking.
  it('refuses LinkedIn messaging writes by rule and lets its read-tracking through only when opted in', async () => {
    const li = (allow: boolean) => { const p = { ...defaultPolicy(), allowReadTracking: allow, sites: { linkedin: { enabled: true } } }; return { ...p, effective: resolveEffective(p) }; };
    const msg = (path: string, body: object) => rec('POST', `https://www.linkedin.com/voyager/api/voyagerMessagingDashMessenger${path}`, { contentType: ct, body: JSON.stringify(body) });
    const C = 'urn:li:msg_conversation:(urn:li:fsd_profile:ACoAAA0,2-MDA=)';
    const send = msg('Messages?action=createMessage', { message: { body: { text: 'hi' } }, mailboxUrn: 'urn:li:fsd_profile:ACoAAA0', trackingId: '0', dedupeByClientGeneratedToken: false });
    expect(await decide(send, { policy: li(true), judge: fixedJudge(0.01), cache: memCache() })).toMatchObject({ verdict: 'block', reason: 'decoded-write' });
    const typing = msg('Conversations?action=typing', { conversationUrn: C });
    const read = msg(`Conversations?ids=List(${C})`, { entities: { [C]: { patch: { $set: { read: true } } } } });
    for (const r of [typing, read]) {
      expect(await decide(r, { policy: li(true), judge: fixedJudge(0.99), cache: memCache() })).toMatchObject({ verdict: 'allow', reason: 'read-tracking' });
      expect(await decide(r, { policy: li(false), judge: fixedJudge(0.01), cache: memCache() })).toMatchObject({ verdict: 'block', reason: 'decoded-write' });
    }
  });

  it('allows LinkedIn\'s live-updates PUT by its exact path, and no other PUT', async () => {
    const p0 = { ...defaultPolicy(), sites: { linkedin: { enabled: true } } }; const p = { ...p0, effective: resolveEffective(p0) };
    const put = (url: string) => rec('PUT', url, { contentType: ct, body: '{"entities":{}}' });
    expect(await decide(put('https://www.linkedin.com/realtime/realtimeFrontendSubscriptions?ids=List(x)'), { policy: p, judge: fixedJudge(0.99), cache: memCache() })).toMatchObject({ verdict: 'allow', reason: 'read-put' });
    expect(await decide(put('https://www.linkedin.com/realtime/realtimeFrontendSubscriptionsX'), { policy: p, judge: fixedJudge(0.01), cache: memCache() })).toMatchObject({ verdict: 'block', reason: 'mutating-method' });
    expect(await decide(put('https://www.linkedin.com/mysettings-api/settingsApiSettings/x'), { policy: p, judge: fixedJudge(0.01), cache: memCache() })).toMatchObject({ verdict: 'block', reason: 'mutating-method' });
  });

  // The five sites' own read-tracking: through with read tracking on, refused with it off; a real change beside it refused
  // either way.
  it('lets Gmail, Facebook, Calendar, Linear and X read-tracking through only when opted in', async () => {
    const on = (allow: boolean) => { const p = { ...defaultPolicy(), allowReadTracking: allow, sites: { gmail: { enabled: true }, facebook: { enabled: true }, calendar: { enabled: true }, linear: { enabled: true }, x: { enabled: true } } }; return { ...p, effective: resolveEffective(p) }; };
    const gmailOp = (added: unknown, removed: unknown) => JSON.stringify([null, [[[1, ['thread-f:0', [null, null, null, null, null, null, [added, removed, ['msg-f:0']]]]]]], null]);
    const fbForm = (name: string) => `fb_api_req_friendly_name=${name}&doc_id=1`;
    const cases: [RequestRecord, RequestRecord][] = [
      [rec('POST', 'https://mail.google.com/sync/u/0/i/s?c=5', { contentType: 'application/json', body: gmailOp(['^o'], ['^u', '^us']) }),
        rec('POST', 'https://mail.google.com/sync/u/0/i/s?c=5', { contentType: 'application/json', body: gmailOp(['^t'], null) })],
      [rec('POST', 'https://www.facebook.com/api/graphql/', { contentType: 'application/x-www-form-urlencoded', body: fbForm('CometUFILiveTypingBroadcastMutation_StartMutation') }),
        rec('POST', 'https://www.facebook.com/api/graphql/', { contentType: 'application/x-www-form-urlencoded', body: fbForm('CometUFIFeedbackReactMutation') })],
      // A video watched, a story seen: what playing them sends.
      [rec('POST', 'https://www.facebook.com/api/graphql/', { contentType: 'application/x-www-form-urlencoded', body: fbForm('FBUnifiedVideoSeenStateMutation') }),
        rec('POST', 'https://www.facebook.com/api/graphql/', { contentType: 'application/x-www-form-urlencoded', body: fbForm('CometUFIFeedbackReactMutation') })],
      [rec('POST', 'https://www.facebook.com/api/graphql/', { contentType: 'application/x-www-form-urlencoded', body: fbForm('storiesUpdateSeenStateMutation') }),
        rec('POST', 'https://www.facebook.com/api/graphql/', { contentType: 'application/x-www-form-urlencoded', body: fbForm('CometUFIFeedbackReactMutation') })],
      [rec('POST', 'https://client-api.linear.app/graphql', { contentType: ct, body: JSON.stringify({ operationName: 'NotificationUpdate', query: 'mutation NotificationUpdate($i: NotificationUpdateInput!) { notificationUpdate(input: $i) { success } }', variables: { i: { readAt: 'now' } } }) }),
        rec('POST', 'https://client-api.linear.app/graphql', { contentType: ct, body: JSON.stringify({ operationName: 'NotificationUpdate', query: 'mutation NotificationUpdate($i: NotificationUpdateInput!) { notificationUpdate(input: $i) { success } }', variables: { i: { archivedAt: 'now' } } }) })],
      [rec('POST', 'https://x.com/i/api/graphql/IjQ-egg0uPkY11NyPMfRMQ/PutClientEducationFlag', { contentType: ct, body: '{"variables":{"flag":"NewUserPromptEducation"},"queryId":"IjQ-egg0uPkY11NyPMfRMQ"}' }),
        rec('POST', 'https://x.com/i/api/graphql/a/FavoriteTweet', { contentType: ct, body: '{"queryId":"a","variables":{}}' })],
    ];
    for (const [tracking, change] of cases) {
      expect(await decide(tracking, { policy: on(true), judge: fixedJudge(0.99), cache: memCache() }), tracking.url).toMatchObject({ verdict: 'allow', reason: 'read-tracking' });
      expect((await decide(tracking, { policy: on(false), judge: fixedJudge(0.99), cache: memCache() })).verdict, tracking.url).toBe('block');
      expect((await decide(change, { policy: on(true), judge: fixedJudge(0.99), cache: memCache() })).verdict, change.url).toBe('block');
    }
  });

  it('does not let a second mutation ride along with Linear\'s notification marked read', async () => {
    const p0 = { ...defaultPolicy(), sites: { linear: { enabled: true } } }; const p = { ...p0, effective: resolveEffective(p0) };
    const body = '{"operationName":"NotificationUpdate","query":"mutation NotificationUpdate($i: NotificationUpdateInput!) { notificationUpdate(id: \\"n1\\", input: $i) { success } issueDelete(id: \\"ISSUE-1\\") { success } }","variables":{"i":{"readAt":"2026-01-01"}}}';
    const d = await decide(rec('POST', 'https://client-api.linear.app/graphql', { contentType: ct, body }), { policy: p, judge: fixedJudge(0.99), cache: memCache() });
    expect(d.reason).not.toBe('read-tracking');
    expect(d.verdict).toBe('block');
  });

  it('never broadens: an unlisted mutation is not read-tracking even when opted in', async () => {
    const d = await decide(rec('POST', gql, { contentType: ct, body: body('IssueUpdate') }), { policy: withList(true), judge: fixedJudge(0.99), cache: memCache() });
    expect(d.reason).not.toBe('read-tracking');
    expect(d.source).toBe('jev');
  });
});

describe('matchesAny prefix patterns', () => {
  it('treats a trailing slash as an explicit prefix boundary', () => {
    expect(matchesAny('waa-pa.clients6.google.com/$rpc/google.internal.waa.v1.waa/create', ['waa-pa.clients6.google.com/$rpc/google.internal.waa.v1.Waa/'])).toBe(true);
    expect(matchesAny('waa-pa.clients6.google.com/$rpc/google.internal.waa.v1.waa/create', ['google.internal.waa.v1.Waa'])).toBe(true);
    expect(matchesAny('a.com/logoutHelper.js', ['/logout'])).toBe(false);
  });
});

describe('binary bodies', () => {
  const binary = String.fromCharCode(0xef, 0xbe, 0x00, 0x14, 0x65, 0x4c, 0x3c, 0x0c, 0x02, 0x01, 0x48, 0x2c, 0x20, 0x35, 0x21, 0x2b, 0x33, 0x0a, 0x70, 0x4c, 0x60, 0x75, 0x0c, 0x0a, 0x1e, 0x5c);
  const telegram = () => rec('POST', 'https://vesta.web.telegram.org/apiw1', { body: binary });
  let asked = 0;
  const counting: Judge = { name: 'jev', classify: async () => { asked++; return { pWrite: 0.1, latencyMs: 1, model: 'fake' }; } };

  it('are refused by rule, without asking the judge', async () => {
    asked = 0;
    const r = telegram();
    expect(r.bodyShape).toBe('opaque');
    const d = await decide(r, { policy: policy(), judge: counting, cache: memCache() });
    expect(d).toMatchObject({ verdict: 'block', source: 'rule', reason: 'opaque-binary' });
    expect(asked).toBe(0);
  });

  it('still take a site\'s tested verdict (a labeled telemetry beacon stays allowed)', async () => {
    const r = telegram();
    const cache = memCache();
    cache.store.set(r.fingerprint, { verdict: 'allow', pWrite: 0, source: 'label' });
    expect(await decide(r, { policy: policy(), judge: counting, cache })).toMatchObject({ verdict: 'allow', source: 'cache' });
  });

  it('readable text with no known shape still goes to the judge', async () => {
    asked = 0;
    const r = rec('POST', 'https://example.com/api', { body: 'plain words about a thing' });
    await decide(r, { policy: policy(), judge: counting, cache: memCache() });
    expect(asked).toBe(1);
  });
});
