import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { recoveryFor, tabsToReloadOnModeChange, RecoveryScheduler } from './recovery';
import type { Policy } from '../shared/types';
import { defaultPolicy } from './policy';

const policy = (over: Partial<Policy> = {}): Policy => ({ ...defaultPolicy(), ...over });

describe('recoveryFor', () => {
  it('never recovers when the request was not enforced', () => {
    expect(recoveryFor(policy({ onRefusedMutation: 'discard' }), false)).toBe('none');
  });
  it('maps the policy knob on an enforced fail', () => {
    expect(recoveryFor(policy({ onRefusedMutation: 'notice' }), true)).toBe('none');
    expect(recoveryFor(policy({ onRefusedMutation: 'reload' }), true)).toBe('reload');
    expect(recoveryFor(policy({ onRefusedMutation: 'discard' }), true)).toBe('discard');
  });
  it('defaults to no recovery', () => {
    expect(recoveryFor(policy(), true)).toBe('none');
  });
});

describe('tabsToReloadOnModeChange', () => {
  const tabs = [
    { id: 1, url: 'https://mail.google.com/mail/u/0/' },
    { id: 2, url: 'https://example.com/other' },
    { id: 3, url: 'https://calendar.google.com/calendar/u/0/r' },
    { id: 4, url: undefined },
  ];
  const domains = ['mail.google.com', 'calendar.google.com'];
  it('reloads only guarded tabs when the mode changed, never the other open tabs', () => {
    expect(tabsToReloadOnModeChange(policy({ mode: 'monitor' }), policy({ mode: 'enforce' }), tabs, domains)).toEqual([1, 3]);
    expect(tabsToReloadOnModeChange(policy({ mode: 'enforce' }), policy({ mode: 'monitor' }), tabs, domains)).toEqual([1, 3]);
  });
  it('reloads nothing when the mode is unchanged', () => {
    expect(tabsToReloadOnModeChange(policy({ mode: 'enforce' }), policy({ mode: 'enforce' }), tabs, domains)).toEqual([]);
  });
});

describe('RecoveryScheduler', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const deps = () => {
    const calls: string[] = [];
    return {
      calls,
      reload: vi.fn(async (t: number) => { calls.push(`reload:${t}`); }),
      clearOrigin: vi.fn(async (t: number) => { calls.push(`clear:${t}`); }),
      log: (t: number, m: string) => calls.push(`log:${t}:${m}`),
      delayMs: 100,
    };
  };

  it('does nothing for none or negative tab ids', () => {
    const d = deps(); const s = new RecoveryScheduler(d);
    s.schedule(-1, 'reload'); s.schedule(5, 'none');
    vi.runAllTimers();
    expect(d.reload).not.toHaveBeenCalled();
  });

  it('reloads once after the debounce, collapsing a burst', async () => {
    const d = deps(); const s = new RecoveryScheduler(d);
    s.schedule(7, 'reload'); s.schedule(7, 'reload'); s.schedule(7, 'reload');
    await vi.runAllTimersAsync();
    expect(d.reload).toHaveBeenCalledTimes(1);
    expect(d.reload).toHaveBeenCalledWith(7);
    expect(d.clearOrigin).not.toHaveBeenCalled();
  });

  it('discard clears the origin before reloading, and supersedes reload in a burst', async () => {
    const d = deps(); const s = new RecoveryScheduler(d);
    s.schedule(7, 'reload'); s.schedule(7, 'discard');
    await vi.runAllTimersAsync();
    expect(d.calls).toEqual(['clear:7', 'reload:7', 'log:7:recover:discard']);
  });

  it('reports a failure without throwing', async () => {
    const d = deps();
    d.reload = vi.fn(async () => { throw new Error('tab gone'); });
    const s = new RecoveryScheduler(d);
    s.schedule(7, 'reload');
    await vi.runAllTimersAsync();
    expect(d.calls.some((c) => c.startsWith('log:7:recover-failed:reload:'))).toBe(true);
  });

  it('cancel prevents a scheduled recovery', async () => {
    const d = deps(); const s = new RecoveryScheduler(d);
    s.schedule(7, 'reload'); s.cancel(7);
    await vi.runAllTimersAsync();
    expect(d.reload).not.toHaveBeenCalled();
  });

  it('skips a recovery within the cooldown', async () => {
    let clock = 0;
    const calls: string[] = [];
    const s = new RecoveryScheduler({
      reload: vi.fn(async () => { calls.push('reload'); }), clearOrigin: vi.fn(async () => {}),
      log: (_t, m) => calls.push(m), delayMs: 10, cooldownMs: 100, now: () => clock,
    });
    s.schedule(1, 'reload'); await vi.runAllTimersAsync();       // clock 0 → runs
    clock = 50; s.schedule(1, 'reload'); await vi.runAllTimersAsync(); // within cooldown → skip
    expect(calls.filter((c) => c === 'reload')).toHaveLength(1);
    expect(calls).toContain('recover-skip:cooldown');
  });

  it('caps recoveries per window, then suppresses the loop', async () => {
    let clock = 0;
    const calls: string[] = [];
    const s = new RecoveryScheduler({
      reload: vi.fn(async () => { calls.push('reload'); }), clearOrigin: vi.fn(async () => {}),
      log: (_t, m) => calls.push(m), delayMs: 10, cooldownMs: 100, windowMs: 1000, maxPerWindow: 3, now: () => clock,
    });
    for (let i = 0; i < 5; i++) { clock += 200; s.schedule(1, 'reload'); await vi.runAllTimersAsync(); }
    expect(calls.filter((c) => c === 'reload')).toHaveLength(3);
    expect(calls).toContain('recover-skip:suppressed');
    // After the window clears, recovery is allowed again.
    clock += 2000; s.schedule(1, 'reload'); await vi.runAllTimersAsync();
    expect(calls.filter((c) => c === 'reload')).toHaveLength(4);
  });
});
