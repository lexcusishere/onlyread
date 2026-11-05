import { describe, expect, it, vi } from 'vitest';
import type { Policy } from '../shared/types';

vi.mock('./audit', () => ({ record: async () => {}, clearBadge: () => {} }));
vi.mock('./sink', () => ({ send: () => {} }));
const { broadcastEditorGuard, closesAttachGap, guardConfig, scopeFor } = await import('./guard');
const { S } = await import('./state');
const { defaultPolicy, normalizePolicy } = await import('./policy');

const policy = (patch: Partial<Policy> = {}): Policy => normalizePolicy({
  ...defaultPolicy(), enabled: true, attachWhen: 'always', mode: 'enforce',
  customSites: [{ id: 'app.example.com', name: 'App', domains: ['app.example.com'], enabled: true }], ...patch,
});
const nothing = { guarded: false, editorGuard: false, holdClose: false, uploadsOff: false };

// What the content script does on a host comes from here, per host and per state.
describe('guardConfig', () => {
  it('reports, holds the close handlers and disables uploads on a guarded site while enforcing', () => {
    S.policy = policy(); S.agentSession = false;
    expect(guardConfig('app.example.com')).toEqual({ guarded: true, editorGuard: false, holdClose: true, uploadsOff: true });
    expect(guardConfig('sub.app.example.com').guarded).toBe(true);
  });
  it('reports but refuses nothing in monitor mode: file inputs stay usable, close handlers run', () => {
    S.policy = policy({ mode: 'monitor' });
    expect(guardConfig('app.example.com')).toEqual({ guarded: true, editorGuard: false, holdClose: false, uploadsOff: false });
  });
  it('does nothing on a site that is not guarded, while protection is off, or while dormant between agent sessions', () => {
    S.policy = policy();
    expect(guardConfig('news.example.org')).toEqual(nothing);
    S.policy = policy({ enabled: false });
    expect(guardConfig('app.example.com')).toEqual(nothing);
    S.policy = policy({ attachWhen: 'agent-session' }); S.agentSession = false;
    expect(guardConfig('app.example.com')).toEqual(nothing);
    S.agentSession = true;
    expect(guardConfig('app.example.com').guarded).toBe(true);
    S.agentSession = false;
  });
  it('leaves file inputs alone when the policy allows uploads', () => {
    S.policy = policy({ uploads: true });
    expect(guardConfig('app.example.com')).toMatchObject({ guarded: true, uploadsOff: false });
  });
});

describe('scopeFor', () => {
  it('holds every web tab under all-tabs, only the guarded sites\' own under target-tabs, never other schemes', () => {
    const all = scopeFor(policy({ attachScope: 'all-tabs' }));
    expect(all('https://news.example.org/')).toBe(true);
    expect(all('chrome://extensions')).toBe(false);
    const own = scopeFor(policy({ attachScope: 'target-tabs' }));
    expect(own('https://app.example.com/x')).toBe(true);
    expect(own('https://news.example.org/')).toBe(false);
    expect(own('not a url')).toBe(false);
  });
});

// A policy change that attaches afresh closes the gap with the fail-closed rule.
describe('closesAttachGap', () => {
  it('closes it when attachment turns on in enforce, the scope widens, or a domain is newly guarded under target-tabs', () => {
    const p = policy();
    expect(closesAttachGap(p, p, false, true)).toBe(true);
    expect(closesAttachGap(p, policy({ mode: 'monitor' }), false, true)).toBe(false); // monitor refuses nothing
    expect(closesAttachGap(p, p, true, false)).toBe(false); // detaching
    expect(closesAttachGap(p, p, true, true)).toBe(false); // nothing attached afresh
    const narrow = policy({ attachScope: 'target-tabs' });
    expect(closesAttachGap(narrow, p, true, true)).toBe(true); // all-tabs now
    const more = policy({ attachScope: 'target-tabs', customSites: [{ id: 'app.example.com', name: 'App', domains: ['app.example.com'], enabled: true }, { id: 'b.example.com', name: 'B', domains: ['b.example.com'], enabled: true }] });
    expect(closesAttachGap(narrow, more, true, true)).toBe(true);
    expect(closesAttachGap(narrow, policy({ attachScope: 'target-tabs', guardAll: true }), true, true)).toBe(true);
    expect(closesAttachGap(more, narrow, true, true)).toBe(false); // fewer sites: no new tab to hold
  });
  // With everything guarded, a host leaving the allowed (or exempt) list is newly guarded.
  it('closes it when, with everything guarded under target-tabs, a host is no longer allowed or exempt', () => {
    const allowing = policy({ attachScope: 'target-tabs', guardAll: true, excludeSites: ['news.example.org'] });
    const strict = policy({ attachScope: 'target-tabs', guardAll: true });
    expect(closesAttachGap(allowing, strict, true, true)).toBe(true);
    expect(closesAttachGap(strict, allowing, true, true)).toBe(false); // a host allowed: nothing newly guarded
    const exempting = { ...strict, effective: { ...strict.effective, exemptDomains: ['pro.example'] } };
    const notExempt = { ...strict, effective: { ...strict.effective, exemptDomains: [] } };
    expect(closesAttachGap(exempting, notExempt, true, true)).toBe(true);
  });
});

// Each frame is pushed the answer for its own host.
describe('broadcastEditorGuard', () => {
  it('sends every web frame its own answer, by frame id', async () => {
    S.policy = policy(); S.agentSession = false;
    const sent: [number, { guarded?: boolean }, { frameId?: number }][] = [];
    vi.stubGlobal('chrome', {
      tabs: {
        query: async () => [{ id: 5, url: 'https://news.example.org/' }],
        sendMessage: async (id: number, msg: { guarded?: boolean }, opts: { frameId?: number }) => { sent.push([id, msg, opts]); },
      },
      webNavigation: { getAllFrames: async () => [{ frameId: 0, url: 'https://news.example.org/' }, { frameId: 3, url: 'https://app.example.com/embed' }, { frameId: 4, url: 'about:blank' }] },
    });
    await broadcastEditorGuard();
    expect(sent.map(([id, m, o]) => [id, m.guarded, o.frameId])).toEqual([[5, false, 0], [5, true, 3]]);
    vi.unstubAllGlobals();
  });
});
