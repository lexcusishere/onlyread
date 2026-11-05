import { afterEach, describe, expect, it, vi } from 'vitest';
import { lockedBy, send } from './messaging';

afterEach(() => { vi.unstubAllGlobals(); });
const answer = (r: unknown) => vi.stubGlobal('chrome', { runtime: { sendMessage: async () => r } });

describe('send', () => {
  it('rejects when the background answers only an error, so a refused change is not a success', async () => {
    answer({ error: 'locked:agent:An AI agent is active in this browser, so OnlyRead can\'t turn protection off until it finishes.' });
    await expect(send({ type: 'guard:set', enabled: false })).rejects.toThrow(/^locked:agent:/);
  });
  it('passes through answers that carry an error next to other fields', async () => {
    answer({ ok: false, error: 'That PIN is not right.' });
    expect(await send({ type: 'pin:unlock', pin: '0000' })).toEqual({ ok: false, error: 'That PIN is not right.' });
  });
});

describe('lockedBy', () => {
  it('reads the reason and the sentence of a lock refusal', () => {
    expect(lockedBy(new Error('locked:pin:Enter your settings PIN to switch gmail off.'))).toEqual({ reason: 'pin', text: 'Enter your settings PIN to switch gmail off.' });
  });
  it('is undefined for any other failure', () => {
    expect(lockedBy(new Error('network down'))).toBeUndefined();
  });
});
