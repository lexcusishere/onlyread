import { describe, expect, it } from 'vitest';
import { unstartedRefusal } from './startup-gate';

describe('unstartedRefusal', () => {
  it('lets everything through once started, and only reads after a startup that failed', () => {
    expect(unstartedRefusal('page:agent-setup-link', true, undefined)).toBeUndefined();
    expect(unstartedRefusal('status:get', false, 'storage unavailable')).toBeUndefined();
    expect(unstartedRefusal('page:agent-setup-hello', false, undefined)).toBeUndefined();
    for (const type of ['page:agent-setup-link', 'page:agent-setup-apply', 'site:add', 'guard-all:set', 'pin:set', 'cloud:signout', undefined]) {
      expect(unstartedRefusal(type, false, 'storage unavailable')).toBe('OnlyRead did not finish starting (storage unavailable); reload it.');
    }
  });
});
