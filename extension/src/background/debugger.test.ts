import { describe, it, expect } from 'vitest';
import { needsPostDataFetch, usableBody, attachmentActive, buildRejectResponse } from './debugger';

describe('needsPostDataFetch', () => {
  it('is true only when a body exists but was not inlined', () => {
    expect(needsPostDataFetch(true, undefined)).toBe(true);
    expect(needsPostDataFetch(true, '{"a":1}')).toBe(false); // inline present
    expect(needsPostDataFetch(false, undefined)).toBe(false); // no body
    expect(needsPostDataFetch(undefined, undefined)).toBe(false);
  });
});

describe('usableBody', () => {
  it('returns the string only when it is present and not base64', () => {
    expect(usableBody({ postData: '[null,[...]]' })).toBe('[null,[...]]');
    expect(usableBody({ postData: '[null,[...]]', base64Encoded: false })).toBe('[null,[...]]');
  });
  it('drops binary and missing bodies so the request stays opaque', () => {
    expect(usableBody({ postData: 'AAAA', base64Encoded: true })).toBeUndefined();
    expect(usableBody({})).toBeUndefined();
    expect(usableBody(undefined)).toBeUndefined();
  });
});

describe('attachmentActive', () => {
  it('is always true in always mode, regardless of the session flag', () => {
    expect(attachmentActive('always', false)).toBe(true);
    expect(attachmentActive('always', true)).toBe(true);
  });
  it('follows the session flag in agent-session mode', () => {
    expect(attachmentActive('agent-session', false)).toBe(false);
    expect(attachmentActive('agent-session', true)).toBe(true);
  });
  it('is never active when disabled (Off), whatever the other settings', () => {
    expect(attachmentActive('always', true, false)).toBe(false);
    expect(attachmentActive('always', false, false)).toBe(false);
    expect(attachmentActive('agent-session', true, false)).toBe(false);
  });
  it('respects enabled=true the same as the default', () => {
    expect(attachmentActive('always', false, true)).toBe(true);
    expect(attachmentActive('agent-session', false, true)).toBe(false);
  });
});

describe('buildRejectResponse', () => {
  it('returns a GraphQL errors body at HTTP 200 for a GraphQL request', () => {
    const r = buildRejectResponse(true, 'https://linear.app');
    expect(r.status).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.errors[0].extensions.code).toBe('FORBIDDEN');
    expect(body.errors[0].extensions.onlyread).toBe(true);
  });
  it('returns 403 for a non-GraphQL request', () => {
    const r = buildRejectResponse(false, 'https://app.example.com');
    expect(r.status).toBe(403);
    expect(JSON.parse(r.body).onlyread).toBe(true);
  });
  it('echoes CORS headers for a cross-origin credentialed call so the browser keeps the response', () => {
    const r = buildRejectResponse(true, 'https://linear.app');
    const h = Object.fromEntries(r.headers.map((x) => [x.name, x.value]));
    expect(h['access-control-allow-origin']).toBe('https://linear.app');
    expect(h['access-control-allow-credentials']).toBe('true');
    expect(h['content-type']).toContain('application/json');
  });
  it('omits CORS headers when there is no Origin (same-origin request)', () => {
    const r = buildRejectResponse(true, undefined);
    expect(r.headers.some((x) => x.name === 'access-control-allow-origin')).toBe(false);
  });
});

import { afterEach, vi } from 'vitest';
import { attachExisting, detach, init } from './debugger';

/** The attach scope, set as index.ts sets it: through init. */
const scope = (shouldAttach: (url: string) => boolean) => init({ onPaused: async () => 'continue', onDetach: () => {}, shouldAttach, recentActions: () => [] });
const listener = { addListener: () => {} };

describe('attachExisting', () => {
  afterEach(async () => { vi.unstubAllGlobals(); for (const id of [1, 2, 3]) await detach(id); });
  it('returns the guarded tabs it could not attach to, and not unguarded or unsupported pages', async () => {
    vi.stubGlobal('chrome', {
      tabs: { query: async () => [{ id: 1, url: 'https://linear.app/a' }, { id: 2, url: 'https://linear.app/b' }, { id: 3, url: 'https://example.com/' }], onRemoved: listener },
      debugger: {
        attach: async ({ tabId }: { tabId: number }) => { if (tabId === 2) throw new Error('Another debugger is already attached'); },
        detach: async () => {},
        sendCommand: async () => ({}),
        onEvent: listener, onDetach: listener,
      },
      webNavigation: { onCommitted: listener },
    });
    scope((url) => new URL(url).hostname === 'linear.app');
    const r = await attachExisting();
    expect(r.failed).toEqual([2]);
    expect(r.attached).toEqual([1]);
  });
});

