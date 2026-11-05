import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Policy } from '../shared/types';
import { defaultPolicy, normalizePolicy } from './policy';
import { weakeningChanges } from './protection';
import { LINK_FRESH_INSTALL_MS, SETUP_UNDO_MS, isAccountPage, isAgentSetupPage, linkRequest, reloadServicePages, linkRunsByItself, liveRecord, mergeRecords, planAgentSetup, resolveSite, setupRefusals, setupRequest, undoSetup } from './agent-setup';

// A browser set to its own key before the setup (the default is Pro), so the setup's choice of Pro is a change.
const base = (): Policy => normalizePolicy({
  ...defaultPolicy(), enabled: false, mode: 'monitor', attachWhen: 'agent-session', judge: { ...defaultPolicy().judge, provider: 'byok' },
  sites: { linear: { enabled: true } },
  customSites: [{ id: 'old.example.com', name: 'Old', domains: ['old.example.com'], enabled: false }],
});
const req = (sites: string[], more: Partial<{ allTabs: boolean; pro: boolean }> = {}) => setupRequest({ sites, ...more });

describe('isAgentSetupPage', () => {
  it('is the setup page of the service in use only', () => {
    expect(isAgentSetupPage('https://pro.example/agent-setup?sites=gmail', 'https://pro.example')).toBe(true);
    expect(isAgentSetupPage('http://localhost:1/cloud/agent-setup/', 'http://localhost:1/cloud')).toBe(true);
    expect(isAgentSetupPage('https://evil.example/agent-setup', 'https://pro.example')).toBe(false);
    expect(isAgentSetupPage('https://pro.example/account', 'https://pro.example')).toBe(false);
    expect(isAgentSetupPage(undefined, 'https://pro.example')).toBe(false);
  });
});

describe('isAccountPage', () => {
  it('is the service\'s account page or one of its sections, nowhere else', () => {
    expect(isAccountPage('https://pro.example/account', 'https://pro.example')).toBe(true);
    expect(isAccountPage('https://pro.example/account/sites?x=1', 'https://pro.example/')).toBe(true);
    expect(isAccountPage('http://localhost:1/cloud/account', 'http://localhost:1/cloud')).toBe(true);
    expect(isAccountPage('https://pro.example/accounts', 'https://pro.example')).toBe(false);
    expect(isAccountPage('https://evil.example/account', 'https://pro.example')).toBe(false);
    expect(isAccountPage(undefined, 'https://pro.example')).toBe(false);
  });
});

describe('reloadServicePages', () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  it('reloads only the setup and account pages OnlyRead cannot answer, never one whose script is there (an agent mid-setup)', async () => {
    const reloaded: number[] = [];
    vi.stubGlobal('chrome', { tabs: {
      query: async () => [
        { id: 1, url: 'https://pro.example/agent-setup' }, // opened before the install: no script
        { id: 2, url: 'https://pro.example/agent-setup#connect=x' }, // loaded since: its script answers
        { id: 3, url: 'https://pro.example/account' }, // the account page, opened before the install
        { id: 4, url: 'https://pro.example/pricing' }, // another page of the service
        { id: 5, url: 'https://evil.example/account' }, // another site
        { url: 'https://pro.example/agent-setup' }, // no tab id
      ],
      sendMessage: async (id: number) => { if (id !== 2) throw new Error('Could not establish connection. Receiving end does not exist.'); return { title: 'OnlyRead setup' }; },
      reload: async (id: number) => { reloaded.push(id); },
    } });
    await reloadServicePages('https://pro.example');
    expect(reloaded).toEqual([1, 3]);
  });
});

describe('resolveSite', () => {
  it('takes built-ins by id, name or host, other hosts as custom sites, and nothing else', () => {
    expect(resolveSite('Gmail')).toEqual({ builtin: 'gmail' });
    expect(resolveSite('google calendar')).toEqual({ builtin: 'calendar' });
    expect(resolveSite('https://mail.google.com/mail/u/0/')).toEqual({ builtin: 'gmail' });
    expect(resolveSite('https://app.example.org/path')).toEqual({ host: 'app.example.org' });
    expect(resolveSite('co.uk')).toEqual({ unknown: 'co.uk' });
    expect(resolveSite('my bank')).toEqual({ unknown: 'my bank' });
  });
});

