import { describe, expect, it, vi } from 'vitest';
import { keepBodies, observedBody, observedUrl, observing, urlPatterns } from './observer';

const SECRET = 'SYNTHETIC_REVIEW_SECRET';
const bytes = (s: string) => ({ raw: [{ bytes: new TextEncoder().encode(s).buffer }] }) as chrome.webRequest.OnBeforeRequestDetails['requestBody'];

describe('observer redaction', () => {
  it('redacts credentials in form data', () => {
    const out = observedBody({ formData: { username: ['ana'], password: [SECRET] } } as chrome.webRequest.OnBeforeRequestDetails['requestBody'], true);
    expect(out).not.toContain(SECRET);
    expect(out).toContain('username');
  });
  it('redacts credentials in raw JSON and form-encoded bodies', () => {
    expect(observedBody(bytes(`{"user":"ana","password":"${SECRET}","token":"${SECRET}"}`), true)).not.toContain(SECRET);
    expect(observedBody(bytes(`user=ana&password=${SECRET}`), true)).not.toContain(SECRET);
  });
  it('stores no body at all outside development builds', () => {
    expect(observedBody(bytes('{"a":1}'), false)).toBeUndefined();
  });
  it('drops bodies the redactor cannot parse instead of keeping them raw (second pass)', () => {
    const multipart = `--b\r\nContent-Disposition: form-data; name="password"\r\n\r\n${SECRET}\r\n--b--`;
    expect(observedBody(bytes(multipart), true)).toBeUndefined();
    expect(observedBody(bytes(`{"password":"${SECRET}","other":"unfinished`), true)).toBeUndefined();
    expect(observedBody(bytes(`free text with ${SECRET}`), true)).toBeUndefined();
    const binary = { raw: [{ bytes: new Uint8Array([0xff, 0xfe, 0x00, 0x41]).buffer }] } as chrome.webRequest.OnBeforeRequestDetails['requestBody'];
    expect(observedBody(binary, true)).toBeUndefined();
  });
  it('keeps bodies only in a development build, whatever a stored policy says', () => {
    const withSink = { devSink: 'http://localhost:4173/__sink' } as never;
    expect(keepBodies(withSink, false)).toBe(false); // release build with a dev sink carried in a stored policy
    expect(keepBodies(withSink, true)).toBe(true);
    expect(keepBodies({ devSink: null } as never, true)).toBe(false);
  });
  it('redacts secret-looking query values in the URL', () => {
    const u = observedUrl(`https://app.test/login?user=ana&access_token=${SECRET}&next=/home`);
    expect(u).not.toContain(SECRET);
    expect(u).toContain('user=ana');
    expect(u).toContain('next=');
  });
});

describe('observing', () => {
  const policy = (over: object = {}) => ({ enabled: true, effective: { targetDomains: ['app.test'] }, ...over }) as never;
  it('records a guarded host only while protection is active', () => {
    expect(observing(policy(), true, 'https://app.test/x')).toBe(true);
    expect(observing(policy({ enabled: false }), true, 'https://app.test/x')).toBe(false);
    expect(observing(policy(), false, 'https://app.test/x')).toBe(false);
    expect(observing(policy(), true, 'https://other.test/x')).toBe(false);
  });
});