import { resolvePostData, type PausedParams } from './debugger';

describe('resolvePostData', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
  const paused = (over: Partial<PausedParams> = {}): PausedParams => ({
    requestId: 'interception-7', networkId: 'network-42', frameId: 'f', resourceType: 'XHR',
    request: { url: 'https://linear.app/graphql', method: 'POST', headers: {}, hasPostData: true }, ...over,
  });
  const stub = (sendCommand: (target: unknown, method: string, params?: Record<string, unknown>) => Promise<unknown>) => {
    const calls: { method: string; params?: Record<string, unknown> }[] = [];
    vi.stubGlobal('chrome', { debugger: { sendCommand: (t: unknown, method: string, params?: Record<string, unknown>) => { calls.push({ method, params }); return sendCommand(t, method, params); } } });
    return calls;
  };

  it('asks Network.getRequestPostData by the Network id, not the Fetch id, and returns the body', async () => {
    const calls = stub(async () => ({ postData: '{"query":"query X { a }"}' }));
    expect(await resolvePostData(1, { tabId: 1 }, paused())).toBe('{"query":"query X { a }"}');
    expect(calls).toEqual([{ method: 'Network.getRequestPostData', params: { requestId: 'network-42' } }]);
  });
  it('uses the inline body without any command', async () => {
    const calls = stub(async () => ({}));
    expect(await resolvePostData(1, { tabId: 1 }, paused({ request: { url: 'https://x/', method: 'POST', headers: {}, hasPostData: true, postData: 'a=1' } }))).toBe('a=1');
    expect(calls).toEqual([]);
  });
  it('stays opaque without a Network id', async () => {
    const calls = stub(async () => ({ postData: 'never' }));
    expect(await resolvePostData(1, { tabId: 1 }, paused({ networkId: undefined }))).toBeUndefined();
    expect(calls).toEqual([]);
  });
  it('stays opaque when the read fails or returns binary', async () => {
    stub(async () => { throw new Error('No post data available for the request'); });
    expect(await resolvePostData(1, { tabId: 1 }, paused())).toBeUndefined();
    stub(async () => ({ postData: 'AAAA', base64Encoded: true }));
    expect(await resolvePostData(1, { tabId: 1 }, paused())).toBeUndefined();
  });
  it('stays opaque when the read does not answer in time', async () => {
    vi.useFakeTimers();
    stub(() => new Promise(() => {}));
    const r = resolvePostData(1, { tabId: 1 }, paused(), 2000);
    await vi.advanceTimersByTimeAsync(2001);
    expect(await r).toBeUndefined();
  });
});

import { attachCommitted } from './debugger';

describe('attachCommitted', () => {
  afterEach(async () => { vi.unstubAllGlobals(); await detach(7); });
  const stubAttach = (fail: boolean) => vi.stubGlobal('chrome', {
    debugger: { attach: async () => { if (fail) throw new Error('Another debugger is already attached'); }, detach: async () => {}, sendCommand: async () => ({}), onEvent: listener, onDetach: listener },
    webNavigation: { onCommitted: listener }, tabs: { onRemoved: listener },
  });
  it('reports a guarded page it could not attach to', async () => {
    stubAttach(true);
    scope((url) => new URL(url).hostname === 'linear.app');
    const failed: number[] = [];
    await attachCommitted(7, 'https://linear.app/x', (id) => failed.push(id));
    expect(failed).toEqual([7]);
  });
  it('does not report pages outside the scope, or a successful attach', async () => {
    stubAttach(true);
    scope((url) => new URL(url).hostname === 'linear.app');
    const failed: number[] = [];
    await attachCommitted(7, 'https://example.com/', (id) => failed.push(id));
    stubAttach(false);
    await attachCommitted(7, 'https://linear.app/x', (id) => failed.push(id));
    expect(failed).toEqual([]);
  });
});

import { foreignDebuggerOn, lookingAt } from './debugger';