describe('planAgentSetup', () => {
  it('only raises protection, and says what it did', () => {
    const plan = planAgentSetup(base(), req(['gmail', 'Linear', 'old.example.com', 'new.example.com', '???'], { allTabs: true, pro: true }), false, 1000);
    expect(plan.added).toEqual(['Gmail', 'Old', 'Example']);
    expect(plan.already).toEqual(['Linear']);
    expect(plan.unknown).toEqual(['???']);
    expect(plan.next).toMatchObject({ enabled: true, mode: 'enforce', attachWhen: 'always', judge: { provider: 'cloud' } });
    expect(plan.record).toMatchObject({ sites: ['gmail'], customAdded: ['new.example.com'], customEnabled: ['old.example.com'], enabled: false, mode: 'monitor', attachWhen: 'agent-session', provider: 'byok' });
    expect(plan.record.summary).toBe('made Gmail, Old, Example read-only, turned protection on, set it to refuse writes, guarded every tab, chose OnlyRead Pro as the AI judge');
    expect(setupRefusals(base(), normalizePolicy(plan.next), plan.record)).toEqual([]);
  });
  it('leaves a judge with a key alone, and the other settings as they are when not asked', () => {
    const plan = planAgentSetup(base(), req(['gmail'], { pro: true }), true);
    expect(plan.next.judge.provider).toBe('byok');
    expect(plan.next.attachWhen).toBe('agent-session');
    expect(plan.record.provider).toBeUndefined();
  });
  it('does not turn protection on with no AI judge to ask (a setup link turns it on as its sign-in ends)', () => {
    const plan = planAgentSetup(base(), req(['gmail']), false, 1000, false);
    expect(plan.next.enabled).toBe(false);
    expect(plan.record.enabled).toBeUndefined();
    expect(plan.record.summary).toBe('made Gmail read-only, set it to refuse writes');
  });
  it('changes nothing when everything asked for is already so', () => {
    const p = normalizePolicy({ ...base(), enabled: true, mode: 'enforce' });
    const plan = planAgentSetup(p, req(['linear', 'LINEAR']), false);
    expect(plan.changed).toBe(false);
    expect(plan.already).toEqual(['Linear', 'Linear']);
  });
  it('counts a site the Pro account guards as already guarded', () => {
    const p = normalizePolicy({ ...base(), managed: { version: 1, fetchedAt: 0, sites: { gmail: { enabled: true } }, customSites: [] } } as Policy);
    expect(planAgentSetup(p, req(['gmail']), false).already).toEqual(['Gmail']);
  });
  it('drops malformed requests and caps the list', () => {
    expect(setupRequest({ sites: ['a.com', 7, '', ' a.com '], allTabs: 'yes', pro: true })).toEqual({ sites: ['a.com'], allTabs: false, pro: true });
    expect(setupRequest({ sites: Array.from({ length: 50 }, (_, i) => `s${i}.example.com`) }).sites).toHaveLength(30);
  });
  it('takes a setup link code only in its exact form, and a code means Pro', () => {
    const code = 'a'.repeat(43);
    expect(setupRequest({ sites: [], connect: code })).toEqual({ sites: [], allTabs: false, pro: true, connect: code });
    expect(setupRequest({ sites: [], connect: 'short' })).toEqual({ sites: [], allTabs: false, pro: false });
    expect(setupRequest({ sites: [], connect: `${'a'.repeat(42)}!` }).connect).toBeUndefined();
  });
});

describe('setupRefusals', () => {
  it('refuses any lowering, and allows the judge change only when Pro is chosen over no key', () => {
    const prev = normalizePolicy({ ...base(), enabled: true, mode: 'enforce' });
    const plan = planAgentSetup(prev, req(['gmail']), false);
    expect(setupRefusals(prev, normalizePolicy({ ...plan.next, mode: 'monitor' }), plan.record)).toEqual(['switch to monitor mode']);
    expect(setupRefusals(prev, normalizePolicy({ ...plan.next, judge: { ...plan.next.judge, provider: 'cloud' } }), plan.record)).toEqual(['change the AI judge']);
  });
});

describe('undoSetup', () => {
  it('puts back exactly what the setup changed', () => {
    const prev = base();
    const plan = planAgentSetup(prev, req(['gmail', 'old.example.com', 'new.example.com'], { allTabs: true, pro: true }), false);
    const undone = normalizePolicy(undoSetup(normalizePolicy(plan.next), plan.record));
    expect(undone.enabled).toBe(false);
    expect(undone.mode).toBe('monitor');
    expect(undone.attachWhen).toBe('agent-session');
    expect(undone.judge.provider).toBe('byok');
    expect(undone.sites.gmail?.enabled).toBe(false);
    expect(undone.sites.linear?.enabled).toBe(true);
    expect(undone.customSites).toEqual(prev.customSites);
    // Undoing lowers protection, so it goes through the settings lock (messages.ts save).
    expect(weakeningChanges(normalizePolicy(plan.next), undone).length).toBeGreaterThan(0);
  });
});

describe('records', () => {
  it('merges two setups within the window, keeping the settings from before the first', () => {
    const first = planAgentSetup(base(), req(['gmail']), false, 1000).record;
    const after = normalizePolicy(planAgentSetup(base(), req(['gmail']), false, 1000).next);
    const second = planAgentSetup(after, req(['x'], { allTabs: true }), false, 2000).record;
    const merged = mergeRecords(first, second, 2000);
    expect(merged).toMatchObject({ sites: ['gmail', 'x'], mode: 'monitor', enabled: false, attachWhen: 'agent-session' });
    expect(mergeRecords(first, second, 1000 + SETUP_UNDO_MS + 1)).toBe(second);
    expect(mergeRecords({ ...first, connected: true }, second, 2000).connected).toBe(true);
    expect(mergeRecords(first, second, 2000).connected).toBeUndefined();
  });
  it('keeps a record for a day only', () => {
    const r = planAgentSetup(base(), req(['gmail']), false, 1000).record;
    expect(liveRecord(r, 1000 + SETUP_UNDO_MS)).toBe(r);
    expect(liveRecord(r, 1001 + SETUP_UNDO_MS)).toBeUndefined();
    expect(liveRecord({ at: 'soon' }, 0)).toBeUndefined();
  });
});

describe('setup links', () => {
  it('run by themselves only within the hour after install', () => {
    expect(linkRunsByItself(1000, 1000 + LINK_FRESH_INSTALL_MS)).toBe(true);
    expect(linkRunsByItself(1000, 1001 + LINK_FRESH_INSTALL_MS)).toBe(false);
    expect(linkRunsByItself(undefined, 1000)).toBe(false); // an install with no recorded time
    expect(linkRunsByItself(5000, 1000)).toBe(false); // a clock that went back
  });
  it('set every tab, enforce and Pro, and no sites of their own', () => {
    const plan = planAgentSetup(base(), linkRequest('a'.repeat(43)), false);
    expect(plan.next).toMatchObject({ enabled: true, mode: 'enforce', attachWhen: 'always', judge: { provider: 'cloud' } });
    expect(plan.added).toEqual([]);
  });
});
