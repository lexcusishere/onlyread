import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Policy } from '../shared/types';

// The rules guard.ts installs, with the browser's rule tables, the tabs and the debugger replaced: which dynamic
// rules exist in each state, when the worker-origin rule lets a host past, and what every web tab is told.
const h = vi.hoisted(() => ({
  dynamic: [] as chrome.declarativeNetRequest.Rule[],
  session: [] as chrome.declarativeNetRequest.Rule[],
  targets: [] as { id: string; type: string; url: string; tabId?: number; attached: boolean }[],
  intercepted: [] as string[],
  held: new Set<string>(),
  tabs: [] as { id?: number; url?: string }[],
  sent: [] as [number, unknown][],
}));
vi.mock('./audit', () => ({ record: async () => {}, clearBadge: () => {} }));
vi.mock('./sink', () => ({ send: () => {} }));
vi.mock('./debugger', async (orig) => ({
  ...(await orig<typeof import('./debugger')>()),
  interceptedWorkerHosts: () => h.intercepted,
  heldTargetIds: () => h.held,
  attach: vi.fn(async () => true),
  attachExisting: vi.fn(async () => ({ attached: [], failed: [] })),
  unheldGuardedTabs: vi.fn(async () => []),
}));

const apply = (list: chrome.declarativeNetRequest.Rule[], o: { removeRuleIds?: number[]; addRules?: chrome.declarativeNetRequest.Rule[] }) => {
  const gone = new Set(o.removeRuleIds ?? []);
  const kept = list.filter((r) => !gone.has(r.id));
  list.length = 0; list.push(...kept, ...(o.addRules ?? []));
};
vi.stubGlobal('chrome', {
  declarativeNetRequest: {
    getDynamicRules: async () => [...h.dynamic], updateDynamicRules: async (o: never) => apply(h.dynamic, o),
    getSessionRules: async () => [...h.session], updateSessionRules: async (o: never) => apply(h.session, o),
  },
  debugger: { getTargets: async () => h.targets },
  tabs: {
    query: async () => h.tabs,
    sendMessage: async (id: number, msg: unknown) => { if (id === 99) throw new Error('no content script'); h.sent.push([id, msg]); },
  },
});

const { refreshRules, refreshWorkerRule, broadcastEditorGuard, guardConfig, holdGuardedTabs } = await import('./guard');
const { FAIL_CLOSED_RULE_ID, UNGUARDED_TAB_RULE_ID, WORKER_ORIGIN_RULE_ID } = await import('./rules');
const dbg = await import('./debugger');
const { S } = await import('./state');
const { defaultPolicy, normalizePolicy } = await import('./policy');

const policy = (patch: Partial<Policy> = {}): Policy => normalizePolicy({
  ...defaultPolicy(), enabled: true, attachWhen: 'always', mode: 'enforce',
  customSites: [{ id: 'x.com', name: 'X', domains: ['x.com'], enabled: true }], ...patch,
});
const workerRule = () => h.session.find((r) => r.id === WORKER_ORIGIN_RULE_ID);

beforeEach(() => {
  h.dynamic.length = 0; h.session.length = 0; h.targets.length = 0; h.intercepted.length = 0; h.held.clear(); h.tabs.length = 0; h.sent.length = 0;
  S.policy = policy(); S.agentSession = false; S.failClosed = false; S.workerHosts = [];
});

describe('refreshRules', () => {
  it('installs the dynamic rules and the worker fence while attached and enforcing', async () => {
    await refreshRules();
    expect([...S.ruleReasons.values()]).toEqual(expect.arrayContaining(['mutating-method', 'post-navigation', 'beacon']));
    expect(h.dynamic.map((r) => r.id).sort()).toEqual([...S.ruleReasons.keys()].sort());
    expect(workerRule()?.condition).toMatchObject({ requestDomains: ['x.com'], tabIds: [-1] });
    expect(S.workerOrigin).toBe(true);
  });
  it('adds the fail-closed rule when asked, and no worker fence in monitor mode', async () => {
    S.failClosed = true;
    await refreshRules();
    expect([...S.ruleReasons.values()]).toContain('fail-closed:debugger-detached');
    S.failClosed = false; S.policy = policy({ mode: 'monitor' });
    await refreshRules();
    expect(workerRule()).toBeUndefined();
    expect(S.workerOrigin).toBe(false);
  });
  it('removes every rule while dormant (agent-session mode with no session), so normal browsing is untouched', async () => {
    await refreshRules();
    expect(h.dynamic.length).toBeGreaterThan(0);
    S.policy = policy({ attachWhen: 'agent-session' }); S.agentSession = false;
    await refreshRules();
    expect(h.dynamic).toEqual([]);
    expect(S.ruleReasons.size).toBe(0);
    expect(workerRule()).toBeUndefined();
  });
});

