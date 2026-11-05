import { describe, it, expect } from 'vitest';
import { decide } from './decision';
import { defaultPolicy } from './policy';
import { resolveEffective } from './sites';
import type { Policy, RequestRecord } from '../shared/types';
import type { Judge } from './judge/types';

const policy = (): Policy => {
  const p = defaultPolicy();
  p.uploads = false;
  p.telemetryAllow = [...p.telemetryAllow, '/ajax/bnzai'];
  p.customSites = [{ id: 'fb', name: 'fb', domains: ['facebook.com'], enabled: true }];
  p.effective = resolveEffective(p);
  return p;
};
const rec = (over: Partial<RequestRecord>): RequestRecord => ({
  ts: 0, tabId: 1, requestId: 'r', method: 'POST', url: 'https://www.facebook.com/ajax/bnzai', host: 'www.facebook.com', path: '/ajax/bnzai',
  queryKeys: [], contentType: 'multipart/form-data; boundary=x', resourceType: 'XHR', hasBody: true, bodyPreview: '--x',
  bodyShape: 'multipart', fingerprint: 'POST www.facebook.com/ajax/bnzai multipart', lastUiActions: [], ...over,
});
const judge = { name: 'jev', classify: async () => { throw new Error('judge must not be called'); } } as unknown as Judge;
const cache = { get: async () => undefined, put: async () => {}, touch: async () => {} };

describe('telemetry outranks the upload rule', () => {
  it('a multipart body to a listed telemetry path is telemetry', async () => {
    const d = await decide(rec({}), { policy: policy(), judge, cache });
    expect(d.reason).toBe('telemetry'); expect(d.verdict).toBe('allow');
  });
  it('a multipart body anywhere else is still an upload', async () => {
    const d = await decide(rec({ url: 'https://www.facebook.com/upload/photo', path: '/upload/photo', fingerprint: 'POST www.facebook.com/upload/photo multipart' }), { policy: policy(), judge, cache });
    expect(d.reason).toBe('upload'); expect(d.verdict).toBe('block');
  });
});

describe('telemetry patterns cannot be satisfied from the query string', () => {
  const refusingJudge = { name: 'jev', classify: async () => ({ pWrite: 0.99, latencyMs: 1, model: 'stub' }) } as unknown as Judge;
  const post = (url: string, over: Partial<RequestRecord> = {}) => {
    const u = new URL(url);
    return rec({ url, host: u.hostname, path: u.pathname, queryKeys: [...u.searchParams.keys()], contentType: 'application/json', bodyShape: 'json:action', bodyPreview: '{"action":"delete"}', fingerprint: `POST ${u.hostname}${u.pathname} json:action`, ...over });
  };
  const run = (r: RequestRecord) => decide(r, { policy: policy(), judge: refusingJudge, cache });

  it('a telemetry path in a query value does not make a write telemetry', async () => {
    const d = await run(post('https://www.facebook.com/api/delete?next=/telemetry'));
    expect(d.reason).not.toBe('telemetry');
    expect(d.action).toBe('fail');
  });
  it('nor does a telemetry path hidden after other text in the query, or in a decoded write', async () => {
    expect((await run(post('https://www.facebook.com/api/delete?x=1&r=%2Fbeacon'))).reason).not.toBe('telemetry');
    expect((await run(post('https://www.facebook.com/api/delete?x=/log?y=1'))).reason).not.toBe('telemetry');
    const decoded = post('https://www.facebook.com/api/graphql/?next=/telemetry', { bodyShape: 'fb:gql:w[CometUFIFeedbackReactMutation]', fingerprint: 'POST www.facebook.com/api/graphql/ fb:gql:w[CometUFIFeedbackReactMutation]' });
    expect((await run(decoded)).reason).toBe('decoded-write');
  });
  it('a genuine telemetry endpoint keeps its allowance, with or without a query', async () => {
    expect((await run(post('https://www.facebook.com/telemetry'))).reason).toBe('telemetry');
    expect((await run(post('https://www.facebook.com/beacon?id=3'))).reason).toBe('telemetry');
  });
  it('"/log?" means a /log endpoint with parameters, nothing else', async () => {
    expect((await run(post('https://www.facebook.com/log?format=json'))).reason).toBe('telemetry');
    expect((await run(post('https://www.facebook.com/log'))).reason).not.toBe('telemetry');
    expect((await run(post('https://www.facebook.com/logout?x=1'))).reason).not.toBe('telemetry');
  });
});

