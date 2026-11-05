import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The unguarded-tab retry's attempt at one tab (reattachUnheld) and the lift when a tab is held again (liftHeldTab),
// beside an agent look (debugger.ts foreignDebuggerOn): the look lets go of the tab and takes it back itself, so the
// retry leaves it alone (an attach in the middle would be taken for an agent's debugger), and the lift is not logged.
const h = vi.hoisted(() => ({ looking: new Set<number>(), attached: [] as number[] }));
vi.mock('./debugger', async (orig) => ({
  ...(await orig<typeof import('./debugger')>()),
  lookingAt: (tabId: number) => h.looking.has(tabId),
  attach: async (tabId: number) => { h.attached.push(tabId); return true; },
}));
vi.mock('./rules', async (orig) => ({ ...(await orig<typeof import('./rules')>()), replaceSessionRule: async () => {}, applyRules: async () => {} }));
vi.mock('./account-lock', () => ({ refreshAccountLock: async () => {} }));
vi.mock('./audit', () => ({ record: async () => {}, clearBadge: () => {} }));
vi.mock('./sink', () => ({ send: () => {} }));

const { reattachUnheld, liftHeldTab, unguarded } = await import('./guard');
const { S } = await import('./state');
const { defaultPolicy, normalizePolicy } = await import('./policy');

beforeEach(() => {
  h.looking.clear(); h.attached.length = 0;
  S.policy = normalizePolicy({ ...defaultPolicy(), enabled: true, attachWhen: 'always', mode: 'enforce', customSites: [{ id: 'app.example.com', name: 'App', domains: ['app.example.com'], enabled: true }] });
  vi.stubGlobal('chrome', { tabs: { get: async (id: number) => ({ id, url: 'https://app.example.com/x' }) } });
});
afterEach(() => vi.unstubAllGlobals());

describe('the unguarded-tab retry beside an agent look', () => {
  it('leaves a tab a look is letting go of to the look, and takes back any other', async () => {
    h.looking.add(4);
    expect(await reattachUnheld(4)).toBe('failed'); // still under the rule; the look takes it back
    expect(h.attached).toEqual([]);
    expect(await reattachUnheld(5)).toBe('held');
    expect(h.attached).toEqual([5]);
  });

  it('a tab held again leaves the rule at once, quietly when a look took it back', async () => {
    const remove = vi.spyOn(unguarded, 'remove').mockResolvedValue(true);
    const has = vi.spyOn(unguarded, 'has').mockReturnValue(true);
    try {
      h.looking.add(4);
      liftHeldTab(4);
      liftHeldTab(5);
      expect(remove.mock.calls).toEqual([[[4], true], [[5], false]]);
      has.mockReturnValue(false);
      liftHeldTab(6); // not under the rule: nothing to lift
      expect(remove).toHaveBeenCalledTimes(2);
    } finally { remove.mockRestore(); has.mockRestore(); }
  });
});
