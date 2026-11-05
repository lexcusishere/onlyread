import { describe, it, expect, vi, afterEach } from 'vitest';
import { UnguardedTabs } from './unguarded';
import { replaceSessionRule, BLOCK_ALL_RULE_ID, UNGUARDED_TAB_RULE_ID, WORKER_ORIGIN_RULE_ID, FAIL_CLOSED_RULE_ID } from './rules';

type Rule = chrome.declarativeNetRequest.Rule;

/** A browser in miniature: the per-tab rule it accepted, the global block, and which tabs the debugger
 *  holds. `blocked(tab)` says whether a write from that tab is refused, which is what the review asks. */
function world(opts: { held?: number[] } = {}) {
  const w = {
    installed: null as Rule | null,
    globalBlock: false,
    held: new Set(opts.held ?? []),
    open: new Set<number>([1, 2, 3]),
    refuseInstalls: 0,
    installs: 0,
    logs: [] as string[],
    blocked(tab: number): boolean {
      if (w.globalBlock) return true;
      if (w.held.has(tab)) return false; // the debugger judges it
      return Boolean(w.installed?.condition.tabIds?.includes(tab));
    },
  };
  const tabs = new UnguardedTabs({
    ruleFor: (ids) => (ids.length ? { id: UNGUARDED_TAB_RULE_ID, priority: 250, action: { type: 'block' as never }, condition: { tabIds: ids } } : null),
    install: async (rule) => {
      w.installs++;
      if (w.refuseInstalls > 0) { w.refuseInstalls--; throw new Error('Internal error'); }
      w.installed = rule;
    },
    reattach: async (tab) => (!w.open.has(tab) ? 'gone' : w.held.has(tab) ? 'held' : 'failed'),
    setGlobalBlock: async (on) => { w.globalBlock = on; },
    log: (m) => { w.logs.push(m); },
  });
  return { w, tabs };
}

