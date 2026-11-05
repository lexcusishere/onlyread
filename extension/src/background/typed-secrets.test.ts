import { beforeEach, describe, expect, it } from 'vitest';
import { forget, known, remember } from './typed-secrets';

beforeEach(() => { for (const t of [1, 2, 3]) forget(t); for (let i = 0; i < 40; i++) forget(100 + i); });

describe('typed secrets', () => {
  it('holds the latest value of each field, from every tab', () => {
    remember(1, 'f#0', 'hunt', 0); remember(1, 'f#0', 'hunter22', 1); remember(2, 'g#0', '482913', 2);
    expect(known(3).sort()).toEqual(['482913', 'hunter22']);
  });
  it('forgets a cleared field, a closed tab, and anything ten minutes old', () => {
    remember(1, 'f#0', 'hunter22', 0); remember(2, 'g#0', '482913', 0); remember(3, 'h#0', 'abcdef', 0);
    remember(1, 'f#0', '', 1);
    forget(2);
    expect(known(1)).toEqual(['abcdef']);
    expect(known(10 * 60_000 + 1)).toEqual([]);
  });
  it('holds at most 32 fields, dropping the oldest, and nothing over 256 characters', () => {
    for (let i = 0; i < 40; i++) remember(100 + i, 'f#0', `value-${i}`, i);
    const k = known(40);
    expect(k).toHaveLength(32);
    expect(k).not.toContain('value-0');
    remember(1, 'f#0', 'x'.repeat(257), 41);
    expect(known(41)).not.toContain('x'.repeat(257));
  });
});

describe('per-tab limit', () => {
  it('filling many fields in one tab does not push out a value typed in another', async () => {
    const { remember, known, forget } = await import('./typed-secrets');
    remember(1, 'f#pw', 'real-pass-1', 0);
    for (let i = 0; i < 40; i++) remember(2, `f#${i}`, `filler-${i}`, 1);
    expect(known(2)).toContain('real-pass-1');
    expect(known(2).filter((v) => v.startsWith('filler-'))).toHaveLength(6);
    forget(1); forget(2);
  });
});
