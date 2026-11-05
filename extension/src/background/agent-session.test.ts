import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The session state machine with its neighbours replaced: the debugger module is a fake that says which tabs
// OnlyRead holds and whether another debugger is on them, the guard's rule and attachment calls are recorded,
// and the audit log is dropped. The polling and the targets list come from a fake chrome.
const h = vi.hoisted(() => ({
  calls: [] as string[],
  held: [] as number[],
  /** What foreignDebuggerOn answers per tab OnlyRead holds. */
  foreign: new Map<number, boolean>(),
  managed: [] as string[],
  /** Tabs whose page carries a socket guard (checked less often). */
  armed: [] as number[],
  /** Tabs with a request being decided. */
  busy: new Set<number>(),
}));
vi.mock('./socket-guard', () => ({ armedTabs: () => [...h.armed] }));
vi.mock('./cloud-sync', () => ({
  syncManagedSites: vi.fn(async (reason: string) => { h.managed.push(`sync:${reason}`); }),
  applyPendingManaged: vi.fn(async (reason: string) => { h.managed.push(`apply:${reason}`); }),
}));
vi.mock('./debugger', async (orig) => ({
  ...(await orig<typeof import('./debugger')>()),
  attachedTabs: () => [...h.held],
  ownedTabs: () => new Set(h.held),
  busy: (tabId: number) => h.busy.has(tabId),
  detachAll: async () => { h.calls.push('detachAll'); h.held.length = 0; },
  foreignDebuggerOn: async (tabId: number, _url: string, cover: (on: boolean) => Promise<void>) => {
    await cover(true); h.calls.push(`look:${tabId}`); await cover(false);
    return h.foreign.get(tabId) ?? false;
  },
}));
vi.mock('./guard', () => ({
  refreshRules: vi.fn(async () => { h.calls.push('refreshRules'); }),
  holdGuardedTabs: vi.fn(async (globalOn: boolean) => { h.calls.push(`holdGuardedTabs:${globalOn}`); }),
  broadcastEditorGuard: vi.fn(async () => { h.calls.push('broadcast'); }),
  unguarded: {
    // `quiet`: a look's routine let-go, not logged (unguarded.ts).
    add: vi.fn(async (tabId: number, quiet?: boolean) => { h.calls.push(`cover:${tabId}${quiet ? ':quiet' : ''}`); return true; }),
    remove: vi.fn(async (ids: number[], quiet?: boolean) => { h.calls.push(`uncover:${ids.join(',')}${quiet ? ':quiet' : ''}`); return true; }),
    clear: vi.fn(async () => { h.calls.push('unguarded.clear'); }),
  },
}));
vi.mock('./audit', () => ({ record: async () => {}, clearBadge: () => {} }));
vi.mock('./sink', () => ({ send: () => {} }));

const { markAgentTab, onBannerCancel, readAgentSession, syncAgentWatch, updateAgentSession, withAgentLock } = await import('./agent-session');
const { AGENT_POLL_MS } = await import('./agent-detect');
const { S } = await import('./state');
const { defaultPolicy, normalizePolicy } = await import('./policy');

let session: Record<string, unknown>;
let targets: { type: string; tabId?: number; attached: boolean }[];
const page = (tabId: number, attached: boolean) => ({ type: 'page', tabId, attached });
const policy = (patch: object = {}) => normalizePolicy({ ...defaultPolicy(), enabled: true, attachWhen: 'agent-session', mode: 'enforce', customSites: [{ id: 'app.example.com', name: 'App', domains: ['app.example.com'], enabled: true }], ...patch });
/** Waits for whatever the lock is running (a poll, a session change). */
const settled = () => withAgentLock(async () => {});

beforeEach(() => {
  session = {}; targets = []; h.calls.length = 0; h.held.length = 0; h.foreign.clear(); h.managed.length = 0; h.armed.length = 0; h.busy.clear();
  vi.stubGlobal('chrome', {
    storage: { session: {
      get: async (keys: string[]) => Object.fromEntries(keys.filter((k) => k in session).map((k) => [k, session[k]])),
      set: async (o: Record<string, unknown>) => { Object.assign(session, o); },
    } },
    debugger: { getTargets: async () => targets },
    tabs: { get: async (id: number) => ({ id, url: `https://app.example.com/${id}` }) },
  });
  S.policy = policy();
  S.agentSession = false; S.declaredSession = false; S.agentTabs = new Set(); S.failClosed = false;
});
afterEach(async () => {
  S.policy = policy({ enabled: false }); syncAgentWatch(); // stops the poll
  await settled();
  vi.unstubAllGlobals(); vi.useRealTimers();
});

