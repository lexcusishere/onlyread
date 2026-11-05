import { describe, expect, it } from 'vitest';
import { forget, push, recent, sanitize } from './uiactions';
import type { UiAction } from '../shared/types';

const SECRET = 'SYNTHETIC_REVIEW_SECRET';
const act = (over: Partial<UiAction>): UiAction => ({ ts: Date.now(), type: 'click', tag: 'input', url: 'https://x.test/', ...over });

describe('UI action storage', () => {
  it('drops the name of an action on a sensitive field before storing it', () => {
    push(1, act({ name: SECRET, sensitive: true }));
    expect(JSON.stringify(recent(1))).not.toContain(SECRET);
  });
  it('keeps ordinary names, bounded in length', () => {
    expect(sanitize(act({ name: 'Send' })).name).toBe('Send');
    expect(sanitize(act({ name: 'x'.repeat(500) })).name?.length).toBe(80);
  });
});

describe('forget', () => {
  it('drops a closed tab\'s actions and leaves other tabs alone', () => {
    const now = Date.now();
    push(41, { ts: now, type: 'click', tag: 'button', name: 'A', url: 'https://a.example/' });
    push(42, { ts: now, type: 'click', tag: 'button', name: 'B', url: 'https://b.example/' });
    forget(41);
    expect(recent(41, 1500, now)).toEqual([]);
    expect(recent(42, 1500, now)).toHaveLength(1);
  });
});
