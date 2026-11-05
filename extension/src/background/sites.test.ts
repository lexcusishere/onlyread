import { describe, expect, it } from 'vitest';
import { builtinForHost, guardedSiteIds, hostToSiteId, listSites, resolveEffective, sitesInForce } from './sites';
import { defaultPolicy, normalizePolicy } from './policy';

describe('hostToSiteId', () => {
  it('normalizes a host: lower case, no www, no stray characters', () => {
    expect(hostToSiteId('  WWW.Example.COM ')).toBe('example.com');
    expect(hostToSiteId('tools.example.net/path')).toBe('tools.example.net');
  });
  it('takes the host out of a pasted URL instead of stripping its punctuation', () => {
    expect(hostToSiteId('https://mail.google.com/mail/u/0/')).toBe('mail.google.com');
    expect(hostToSiteId('http://www.example.com:8080/x?y=1')).toBe('example.com');
  });
  it('reads a host typed without a scheme the same way: port and user name dropped, IDN as punycode, never mangled', () => {
    expect(hostToSiteId('app.example.com:8443')).toBe('app.example.com');
    expect(hostToSiteId('app.example.com:8443/x')).toBe('app.example.com');
    expect(hostToSiteId('bücher.de')).toBe('xn--bcher-kva.de');
    expect(hostToSiteId('user@example.com')).toBe('example.com');
    expect(hostToSiteId('not a host')).toBe('');
  });
  it('maps a verified site\'s host to that site', () => {
    expect(builtinForHost(hostToSiteId('https://calendar.google.com/calendar/r'))?.id).toBe('calendar');
    expect(builtinForHost('unknown.example.org')).toBeUndefined();
  });
});

// The account's list is guarded in addition to this browser's own, not instead of it.
describe('the Pro account\'s site list, guarded together with the browser\'s own (cloud-sync.ts)', () => {
  const local = normalizePolicy({
    ...defaultPolicy(), sites: { linear: { enabled: true } },
    customSites: [
      { id: 'app.example.com', name: 'App', domains: ['app.example.com'], enabled: true, iconUrl: 'https://app.example.com/i.png' },
      { id: 'old.example.com', name: 'Old', domains: ['old.example.com'], enabled: false },
      { id: 'both.example.com', name: 'Both here', domains: ['both.example.com', 'api.both.example.com'], enabled: false },
    ],
  });
  const managed = normalizePolicy({
    ...local,
    managed: { version: 4, fetchedAt: 1, sites: { gmail: { enabled: true }, linear: { enabled: false } }, customSites: [
      { id: 'tools.example.net', name: 'Tools', domains: ['tools.example.net'], enabled: true },
      { id: 'both.example.com', name: 'Both', domains: ['both.example.com'], enabled: true },
      { id: 'off.example.org', name: 'Off', domains: ['off.example.org'], enabled: false },
    ] },
  });

  it('guards a site either list guards: built-ins by OR, custom sites by id', () => {
    expect(sitesInForce(local).sites.linear).toEqual({ enabled: true });
    expect(guardedSiteIds(local)).toEqual(['linear', 'app.example.com']);
    // The account switching linear off does not switch off what this browser guards.
    expect(guardedSiteIds(managed)).toEqual(['gmail', 'linear', 'app.example.com', 'both.example.com', 'tools.example.net']);
    expect(resolveEffective(managed).targetDomains).toEqual(expect.arrayContaining(['mail.google.com', 'linear.app', 'app.example.com', 'tools.example.net', 'both.example.com']));
    expect(resolveEffective(managed).targetDomains).not.toContain('old.example.com');
    expect(resolveEffective(managed).targetDomains).not.toContain('off.example.org');
  });

  it('a custom site on both lists takes the account\'s name, both lists\' domains, and the local icon', () => {
    const both = sitesInForce(managed).customSites.find((c) => c.id === 'both.example.com');
    expect(both).toEqual({ id: 'both.example.com', name: 'Both', domains: ['both.example.com', 'api.both.example.com'], enabled: true });
    expect(sitesInForce(managed).customSites.find((c) => c.id === 'app.example.com')?.iconUrl).toBe('https://app.example.com/i.png');
    expect(resolveEffective(managed).targetDomains).toContain('api.both.example.com');
  });

  it('changes neither list', () => {
    expect(managed.sites.linear).toEqual({ enabled: true });
    expect(managed.customSites.map((c) => c.id)).toEqual(['app.example.com', 'old.example.com', 'both.example.com']);
    expect(managed.managed?.customSites.map((c) => c.id)).toEqual(['tools.example.net', 'both.example.com', 'off.example.org']);
  });

  it('says which list guards each site', () => {
    expect(listSites(local).filter((v) => v.account)).toEqual([]);
    const views = listSites(managed, 'app.example.com');
    const by = (id: string) => views.find((v) => v.id === id)!;
    expect(by('gmail')).toMatchObject({ enabled: true, local: false, account: true });
    expect(by('linear')).toMatchObject({ enabled: true, local: true, account: false });
    expect(by('calendar')).toMatchObject({ enabled: false, local: false, account: false });
    expect(by('app.example.com')).toMatchObject({ enabled: true, local: true, account: false, current: true });
    expect(by('both.example.com')).toMatchObject({ enabled: true, local: false, account: true, builtin: false });
    expect(by('tools.example.net')).toMatchObject({ enabled: true, local: false, account: true });
    expect(by('old.example.com')).toMatchObject({ enabled: false, local: false, account: false });
    // Listed on the account switched off, and not here: guarded nowhere, so not a row (the account page shows it).
    expect(by('off.example.org')).toBeUndefined();
    expect(views.filter((v) => !v.builtin).map((v) => v.id)).toEqual(['app.example.com', 'old.example.com', 'both.example.com', 'tools.example.net']);
  });
});

describe('listSites says where on the account a site is, and whether a change of it waits', () => {
  it('names the account lists that guard a site, with the waiting changes laid over', () => {
    const managed = { version: 2, fetchedAt: 1, sites: { gmail: { enabled: true } }, customSites: [], browserSites: { sites: { x: { enabled: true } }, customSites: [] } };
    const p = { sites: {}, customSites: [], managed, accountEdits: [{ op: 'add' as const, scope: 'account' as const, id: 'linear', builtin: true, at: 1 }] };
    const v = Object.fromEntries(listSites(p).map((s) => [s.id, s]));
    expect(v.gmail).toMatchObject({ account: true, scopes: ['account'] });
    expect(v.gmail?.waiting).toBeUndefined();
    expect(v.x).toMatchObject({ account: true, scopes: ['browser'] });
    expect(v.linear).toMatchObject({ enabled: true, account: true, scopes: ['account'], waiting: true });
    expect(v.reddit).toMatchObject({ enabled: false, account: false });
    expect(v.reddit?.scopes).toBeUndefined();
  });
});
