import { beforeEach, describe, expect, it, vi } from 'vitest';

// The background's own writes, told apart from writes made around it.
const store: Record<string, unknown> = {};
type Listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => void;
let listener: Listener | undefined;
const fire = (changes: Record<string, chrome.storage.StorageChange>) => listener?.(changes, 'local');

vi.stubGlobal('chrome', {
  storage: {
    local: {
      get: async (keys: string[]) => Object.fromEntries(keys.filter((k) => k in store).map((k) => [k, store[k]])),
      set: async (o: Record<string, unknown>) => {
        const changes = Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { oldValue: store[k], newValue: v }]));
        Object.assign(store, o); fire(changes);
      },
      remove: async (keys: string[]) => {
        const present = keys.filter((k) => k in store);
        const changes = Object.fromEntries(present.map((k) => [k, { oldValue: store[k] }]));
        for (const k of present) delete store[k];
        if (present.length) fire(changes);
      },
    },
    onChanged: { addListener: (l: Listener) => { listener = l; } },
  },
});

const { onOwnedChange, ownRemove, ownSet } = await import('./owned-storage');
const seen: { keys: string[]; own: boolean }[] = [];
onOwnedChange((changes, own) => seen.push({ keys: Object.keys(changes).filter((k) => k !== 'policyNonce'), own }));

beforeEach(() => { seen.length = 0; for (const k of Object.keys(store)) delete store[k]; });

describe('owned storage', () => {
  it("tells the background's own set and remove from a write made around it", async () => {
    await ownSet({ settingsPin: { hash: 'h' } });
    await chrome.storage.local.set({ settingsPin: { hash: 'x' } });
    await ownRemove('settingsPin');
    expect(seen).toEqual([{ keys: ['settingsPin'], own: true }, { keys: ['settingsPin'], own: false }, { keys: ['settingsPin'], own: true }]);
    expect('settingsPin' in store).toBe(false); // removed, not written as null
  });
  it('leaves no mark for an absent key, so a later outside removal is not taken for its own', async () => {
    await ownRemove('secrets'); // absent: no change event, no mark
    await chrome.storage.local.set({ secrets: { keys: { openrouter: 'k' } } });
    await chrome.storage.local.remove(['secrets']);
    expect(seen.map((s) => s.own)).toEqual([false, false]);
  });
});