describe('well-known analytics vendors on the site\'s own domain (Adobe Analytics, Tealeaf)', () => {
  const refusingJudge = { name: 'jev', classify: async () => ({ pWrite: 0.99, latencyMs: 1, model: 'stub' }) } as unknown as Judge;
  const post = (url: string, contentType = 'text/plain') => {
    const u = new URL(url);
    return rec({ url, host: u.hostname, path: u.pathname, queryKeys: [], contentType, bodyShape: `ct:${contentType}`, bodyPreview: 'AQB=1&ndh=1&pageName=home&AQE=1', fingerprint: `POST ${u.hostname}${u.pathname} ct:${contentType}` });
  };
  const run = (url: string) => decide(post(url), { policy: policy(), judge: refusingJudge, cache });
  it('an Adobe Analytics beacon (/b/ss/<report suite>/…) is telemetry', async () => {
    expect((await run('https://www.facebook.com/b/ss/underarmourcom,underarmour/1/JS-2.17.0/s31781595077')).reason).toBe('telemetry');
  });
  it('a Tealeaf session-replay upload (/TealeafTarget.jsp and similar) is telemetry', async () => {
    expect((await run('https://www.facebook.com/TealeafTarget.jsp')).reason).toBe('telemetry');
    expect((await run('https://www.facebook.com/TealeafTarget.php')).reason).toBe('telemetry');
  });
  it('look-alike paths are not', async () => {
    expect((await run('https://www.facebook.com/b/ssr/update')).reason).not.toBe('telemetry');
    expect((await run('https://www.facebook.com/api/myTealeafTargets/delete')).reason).not.toBe('telemetry');
    expect((await run('https://www.facebook.com/b/ss')).reason).not.toBe('telemetry');
  });
});

// A site's allowances hold on its own hosts. Linear's `segment` pattern, pooled, would allow a POST on every other
// guarded host without a judge.
describe('a site profile\'s allowances hold on its own hosts only', () => {
  const both = (): Policy => {
    const p = defaultPolicy();
    p.sites = { ...p.sites, linear: { enabled: true } };
    p.customSites = [{ id: 'crm.example.com', name: 'CRM', domains: ['crm.example.com'], enabled: true }];
    p.effective = resolveEffective(p);
    return p;
  };
  const post = (host: string, path: string): RequestRecord => rec({ url: `https://${host}${path}`, host, path, contentType: 'application/json', bodyShape: 'json:name', fingerprint: `POST ${host}${path} json:name` });
  const unsure = { name: 'rules-only', classify: async () => ({ pWrite: 0.5, latencyMs: 0, model: 'rules-only' }) } as unknown as Judge;
  it('allows Linear\'s telemetry on linear.app, and leaves the same path on another guarded host to the judge', async () => {
    const p = both();
    expect(p.effective.telemetryAllow).not.toContain('segment');
    expect((await decide(post('s.linear.app', '/segment/v1'), { policy: p, judge: unsure, cache })).reason).toBe('telemetry');
    const other = await decide(post('crm.example.com', '/api/segment/export-contacts'), { policy: p, judge: unsure, cache });
    expect(other.reason).not.toBe('telemetry');
    expect(other.action).toBe('fail');
  });
  it('keeps the global allowances on every guarded host', async () => {
    expect((await decide(post('crm.example.com', '/collect'), { policy: both(), judge: unsure, cache })).reason).toBe('telemetry');
  });
});

// A global path pattern names an endpoint. Matched anywhere in the path on segment boundaries, `/analytics`,
// `/collect`, `/beacon` and `/csi` let these writes through on every guarded host before the judge was asked.
describe('a global telemetry pattern does not match a write that merely contains it', () => {
  const p = (): Policy => {
    const q = defaultPolicy();
    q.mode = 'enforce';
    q.customSites = [{ id: 'crm.example.com', name: 'CRM', domains: ['crm.example.com'], enabled: true }];
    q.effective = resolveEffective(q);
    return q;
  };
  const post = (target: string): RequestRecord => {
    const path = target.split('?')[0]!;
    return rec({ url: `https://crm.example.com${target}`, host: 'crm.example.com', path, contentType: 'application/json', bodyShape: 'json:id', bodyPreview: '{"id":42}', fingerprint: `POST crm.example.com${path} json:id` });
  };
  let asked = 0;
  const writeJudge = { name: 'jev', classify: async () => { asked++; return { pWrite: 0.99, latencyMs: 1, model: 'stub' }; } } as unknown as Judge;
  // Nor one whose last segment it is: a global pattern starts the path (as its beacon rule does).
  for (const path of ['/api/analytics/dashboards/42/delete', '/collect-payment', '/beacon-settings/update', '/csi-admin/users/remove', '/api/analytics.delete',
    '/api/payments/collect', '/api/tasks/42/log?src=web', '/v1/accounts/delete/telemetry', '/x/beacon', '/g/collect']) {
    it(`POST ${path} goes to the judge and is refused`, async () => {
      asked = 0;
      const d = await decide(post(path), { policy: p(), judge: writeJudge, cache });
      expect(d.reason).not.toBe('telemetry');
      expect(asked).toBe(1);
      expect(d.action).toBe('fail');
    });
  }
  it('the endpoints themselves stay telemetry', async () => {
    for (const path of ['/collect', '/analytics', '/beacon/', '/csi', '/TealeafTarget.jsp', '/b/ss/rsid/1', '/log?format=json']) {
      expect((await decide(post(path), { policy: p(), judge, cache })).reason, path).toBe('telemetry');
    }
  });
});