describe('unguarded tabs', () => {
  it('a refused rule update keeps the global block on, and the retry installs it and only then lifts the block', async () => {
    const { w, tabs } = world({ held: [1] });
    w.globalBlock = true; // startup: the global block is on while tabs are attached
    w.refuseInstalls = 1;
    expect(await tabs.settle([2], true)).toBe(false);
    expect(w.installed).toBeNull();
    expect(w.blocked(2)).toBe(true); // still refused: the global block stayed
    expect(w.globalBlock).toBe(true); // its lift waits for the rule to be installed

    // The browser recovers; tab 2 still cannot be attached. The retry must re-send the same rule.
    expect(await tabs.retry()).toBe(true);
    expect(w.installs).toBe(2);
    expect(w.installed?.condition.tabIds).toEqual([2]);
    expect(w.globalBlock).toBe(false);
    expect(w.blocked(2)).toBe(true); // now by its own rule
    expect(w.blocked(1)).toBe(false); // the held tab is judged, not blanket-blocked
  });

  it('turns the global block on when the per-tab rule cannot be installed and it was off', async () => {
    const { w, tabs } = world();
    w.refuseInstalls = 5;
    await tabs.settle([3], false);
    expect(w.globalBlock).toBe(true);
    for (let i = 0; i < 3; i++) await tabs.retry();
    expect(w.globalBlock).toBe(true); // every retry failed: never lifted
    expect(w.installs).toBe(4);
    await tabs.retry(); // 5th refusal
    await tabs.retry(); // accepted
    expect(w.globalBlock).toBe(false);
    expect(w.blocked(3)).toBe(true);
  });

  it('a tab lost after startup stays blocked while its rule is refused, and the global block lifts only after the rule is in (third pass)', async () => {
    const { w, tabs } = world({ held: [1] });
    await tabs.settle([], false);
    expect(w.globalBlock).toBe(false);
    const install = w.installs;
    w.refuseInstalls = 3;
    expect(await tabs.lost(2)).toBe(false);
    expect(w.blocked(2)).toBe(true); // global block on at once
    expect(w.blocked(1)).toBe(true); // (everything is, while the fallback holds)
    for (let i = 0; i < 2; i++) {
      expect(await tabs.retry()).toBe(false);
      expect(w.blocked(2)).toBe(true);
    }
    // The rule API recovers: the per-tab rule goes in first, then the global block is released.
    expect(await tabs.retry()).toBe(true);
    expect(w.installs).toBe(install + 4);
    expect(w.installed?.condition.tabIds).toEqual([2]);
    expect(w.globalBlock).toBe(false);
    expect(w.blocked(2)).toBe(true); // by its own rule now
    expect(w.blocked(1)).toBe(false);
  });

  it('the per-tab rule is confirmed before the global block is released', async () => {
    const order: string[] = [];
    let refuse = 1;
    const tabs = new UnguardedTabs({
      ruleFor: (ids) => (ids.length ? { id: UNGUARDED_TAB_RULE_ID, priority: 250, action: { type: 'block' as never }, condition: { tabIds: ids } } : null),
      install: async () => { if (refuse-- > 0) { order.push('install-refused'); throw new Error('x'); } order.push('install-ok'); },
      reattach: async () => 'failed',
      setGlobalBlock: async (on) => { order.push(on ? 'global-on' : 'global-off'); },
      log: () => {},
    });
    await tabs.lost(4);
    await tabs.retry();
    expect(order).toEqual(['install-refused', 'global-on', 'install-ok', 'global-off']);
  });

  it('a tab is released only when it is held again or gone', async () => {
    const { w, tabs } = world();
    await tabs.settle([2, 3], false);
    w.held.add(2); w.open.delete(3);
    await tabs.retry();
    expect(tabs.tabs()).toEqual([]);
    expect(w.installed).toBeNull();
  });

  it('updates run in order: a slow retry does not bring back a tab a later update removed, or drop one it added', async () => {
    const { w, tabs } = world();
    await tabs.settle([2], false);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const slow = new UnguardedTabs({
      ruleFor: (ids) => (ids.length ? { id: UNGUARDED_TAB_RULE_ID, priority: 250, action: { type: 'block' as never }, condition: { tabIds: ids } } : null),
      install: async (rule) => { await gate; w.installed = rule; },
      reattach: async () => 'failed',
      setGlobalBlock: async () => {},
      log: () => {},
    });
    const a = slow.replace([2]);
    const b = slow.add(3);
    const c = slow.remove([2]);
    release();
    await Promise.all([a, b, c]);
    expect(slow.tabs()).toEqual([3]);
    expect(w.installed?.condition.tabIds).toEqual([3]);
  });

  it('clear() removes the rule and forgets a waiting lift (dormant)', async () => {
    const { w, tabs } = world();
    w.refuseInstalls = 1;
    await tabs.settle([2], false);
    await tabs.clear();
    expect(await tabs.retry()).toBe(true);
    expect(w.globalBlock).toBe(true); // the forgotten lift does not come back with a retry
    expect(w.installed).toBeNull();
  });
});

describe('session rules have distinct ids, and each command replaces only its own', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('ids are unique', () => {
    const ids = [FAIL_CLOSED_RULE_ID, WORKER_ORIGIN_RULE_ID, UNGUARDED_TAB_RULE_ID, BLOCK_ALL_RULE_ID];
    expect(new Set(ids).size).toBe(ids.length);
  });
  it('turning the dev block-all rule off leaves the unguarded-tab rule in place', async () => {
    let rules: Rule[] = [
      { id: UNGUARDED_TAB_RULE_ID, priority: 250, action: { type: 'block' as never }, condition: { tabIds: [2] } },
      { id: BLOCK_ALL_RULE_ID, priority: 300, action: { type: 'block' as never }, condition: {} },
    ];
    vi.stubGlobal('chrome', { declarativeNetRequest: {
      getSessionRules: async () => rules,
      updateSessionRules: async ({ removeRuleIds = [], addRules = [] }: { removeRuleIds?: number[]; addRules?: Rule[] }) => {
        rules = [...rules.filter((r) => !removeRuleIds.includes(r.id)), ...addRules];
      },
    } });
    await replaceSessionRule(BLOCK_ALL_RULE_ID, null);
    expect(rules.map((r) => r.id)).toEqual([UNGUARDED_TAB_RULE_ID]);
    await expect(replaceSessionRule(BLOCK_ALL_RULE_ID, { ...rules[0]! })).rejects.toThrow(/does not match/);
  });
});

