import { describe, expect, it, vi } from 'vitest';
import type { RequestRecord } from '../shared/types';
import type { Decision } from './decision';
import { REPEAT_MS, Repeats, bodyHash, repeatKey } from './repeats';

const rec = (over: Partial<RequestRecord> = {}): RequestRecord => ({
  ts: 0, tabId: 1, requestId: 'r', method: 'POST', url: 'https://x.com/i/api/a', host: 'x.com', path: '/i/api/a', queryKeys: [],
  hasBody: true, bodyHash: bodyHash('{"a":1}'), bodyShape: 'json:a', fingerprint: 'POST x.com/i/api/a json:a', lastUiActions: [], ...over,
});
const allowed: Decision = { verdict: 'allow', action: 'continue', source: 'jev', reason: 'p<allow', latencyMs: 500 };

describe('Repeats', () => {
  it('answers an exact repeat from the earlier answer, marked, without asking again', async () => {
    const r = new Repeats();
    const ask = vi.fn(async () => allowed);
    await r.answer(repeatKey(rec()), ask, 0);
    expect(await r.answer(repeatKey(rec()), ask, 1000)).toMatchObject({ verdict: 'allow', reason: 'repeat:p<allow', latencyMs: 0 });
    expect(ask).toHaveBeenCalledTimes(1);
  });
  it('asks again for a different body, address or click, and after two minutes', async () => {
    const r = new Repeats();
    const ask = vi.fn(async () => allowed);
    await r.answer(repeatKey(rec()), ask, 0);
    await r.answer(repeatKey(rec({ bodyHash: bodyHash('{"a":2}') })), ask, 1);
    await r.answer(repeatKey(rec({ url: 'https://x.com/i/api/a?id=2' })), ask, 2);
    await r.answer(repeatKey(rec({ lastUiActions: [{ ts: 0, type: 'click', tag: 'button', name: 'Delete', url: '' }] })), ask, 3);
    await r.answer(repeatKey(rec()), ask, REPEAT_MS + 1);
    expect(ask).toHaveBeenCalledTimes(5);
  });
  it('shares one pending answer between concurrent repeats', async () => {
    const r = new Repeats();
    let release!: (d: Decision) => void;
    const ask = vi.fn(() => new Promise<Decision>((res) => { release = res; }));
    const both = Promise.all([r.answer(repeatKey(rec()), ask, 0), r.answer(repeatKey(rec()), ask, 1)]);
    release(allowed);
    expect((await both).map((d) => d.reason)).toEqual(['p<allow', 'repeat:p<allow']);
    expect(ask).toHaveBeenCalledTimes(1);
  });
  it('does not keep an answer that came from a failure, nor reuse anything for a body it could not read', async () => {
    const r = new Repeats();
    const ask = vi.fn(async (): Promise<Decision> => ({ verdict: 'block', action: 'fail', source: 'rule', reason: 'judge-timeout' }));
    await r.answer(repeatKey(rec()), ask, 0);
    await r.answer(repeatKey(rec()), ask, 1);
    expect(ask).toHaveBeenCalledTimes(2);
    expect(repeatKey(rec({ bodyHash: undefined }))).toBeUndefined();
  });
});
