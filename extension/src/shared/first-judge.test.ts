import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FIRST_JUDGE_KEY, markFirstJudge } from './first-judge';

describe('the first AI judge set up', () => {
  let store: Record<string, unknown>;
  beforeEach(() => {
    store = {};
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: async (k: string) => (k in store ? { [k]: store[k] } : {}),
          set: async (o: Record<string, unknown>) => { Object.assign(store, o); },
        },
      },
    });
  });

  it('is first once: the demo follows it, and no later one', async () => {
    expect(await markFirstJudge()).toBe(true);
    expect(typeof store[FIRST_JUDGE_KEY]).toBe('number');
    expect(await markFirstJudge()).toBe(false);
  });

  it('is first again once the record is removed (a reinstall, or a hand-made reset)', async () => {
    await markFirstJudge();
    delete store[FIRST_JUDGE_KEY];
    expect(await markFirstJudge()).toBe(true);
  });
});