import { detachNeedsCover } from './unguarded';
import { init as dbgInit, attachCommitted } from './debugger';

describe('the production paths that lose a tab reach the same fallback (third pass)', () => {
  afterEach(() => vi.unstubAllGlobals());
  const listeners = () => {
    const l: Record<string, ((...a: unknown[]) => void)[]> = {};
    const ev = (name: string) => ({ addListener: (f: (...a: unknown[]) => void) => { (l[name] ??= []).push(f); } });
    return { l, ev };
  };

  it('a debugger detach (not a closed tab, protection active) blocks the tab while its rule is refused', async () => {
    const { w, tabs } = world();
    await tabs.settle([], false);
    w.refuseInstalls = 1;
    const { l, ev } = listeners();
    vi.stubGlobal('chrome', {
      debugger: { onEvent: ev('onEvent'), onDetach: ev('onDetach'), attach: async () => {}, detach: async () => {}, sendCommand: async () => ({}) },
      webNavigation: { onCommitted: ev('onCommitted') },
      tabs: { onRemoved: ev('onRemoved') },
    });
    const lost: Promise<boolean>[] = [];
    dbgInit({
      onPaused: async () => 'continue' as const,
      // index.ts onDetach: the same decision, then the same call.
      onDetach: (tabId, reason) => { if (detachNeedsCover(reason, true)) lost.push(tabs.lost(tabId)); },
      shouldAttach: () => true, recentActions: () => [],
    });
    for (const f of l.onDetach ?? []) f({ tabId: 5 }, 'canceled_by_user');
    for (const f of l.onDetach ?? []) f({ tabId: 6 }, 'target_closed');
    await Promise.all(lost);
    expect(w.blocked(5)).toBe(true);
    expect(w.globalBlock).toBe(true);
    expect(tabs.has(6)).toBe(false);
    expect(detachNeedsCover('canceled_by_user', false)).toBe(false); // dormant: expected, no cover
  });

  it('a new page the debugger cannot attach to blocks the tab while its rule is refused', async () => {
    const { w, tabs } = world();
    await tabs.settle([], false);
    w.refuseInstalls = 1;
    const { ev } = listeners();
    vi.stubGlobal('chrome', {
      debugger: { onEvent: ev('onEvent'), onDetach: ev('onDetach'), attach: async () => { throw new Error('Another debugger is already attached'); }, detach: async () => {}, sendCommand: async () => ({}) },
      webNavigation: { onCommitted: ev('onCommitted') }, tabs: { onRemoved: ev('onRemoved') },
    });
    dbgInit({ onPaused: async () => 'continue' as const, onDetach: () => {}, shouldAttach: () => true, recentActions: () => [] });
    let p: Promise<boolean> | undefined;
    await attachCommitted(8, 'https://linear.app/x', (id) => { p = tabs.lost(id); });
    expect(await p).toBe(false);
    expect(w.blocked(8)).toBe(true);
    expect(w.globalBlock).toBe(true);
  });

  it('a quiet change (an agent look\'s moment of let-go) logs nothing, unless its rule fails to install', async () => {
    const { w, tabs } = world();
    await tabs.add(2, true);
    await tabs.remove([2], true);
    expect(w.installs).toBe(2);
    expect(w.logs).toEqual([]);
    w.refuseInstalls = 1;
    await tabs.add(3, true);
    expect(w.logs).toEqual([expect.stringMatching(/^unguarded-tabs:install-failed:/), 'fail-closed:on (unguarded-tab rule not installed)']);
    await tabs.add(1);
    expect(w.logs).toContain('unguarded-tabs:3,1');
  });
});