describe('refreshWorkerRule', () => {
  it('lets a host past the fence only while every one of its workers is held, and fences it again when one is not', async () => {
    h.intercepted.push('x.com');
    h.targets.push({ id: 'sw1', type: 'worker', url: 'https://x.com/sw.js', attached: true });
    h.held.add('sw1');
    await refreshWorkerRule();
    expect(S.workerHosts).toEqual(['x.com']);
    expect(workerRule()?.condition.excludedInitiatorDomains).toEqual(['x.com']);
    h.targets.push({ id: 'sw2', type: 'worker', url: 'https://x.com/push-sw.js', attached: false }); // woken with no tab
    await refreshWorkerRule();
    expect(S.workerHosts).toEqual([]);
    expect(workerRule()?.condition.excludedInitiatorDomains).toBeUndefined();
  });
  it('does not rewrite an unchanged rule, and drops it when nothing is enforced', async () => {
    S.policy = policy({ customSites: [{ id: 'y.com', name: 'Y', domains: ['y.com'], enabled: true }] }); // a rule the module has not written yet
    const updates = vi.spyOn(chrome.declarativeNetRequest, 'updateSessionRules');
    await refreshWorkerRule();
    await refreshWorkerRule();
    expect(updates).toHaveBeenCalledTimes(1);
    S.policy = policy({ enabled: false });
    await refreshWorkerRule();
    expect(workerRule()).toBeUndefined();
  });
});

describe('broadcastEditorGuard', () => {
  it('tells every web tab what the content script does on its host, and survives a tab with no content script', async () => {
    h.tabs.push({ id: 1, url: 'https://x.com/home' }, { id: 2, url: 'https://news.example.org/' }, { url: 'https://x.com/no-id' }, { id: 99, url: 'https://x.com/closed' });
    await broadcastEditorGuard();
    expect(h.sent).toEqual([
      [1, { type: 'onlyread:config', ...guardConfig('x.com') }],
      [2, { type: 'onlyread:config', ...guardConfig('news.example.org') }],
    ]);
    expect(h.sent[0]![1]).toMatchObject({ guarded: true, holdClose: true });
    expect(h.sent[1]![1]).toMatchObject({ guarded: false });
  });
});

describe('holdGuardedTabs', () => {
  it('lifts the global block before the attaches end: each unheld tab is fenced by the per-tab rule, a slow one alone stays', async () => {
    S.failClosed = true;
    await refreshRules();
    expect(h.dynamic.some((r) => r.id === FAIL_CLOSED_RULE_ID)).toBe(true);
    vi.mocked(dbg.unheldGuardedTabs).mockResolvedValueOnce([7, 8]);
    let finish!: (r: { attached: number[]; failed: number[] }) => void;
    let during: { global: boolean; fenced?: number[] } | undefined;
    vi.mocked(dbg.attachExisting).mockImplementationOnce(() => new Promise((res) => {
      // While the tabs are still attaching (one of them slow): the global block is already gone, both tabs fenced.
      during = { global: h.dynamic.some((r) => r.id === FAIL_CLOSED_RULE_ID), fenced: h.session.find((r) => r.id === UNGUARDED_TAB_RULE_ID)?.condition.tabIds };
      finish = res;
    }));
    const done = holdGuardedTabs(true);
    await vi.waitFor(() => expect(during).toBeDefined());
    expect(during).toEqual({ global: false, fenced: [7, 8] });
    finish({ attached: [7], failed: [8] });
    await done;
    expect(S.failClosed).toBe(false);
    expect(h.session.find((r) => r.id === UNGUARDED_TAB_RULE_ID)?.condition.tabIds).toEqual([8]);
  });
});
