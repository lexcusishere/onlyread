import { describe, expect, it } from 'vitest';
import { nextAgentTabs } from './agent-detect';

const page = (tabId: number, attached: boolean) => ({ type: 'page', tabId, attached });

describe('nextAgentTabs', () => {
  it('starts with a tab another debugger is attached to', () => {
    expect([...nextAgentTabs(new Set(), [page(1, true), page(2, false)], new Set())]).toEqual([1]);
  });
  it('ignores tabs only OnlyRead is attached to, and non-page targets', () => {
    expect(nextAgentTabs(new Set(), [page(1, true), { type: 'worker', tabId: 3, attached: true }], new Set([1])).size).toBe(0);
  });
  it('keeps an agent tab after OnlyRead attaches to it as well', () => {
    expect([...nextAgentTabs(new Set([1]), [page(1, true)], new Set([1]))]).toEqual([1]);
  });
  it('drops agent tabs that closed, which ends the session when none are left', () => {
    expect(nextAgentTabs(new Set([1, 2]), [page(2, true)], new Set([2])).has(1)).toBe(false);
    expect(nextAgentTabs(new Set([1]), [page(5, false)], new Set()).size).toBe(0);
  });
});

describe('nextAgentTabs, edge cases', () => {
  it('ignores targets without a tab id (a service worker, the browser)', () => {
    expect(nextAgentTabs(new Set(), [{ type: 'page', attached: true }, { type: 'page', tabId: 9, attached: true }], new Set()).size).toBe(1);
  });
  it('tracks several agent tabs at once and ends only when all are gone', () => {
    let tabs = nextAgentTabs(new Set(), [page(1, true), page(2, true), page(3, false)], new Set());
    expect([...tabs].sort()).toEqual([1, 2]);
    tabs = nextAgentTabs(tabs, [page(2, true), page(3, false)], new Set());
    expect([...tabs]).toEqual([2]);
    tabs = nextAgentTabs(tabs, [page(3, false)], new Set());
    expect(tabs.size).toBe(0);
  });
  it('does not change the set it was given', () => {
    const prev = new Set([1]);
    nextAgentTabs(prev, [page(2, true)], new Set());
    expect([...prev]).toEqual([1]);
  });
});

describe('idleAgentTabs', () => {
  it('drops an agent tab no agent was seen on for AGENT_IDLE_MS, and keeps one seen within them', async () => {
    const { idleAgentTabs, AGENT_IDLE_MS } = await import('./agent-detect');
    const now = 1_000_000_000;
    const seen = new Map([[1, now - AGENT_IDLE_MS], [2, now - AGENT_IDLE_MS + 1], [3, now - AGENT_IDLE_MS / 2]]);
    expect(idleAgentTabs(new Set([1, 2, 3]), seen, now)).toEqual([1]);
    // A tab with no time noted yet was just seen: it stays.
    expect(idleAgentTabs(new Set([4]), seen, now)).toEqual([]);
  });
});

describe('probeDue', () => {
  it('looks at a held agent tab every AGENT_PROBE_MS, one with a socket guard every AGENT_PROBE_GUARDED_MS', async () => {
    const { probeDue, AGENT_PROBE_MS, AGENT_PROBE_GUARDED_MS } = await import('./agent-detect');
    const now = 1_000_000;
    expect(probeDue(now - AGENT_PROBE_MS + 1, now, false, false)).toBe(false);
    expect(probeDue(now - AGENT_PROBE_MS, now, false, false)).toBe(true);
    expect(probeDue(now - AGENT_PROBE_MS, now, true, false)).toBe(false);
    expect(probeDue(now - AGENT_PROBE_GUARDED_MS, now, true, false)).toBe(true);
  });

  it('puts a look off while a request of the tab is being decided, for AGENT_PROBE_GUARDED_MS at most', async () => {
    const { probeDue, AGENT_PROBE_MS, AGENT_PROBE_GUARDED_MS } = await import('./agent-detect');
    const now = 1_000_000;
    expect(probeDue(now - AGENT_PROBE_MS, now, false, true)).toBe(false);
    expect(probeDue(now - AGENT_PROBE_MS - AGENT_PROBE_GUARDED_MS + 1, now, false, true)).toBe(false);
    expect(probeDue(now - AGENT_PROBE_MS - AGENT_PROBE_GUARDED_MS, now, false, true)).toBe(true);
  });
});
