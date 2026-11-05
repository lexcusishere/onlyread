import { describe, expect, it } from 'vitest';
import { ACCOUNT_LOCK_RULE_ID, buildAccountLockRule } from './rules';

describe('buildAccountLockRule', () => {
  const match = (service: string, url: string) => new RegExp(buildAccountLockRule(service)!.condition.regexFilter!).test(url);

  it('refuses only the account page addresses that lower protection, on the service in use', () => {
    const s = 'https://pro.example';
    for (const u of ['/account/sites/off', '/account/sites', '/account/sites?x=1', '/account/browsers/signout', '/account/browsers/off', '/account/delete/confirm', '/account/delete']) {
      expect(match(s, `${s}${u}`), u).toBe(true);
    }
    for (const u of ['/account/sites/edit', '/account/browsers/rename', '/account/browsers/agent', '/account/browsers/guard', '/account/setup-link', '/account', '/account/sites/offx', '/v1/classify']) {
      expect(match(s, `${s}${u}`), u).toBe(false);
    }
    expect(match(s, 'https://evil.example/account/sites/off')).toBe(false);
    expect(match(s, 'https://pro.example.evil.test/account/sites/off')).toBe(false);
  });

  it('keeps a service address with a path of its own, and refuses what is no web address', () => {
    expect(match('http://localhost:4243/cloud/', 'http://localhost:4243/cloud/account/sites/off')).toBe(true);
    expect(match('http://localhost:4243/cloud', 'http://localhost:4243/account/sites/off')).toBe(false);
    expect(buildAccountLockRule('not a url')).toBeNull();
    expect(buildAccountLockRule('chrome-extension://x/')).toBeNull();
    expect(buildAccountLockRule('https://pro.example')).toMatchObject({ id: ACCOUNT_LOCK_RULE_ID, action: { type: 'block' }, condition: { requestMethods: ['post', 'put', 'patch', 'delete'] } });
    // Every resource type: a beacon (`ping`) carried the same POST past a rule that named only fetches and page loads.
    expect(buildAccountLockRule('https://pro.example')!.condition.resourceTypes).toEqual(expect.arrayContaining(['ping', 'xmlhttprequest', 'main_frame', 'other', 'websocket']));
  });
});