// The listeners are registered for the guarded domains, and the request body is asked for only in a development
// build, so requests elsewhere in the browser are never copied.
describe('observer listeners follow the guarded domains', () => {
  it('builds match patterns for every scheme webRequest reports, with no subdomain form for an IP', () => {
    const p = urlPatterns(['Linear.app', '127.0.0.1', '']);
    expect(p).toEqual(expect.arrayContaining(['*://linear.app/*', '*://*.linear.app/*', 'ws://linear.app/*', 'wss://*.linear.app/*', '*://127.0.0.1/*', 'wss://127.0.0.1/*']));
    expect(p).not.toContain('*://*.127.0.0.1/*');
    expect(urlPatterns([])).toEqual([]);
  });

  const site = (policy: typeof import('./policy'), domains: string[]) =>
    policy.normalizePolicy({ ...policy.defaultPolicy(), enabled: true, customSites: domains.length ? [{ id: 'a', name: 'a', domains, enabled: true }] : [] });

  it('registers for every URL at the top level, narrows on the policy, and comes off with no sites', async () => {
    vi.resetModules();
    const added: { urls: string[]; spec?: string[] }[] = [];
    let removed = 0;
    let registered: string[] | null = null; // the URL patterns the listeners are registered for now
    const ev = { addListener: (_fn: unknown, filter: { urls: string[] }, spec?: string[]) => { added.push({ urls: filter.urls, spec }); registered = filter.urls; }, removeListener: () => { removed++; registered = null; } };
    vi.stubGlobal('chrome', { webRequest: { onBeforeRequest: ev, onCompleted: ev, onErrorOccurred: ev }, runtime: { getURL: () => 'chrome-extension://x/' } });
    const obs = await import('./observer');
    const policy = await import('./policy');
    obs.init(site(policy, []), () => true);
    expect(registered).toEqual(['<all_urls>']);
    expect(added[0]!.spec).toEqual(['requestBody']); // a development build (vitest): the harness reads bodies
    obs.updatePolicy(site(policy, ['linear.app']));
    expect(registered).toEqual(obs.urlPatterns(['linear.app']));
    expect(removed).toBe(3);
    obs.updatePolicy(site(policy, ['linear.app'])); // unchanged: no churn
    expect(removed).toBe(3);
    obs.updatePolicy(site(policy, []));
    expect(registered).toBeNull();
    expect(removed).toBe(6);
    vi.unstubAllGlobals();
  });

  it('observes every URL rather than nothing when the browser refuses a pattern', async () => {
    vi.resetModules();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let registered: string[] | null = null;
    const ev = { addListener: (_fn: unknown, filter: { urls: string[] }) => { if (filter.urls[0] !== '<all_urls>') throw new Error('Invalid url pattern'); registered = filter.urls; }, removeListener: () => { registered = null; } };
    vi.stubGlobal('chrome', { webRequest: { onBeforeRequest: ev, onCompleted: ev, onErrorOccurred: ev }, runtime: { getURL: () => 'chrome-extension://x/' } });
    const obs = await import('./observer');
    const policy = await import('./policy');
    obs.init(site(policy, []), () => true);
    obs.updatePolicy(site(policy, ['linear.app']));
    expect(registered).toEqual(['<all_urls>']);
    vi.unstubAllGlobals();
  });

  it('drops the oldest observations past the byte ceiling', async () => {
    vi.resetModules();
    let before: ((d: unknown) => void) | undefined;
    const ev = { addListener: (fn: (d: unknown) => void) => { before ??= fn; }, removeListener: () => {} };
    vi.stubGlobal('chrome', {
      webRequest: { onBeforeRequest: ev, onCompleted: ev, onErrorOccurred: ev }, runtime: { getURL: () => 'chrome-extension://x/' },
      storage: { local: { get: async () => ({}), set: async () => {} } },
    });
    const obs = await import('./observer');
    const policy = await import('./policy');
    obs.init(site(policy, ['app.test']), () => true);
    const path = 'z'.repeat(1500);
    for (let i = 0; i < 5000; i++) before!({ timeStamp: i, requestId: String(i), tabId: 1, method: 'GET', url: `https://app.test/${path}?i=${i}`, type: 'xmlhttprequest' });
    await vi.waitFor(async () => expect(await obs.count()).toBeGreaterThan(800));
    const n = await obs.count();
    expect(n).toBeLessThan(5000);
    expect(n * 1600).toBeLessThanOrEqual(obs.MAX_BYTES);
    expect((await obs.list())[0]!.url).toContain('i=4999'); // newest first; the oldest went
    vi.unstubAllGlobals();
  });
});

// A rejected first read is not kept: it is reported, answered as empty, and read again next time, so `count()`
// and `status:get` (the popup) keep working.
describe('observer reads', () => {
  it('answers empty while storage cannot be read, records nothing over it, and reads again on the next call', async () => {
    vi.resetModules();
    const s = { failing: true };
    const stored = [{ ts: 1, requestId: 'a', tabId: 1, method: 'GET', url: 'https://x.com/', type: 'xmlhttprequest' }];
    vi.stubGlobal('chrome', {
      storage: { local: { get: async (k: string) => { if (s.failing) throw new Error('IO error'); return { [k]: stored }; }, set: async () => {} } },
      webRequest: { onBeforeRequest: { addListener: () => {}, removeListener: () => {} }, onCompleted: { addListener: () => {}, removeListener: () => {} }, onErrorOccurred: { addListener: () => {}, removeListener: () => {} } },
      runtime: { getURL: () => 'chrome-extension://onlyread/' },
    });
    const observer = await import('./observer');
    const { storageProblem } = await import('./storage-health');
    expect(await observer.count()).toBe(0);
    expect(await observer.list()).toEqual([]);
    expect(storageProblem()).toMatch(/request log could not be read \(IO error\)/);
    s.failing = false;
    expect(await observer.count()).toBe(1);
    expect(storageProblem()).toBeUndefined();
    vi.unstubAllGlobals();
  });
});