describe('agent session', () => {
  it('comes back from session storage after a worker restart', async () => {
    session = { declaredSession: false, agentTabs: [4] };
    await readAgentSession();
    expect(S.agentTabs).toEqual(new Set([4]));
    expect(S.agentSession).toBe(true);
    session = {};
    await readAgentSession();
    expect(S.agentSession).toBe(false);
  });

  it('a declared session attaches (rules first, then the tabs) and its end detaches and clears the rules', async () => {
    S.declaredSession = true;
    await withAgentLock(() => updateAgentSession('declared'));
    expect(S.agentSession).toBe(true);
    expect(S.failClosed).toBe(true);
    expect(h.calls).toEqual(['refreshRules', 'holdGuardedTabs:true', 'broadcast']);
    expect(session).toEqual({ declaredSession: true, agentTabs: [], agentSeen: [] });
    h.calls.length = 0;
    S.declaredSession = false;
    await withAgentLock(() => updateAgentSession('declared'));
    expect(S.agentSession).toBe(false);
    expect(S.failClosed).toBe(false);
    expect(h.calls).toEqual(['detachAll', 'unguarded.clear', 'refreshRules', 'broadcast']);
    expect(session.declaredSession).toBe(false);
  });

  it('starts with the Pro account\'s latest site list, and applies its waiting change when the session ends, in both modes', async () => {
    for (const attachWhen of ['agent-session', 'always'] as const) {
      S.policy = policy({ attachWhen });
      h.managed.length = 0;
      S.declaredSession = true;
      await withAgentLock(() => updateAgentSession('declared'));
      expect(h.managed).toEqual(['sync:agent-session-start']);
      await withAgentLock(() => updateAgentSession('declared')); // unchanged: nothing
      S.declaredSession = false;
      await withAgentLock(() => updateAgentSession('declared'));
      expect(h.managed).toEqual(['sync:agent-session-start', 'apply:agent-session-end']);
    }
  });

  it('a session that has not changed touches nothing', async () => {
    await withAgentLock(() => updateAgentSession('declared'));
    expect(h.calls).toEqual([]);
  });

  it('in monitor mode a session attaches without the fail-closed rule', async () => {
    S.policy = policy({ mode: 'monitor' });
    S.declaredSession = true;
    await withAgentLock(() => updateAgentSession('declared'));
    expect(S.failClosed).toBe(false);
    expect(h.calls).toEqual(['holdGuardedTabs:false', 'broadcast']);
  });

  it('a tab that already had a debugger when OnlyRead attached is an agent tab; marking it twice is one start', async () => {
    await markAgentTab(5);
    expect(S.agentTabs).toEqual(new Set([5]));
    expect(S.agentSession).toBe(true);
    expect(h.calls.filter((c) => c.startsWith('holdGuardedTabs'))).toHaveLength(1);
    await markAgentTab(5);
    expect(h.calls.filter((c) => c.startsWith('holdGuardedTabs'))).toHaveLength(1);
  });

  it('in "always" mode a session changes nothing about attachment and only locks the settings', async () => {
    S.policy = policy({ attachWhen: 'always' });
    await markAgentTab(5);
    expect(S.agentSession).toBe(true); // what protection.ts reads for the lock
    expect(h.calls).toEqual([]);
  });

  it('runs session changes one at a time, and a failure does not stop the next', async () => {
    const order: string[] = [];
    const a = withAgentLock(async () => { await new Promise((r) => setTimeout(r, 5)); order.push('a'); });
    const b = withAgentLock(async () => { order.push('b'); throw new Error('boom'); });
    const c = withAgentLock(async () => { order.push('c'); });
    await Promise.all([a, b, c]);
    expect(order).toEqual(['a', 'b', 'c']);
  });
});