describe('another debugger on a tab OnlyRead holds', () => {
  afterEach(async () => { vi.unstubAllGlobals(); await detach(9); });
  /** A browser where `agentOn` says whether an agent's debugger is on tab 9, besides OnlyRead's own. */
  const browser = (agentOn: boolean) => {
    let ours = false;
    const log: string[] = [];
    vi.stubGlobal('chrome', {
      debugger: {
        attach: async () => { ours = true; log.push('attach'); },
        detach: async () => { ours = false; log.push('detach'); },
        sendCommand: async () => ({}),
        getTargets: async () => [{ type: 'page', tabId: 9, attached: ours || agentOn }],
        onEvent: { addListener: () => {} }, onDetach: { addListener: () => {} },
      },
      webNavigation: { onCommitted: { addListener: () => {} } },
      tabs: { onRemoved: { addListener: () => {} } },
    });
    return log;
  };
  const marked: number[] = [];
  const initWith = () => init({ onPaused: async () => 'continue', onDetach: () => {}, shouldAttach: () => true, recentActions: () => [], onForeignDebugger: (id) => marked.push(id) });

  it('names the tab an agent tab when another debugger is on it before OnlyRead attaches', async () => {
    browser(true); initWith(); marked.length = 0;
    await attachCommitted(9, 'https://linear.app/x');
    expect(marked).toEqual([9]);
  });
  it('finds an agent that attached after OnlyRead, refusing the tab\'s writes while it looks', async () => {
    const log = browser(true); initWith();
    await attachCommitted(9, 'https://linear.app/x');
    const cover: boolean[] = [];
    expect(await foreignDebuggerOn(9, 'https://linear.app/x', async (on) => { cover.push(on); log.push(`cover:${on}`); })).toBe(true);
    expect(log.slice(-4)).toEqual(['cover:true', 'detach', 'attach', 'cover:false']);
  });
  it('finds none when OnlyRead is the only debugger, and holds the tab again', async () => {
    browser(false); initWith();
    await attachCommitted(9, 'https://linear.app/x');
    expect(await foreignDebuggerOn(9, 'https://linear.app/x', async () => {})).toBe(false);
  });
  it('a tab is marked while a look lets it go and takes it back, so the unguarded-tab retry leaves it to the look', async () => {
    browser(false); initWith();
    await attachCommitted(9, 'https://linear.app/x');
    const during: boolean[] = [];
    await foreignDebuggerOn(9, 'https://linear.app/x', async () => { during.push(lookingAt(9)); });
    expect(during).toEqual([true, true]);
    expect(lookingAt(9)).toBe(false);
  });
  it('the page\'s workers attached again just after a look are not logged; one attached later is', async () => {
    let fire: ((source: chrome.debugger.DebuggerSession, method: string, params?: object) => void) | undefined;
    let ours = false;
    vi.stubGlobal('chrome', {
      debugger: {
        attach: async () => { ours = true; }, detach: async () => { ours = false; },
        sendCommand: async () => ({}),
        getTargets: async () => [{ type: 'page', tabId: 9, attached: ours }],
        onEvent: { addListener: (l: NonNullable<typeof fire>) => { fire = l; } }, onDetach: { addListener: () => {} },
      },
      webNavigation: { onCommitted: { addListener: () => {} } },
      tabs: { onRemoved: { addListener: () => {} } },
    });
    const logged: string[] = [];
    await new Promise((r) => setTimeout(r, 1100)); // past the previous look's quiet moment on the same tab
    init({ onPaused: async () => 'continue', onDetach: () => {}, shouldAttach: () => true, recentActions: () => [], onForeignDebugger: () => {}, log: (_t, m) => logged.push(m) });
    await attachCommitted(9, 'https://linear.app/x');
    const worker = (n: number) => fire!({ tabId: 9 }, 'Target.attachedToTarget', { sessionId: `s${n}`, targetInfo: { type: 'worker', url: `https://linear.app/w${n}.js`, targetId: `t${n}` } });
    await foreignDebuggerOn(9, 'https://linear.app/x', async () => {});
    worker(1); // handed over again as the look takes the tab back
    expect(logged.filter((m) => m.startsWith('target-attached'))).toEqual([]);
    await new Promise((r) => setTimeout(r, 1100));
    worker(2); // a worker the page starts later
    expect(logged.filter((m) => m.startsWith('target-attached'))).toEqual(['target-attached:worker:https://linear.app/w2.js']);
  });
  it('a look\'s own let-go and taking back are not logged: every few seconds while an agent works they would fill the log', async () => {
    await new Promise((r) => setTimeout(r, 1100)); // past the previous look's quiet moment on the same tab
    browser(true);
    const attached: number[] = [];
    init({ onPaused: async () => 'continue', onDetach: () => {}, shouldAttach: () => true, recentActions: () => [], onForeignDebugger: () => {}, onAttach: (id) => attached.push(id) });
    await attachCommitted(9, 'https://linear.app/x');
    expect(attached).toEqual([9]); // a tab held for the first time is
    await foreignDebuggerOn(9, 'https://linear.app/x', async () => {});
    expect(attached).toEqual([9]);
  });
});

