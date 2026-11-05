import { describe, expect, it, vi } from 'vitest';
import { CLOSED_GRACE_MS, ClosingTabs } from './closing-tabs';

const make = () => {
  const installed: (number[] | null)[] = [];
  const tabs = new ClosingTabs({
    ruleFor: (ids) => (ids.length ? ({ id: 1, ids } as unknown as chrome.declarativeNetRequest.Rule) : null),
    install: async (rule) => { installed.push(rule ? (rule as unknown as { ids: number[] }).ids : null); },
  });
  return { tabs, installed };
};

describe('ClosingTabs', () => {
  it('refuses a closing tab\'s writes until a new page commits in it', async () => {
    const { tabs, installed } = make();
    await tabs.add(4);
    await tabs.add(2);
    expect(installed.at(-1)).toEqual([2, 4]);
    await tabs.committed(4);
    expect(installed.at(-1)).toEqual([2]);
    await tabs.committed(9); // never closing: no update
    expect(installed).toHaveLength(3);
  });
  it('keeps a closed tab blocked for a grace period, then forgets it', async () => {
    const { tabs, installed } = make();
    await tabs.add(7);
    const schedule = vi.fn();
    tabs.removed(7, schedule);
    expect(schedule).toHaveBeenCalledWith(expect.any(Function), CLOSED_GRACE_MS);
    expect(tabs.list()).toEqual([7]);
    (schedule.mock.calls[0]![0] as () => void)();
    await vi.waitFor(() => expect(installed.at(-1)).toBeNull());
    expect(tabs.list()).toEqual([]);
  });
});