describe('watching for agent tabs', () => {
  it('starts the session at the first tab with a foreign debugger, follows the agent into a tab OnlyRead holds, and ends it when the agent is gone', async () => {
    vi.useFakeTimers();
    targets = [page(5, true)]; // an agent drives tab 5; OnlyRead holds nothing yet
    syncAgentWatch(); // looks at once, then every AGENT_POLL_MS
    await settled();
    expect(S.agentTabs).toEqual(new Set([5]));
    expect(S.agentSession).toBe(true);
    expect(h.calls).toContain('holdGuardedTabs:true');
    // The agent closes tab 5 and carries on in tab 6, which OnlyRead attached to first: the targets list cannot
    // tell, so each held tab is looked at (its writes refused by rule meanwhile).
    h.calls.length = 0;
    targets = [page(6, true)]; h.held.push(6); h.foreign.set(6, true);
    await vi.advanceTimersByTimeAsync(AGENT_POLL_MS);
    await settled();
    expect(h.calls).toEqual(['cover:6:quiet', 'look:6', 'uncover:6:quiet']); // routine: nothing in the log
    expect(S.agentTabs).toEqual(new Set([6]));
    expect(S.agentSession).toBe(true);
    // An agent tab stays one until it closes (the report cannot tell the two debuggers apart). Tab 6 closes while
    // OnlyRead holds tab 7 with no other debugger on it: the look finds nothing, and the session ends.
    h.calls.length = 0;
    targets = [page(7, true)]; h.held.length = 0; h.held.push(7); h.foreign.set(7, false);
    await vi.advanceTimersByTimeAsync(AGENT_POLL_MS);
    await settled();
    expect(h.calls.slice(0, 3)).toEqual(['cover:7:quiet', 'look:7', 'uncover:7:quiet']);
    expect(S.agentTabs).toEqual(new Set());
    expect(S.agentSession).toBe(false);
    expect(h.calls).toContain('detachAll');
  });

  it('watches only while protection is on', async () => {
    vi.useFakeTimers();
    S.policy = policy({ enabled: false });
    targets = [page(5, true)];
    syncAgentWatch();
    await vi.advanceTimersByTimeAsync(AGENT_POLL_MS * 3);
    await settled();
    expect(S.agentSession).toBe(false);
  });
});

// An agent that finished may leave its research tabs open; the tab that started the session must not keep it on
// (protection attached, the banner up, the settings locked) with nothing working. A tab no agent was seen on for
// AGENT_IDLE_MS does not hold the session; one an agent is still on keeps it.
describe('agent session: idle agent tabs', () => {
  it('ends the session when no agent was seen on its tab for AGENT_IDLE_MS, and keeps it while one is', async () => {
    const { AGENT_IDLE_MS } = await import('./agent-detect');
    vi.useFakeTimers();
    await readAgentSession();
    // Tab 7 reads as attached while either debugger holds it, as Chrome reports it.
    (globalThis.chrome as unknown as { debugger: { getTargets: () => Promise<unknown[]> } }).debugger.getTargets =
      async () => [page(7, h.held.includes(7) || h.foreign.get(7) === true)];
    h.foreign.set(7, true); // another debugger on tab 7: a session starts
    syncAgentWatch();
    await vi.advanceTimersByTimeAsync(AGENT_POLL_MS); await settled();
    expect(S.agentSession).toBe(true);
    // OnlyRead now holds the tab too; the agent is still on it: a look finds it, the session stays.
    h.held.push(7);
    await vi.advanceTimersByTimeAsync(AGENT_IDLE_MS + 60_000); await settled();
    expect(S.agentSession).toBe(true);
    // The agent is gone but its tab stays open: AGENT_IDLE_MS later the tab no longer counts.
    h.foreign.set(7, false);
    await vi.advanceTimersByTimeAsync(AGENT_IDLE_MS + 120_000); await settled();
    expect(S.agentSession).toBe(false);
    expect(session.agentTabs).toEqual([]);
  });
});

describe('agent session: the agent moves to another tab', () => {
  it('keeps the session when its first tab goes idle while the agent works in a tab OnlyRead attached to first', async () => {
    const { AGENT_IDLE_MS } = await import('./agent-detect');
    vi.useFakeTimers();
    // Tab 27 started the session; the agent then works in tab 29, which OnlyRead held before the agent came.
    // A tab reads as attached while either debugger holds it, as Chrome reports it.
    (globalThis.chrome as unknown as { debugger: { getTargets: () => Promise<unknown[]> } }).debugger.getTargets =
      async () => [27, 29].map((id) => page(id, h.held.includes(id) || h.foreign.get(id) === true));
    h.held.push(27, 29);
    h.foreign.set(27, false); h.foreign.set(29, true);
    S.agentTabs = new Set([27]); S.agentSession = true;
    syncAgentWatch();
    await vi.advanceTimersByTimeAsync(AGENT_IDLE_MS + 10_000); await settled();
    // Never ended and started again (each start has a moment before the tabs are held again).
    expect(h.calls).not.toContain('detachAll');
    expect(S.agentSession).toBe(true);
    expect(S.agentTabs).toEqual(new Set([29]));
    // The agent leaves tab 29 too: AGENT_IDLE_MS later the session ends.
    h.foreign.set(29, false);
    await vi.advanceTimersByTimeAsync(AGENT_IDLE_MS + 10_000); await settled();
    expect(S.agentSession).toBe(false);
    expect(h.calls).toContain('detachAll');
  });
});