import { pending, type Disposition } from './debugger';

describe('a paused request', () => {
  const commands: { method: string; params?: Record<string, unknown> }[] = [];
  let fire: ((source: chrome.debugger.DebuggerSession, method: string, params?: object) => void) | undefined;
  const browser = () => {
    commands.length = 0;
    vi.stubGlobal('chrome', {
      debugger: {
        attach: async () => {}, detach: async () => {}, getTargets: async () => [],
        sendCommand: async (_t: unknown, method: string, params?: Record<string, unknown>) => { commands.push({ method, params }); return {}; },
        onEvent: { addListener: (l: NonNullable<typeof fire>) => { fire = l; } }, onDetach: { addListener: () => {} },
      },
      webNavigation: { onCommitted: { addListener: () => {} } },
      tabs: { onRemoved: { addListener: () => {} } },
    });
  };
  const paused = (url: string): PausedParams => ({ requestId: 'i-1', frameId: 'f', resourceType: 'Fetch', request: { url, method: 'POST', headers: { 'content-type': 'application/json' }, postData: '{"a":1}' } });
  const base = { onDetach: () => {}, shouldAttach: () => true, recentActions: () => [] };
  afterEach(() => { vi.unstubAllGlobals(); });

  it('continues a request to a host outside the guarded sites before reading its body, and does not count it', async () => {
    browser();
    const judged: string[] = [];
    init({ ...base, onPaused: async (rec) => { judged.push(rec.url); return 'fail'; }, shouldJudge: (url) => url.includes('linear.app') });
    fire!({ tabId: 3 }, 'Fetch.requestPaused', paused('https://example.com/api'));
    await vi.waitFor(() => expect(commands).toHaveLength(1));
    expect(commands[0]).toMatchObject({ method: 'Fetch.continueRequest', params: { requestId: 'i-1' } });
    expect(judged).toEqual([]);
    expect(pending()).toBe(0);
    fire!({ tabId: 3 }, 'Fetch.requestPaused', paused('https://linear.app/graphql'));
    await vi.waitFor(() => expect(commands).toHaveLength(2));
    expect(judged).toEqual(['https://linear.app/graphql']);
    expect(commands[1]!.method).toBe('Fetch.failRequest');
  });

  it('asks the caller what a thrown decision gets: continue (monitor) or fail (enforce)', async () => {
    browser();
    const errors: unknown[] = [];
    let answer: Disposition = 'continue';
    init({ ...base, onPaused: async () => { throw new Error('odd body'); }, onDecisionError: (tabId, p, err) => { errors.push([tabId, p.request.url, String(err)]); return answer; } });
    fire!({ tabId: 3 }, 'Fetch.requestPaused', paused('https://linear.app/graphql'));
    await vi.waitFor(() => expect(commands).toHaveLength(1));
    expect(commands[0]!.method).toBe('Fetch.continueRequest');
    expect(errors[0]).toEqual([3, 'https://linear.app/graphql', 'Error: odd body']);
    answer = 'fail';
    fire!({ tabId: 3 }, 'Fetch.requestPaused', paused('https://linear.app/graphql'));
    await vi.waitFor(() => expect(commands).toHaveLength(2));
    expect(commands[1]!.method).toBe('Fetch.failRequest');
  });

  it('fails closed by default when the decision throws', async () => {
    browser();
    init({ ...base, onPaused: async () => { throw new Error('odd body'); } });
    fire!({ tabId: 3 }, 'Fetch.requestPaused', paused('https://linear.app/graphql'));
    await vi.waitFor(() => expect(commands).toHaveLength(1));
    expect(commands[0]!.method).toBe('Fetch.failRequest');
  });
});