// An agent tab OnlyRead holds is looked at often enough that no action of the agent goes unseen (its debugger stays a
// while after each one); a tab whose page carries a socket guard, whose take-back re-arms the guard in its workers,
// less often.
describe('agent session: looking at held agent tabs', () => {
  it('looks every AGENT_PROBE_MS, and a socket-guarded tab every AGENT_PROBE_GUARDED_MS', async () => {
    const { AGENT_PROBE_MS, AGENT_PROBE_GUARDED_MS } = await import('./agent-detect');
    vi.useFakeTimers();
    targets = [page(7, true), page(8, true)];
    h.held.push(7, 8); h.foreign.set(7, true); h.foreign.set(8, true); h.armed.push(8);
    S.agentTabs = new Set([7, 8]); S.agentSession = true;
    syncAgentWatch();
    await settled();
    h.calls.length = 0;
    await vi.advanceTimersByTimeAsync(AGENT_PROBE_GUARDED_MS * 2); await settled();
    const looks = (id: number) => h.calls.filter((c) => c === `look:${id}`).length;
    // The first look comes after the usual pause (a tab that just joined was just seen).
    expect(looks(7)).toBe((AGENT_PROBE_GUARDED_MS * 2) / AGENT_PROBE_MS);
    expect(looks(8)).toBe(2);
  });

  it('puts a look off while the tab is deciding a request, and looks anyway once that has gone on too long', async () => {
    const { AGENT_PROBE_MS, AGENT_PROBE_GUARDED_MS } = await import('./agent-detect');
    vi.useFakeTimers(); // tab 17: no look of an earlier test's tab is remembered for it
    targets = [page(17, true)]; h.held.push(17); h.foreign.set(17, true); h.busy.add(17);
    S.agentTabs = new Set([17]); S.agentSession = true;
    syncAgentWatch();
    await settled();
    h.calls.length = 0;
    await vi.advanceTimersByTimeAsync(AGENT_PROBE_MS * 2); await settled();
    expect(h.calls).not.toContain('look:17');
    await vi.advanceTimersByTimeAsync(AGENT_PROBE_GUARDED_MS); await settled();
    expect(h.calls).toContain('look:17');
  });
});

// Cancel on Chrome's bar for OnlyRead detaches every tab it holds: a look for an agent at once. None there, and the
// session ends now; one there (at work, or its debugger not let go yet), and it holds.
describe('agent session: Cancel on the bar', () => {
  const cancelled = async () => {
    vi.useFakeTimers();
    targets = [page(41, false)]; S.agentTabs = new Set([41]); S.agentSession = true;
    onBannerCancel();
    await vi.advanceTimersByTimeAsync(1_000); await settled();
  };

  it('ends the session at once when no agent\'s debugger is on its tabs', async () => {
    await cancelled();
    expect(S.agentSession).toBe(false);
    expect(h.calls).toContain('detachAll');
  });

  it('keeps it while an agent\'s debugger is on one of its tabs', async () => {
    vi.useFakeTimers();
    targets = [page(42, true)]; S.agentTabs = new Set([42]); S.agentSession = true;
    onBannerCancel();
    await vi.advanceTimersByTimeAsync(1_000); await settled();
    expect(S.agentSession).toBe(true);
    // An agent on a tab OnlyRead still holds is found by a look.
    h.held.push(43); h.foreign.set(43, true); targets = [page(42, false), page(43, true)]; S.agentTabs = new Set([42, 43]);
    onBannerCancel();
    await vi.advanceTimersByTimeAsync(1_000); await settled();
    expect(h.calls).toContain('look:43');
    expect(S.agentSession).toBe(true);
  });

  it('leaves a declared session, and the "always" mode, alone', async () => {
    S.declaredSession = true;
    await cancelled();
    expect(S.agentSession).toBe(true);
    S.declaredSession = false; S.policy = policy({ attachWhen: 'always' });
    await cancelled();
    expect(S.agentSession).toBe(true);
  });
});
