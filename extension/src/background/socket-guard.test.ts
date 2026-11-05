import { describe, expect, it } from 'vitest';
import type { Policy } from '../shared/types';
import { defaultPolicy } from './policy';
import { buildRules, buildSocketGuardRule, dnrReasonFor, SOCKET_GUARD_RULE_ID } from './rules';
import { resolveEffective } from './sites';
import { BINDING, guardConfig, guardedSocketHost, guardExpression, parseReport } from './socket-guard';

const withWhatsApp = (tweak: (p: Policy) => void = () => {}): Policy => {
  const p = defaultPolicy();
  p.enabled = true;
  p.sites = { whatsapp: { enabled: true } };
  tweak(p);
  p.effective = resolveEffective(p);
  return p;
};

describe('the WhatsApp profile', () => {
  it('guards its socket stanza by stanza and blocks it by rule until a tab is armed', () => {
    const p = withWhatsApp();
    expect(p.effective.socketGuardDomains).toEqual(['web.whatsapp.com']);
    expect(p.effective.websocketBlockDomains).toContain('web.whatsapp.com');
    const ws = buildRules(p).rules.find((r) => r.condition.resourceTypes?.includes('websocket'));
    expect(ws?.action.type).toBe('block');
    expect(dnrReasonFor('GET', 'wss://web.whatsapp.com/ws/chat', 'websocket', p.effective)).toBe('websocket');
  });

  it('is not guarded when switched off', () => {
    const p = withWhatsApp((x) => { x.sites = { whatsapp: { enabled: false } }; });
    expect(p.effective.socketGuardDomains).toEqual([]);
    expect(guardedSocketHost('https://web.whatsapp.com/', p)).toBe(false);
  });
});

describe('buildSocketGuardRule', () => {
  it('allows the site’s sockets in the armed tabs only, above the socket block', () => {
    const r = buildSocketGuardRule(['web.whatsapp.com'], [12, 3]);
    expect(r).toMatchObject({ id: SOCKET_GUARD_RULE_ID, priority: 200, action: { type: 'allow' } });
    expect(r!.condition).toEqual({ requestDomains: ['web.whatsapp.com'], resourceTypes: ['websocket'], tabIds: [3, 12] });
  });

  it('is none without an armed tab or a guarded domain', () => {
    expect(buildSocketGuardRule(['web.whatsapp.com'], [])).toBeNull();
    expect(buildSocketGuardRule([], [1])).toBeNull();
  });
});

describe('guardConfig', () => {
  it('lets read-tracking shapes through only with that setting on', () => {
    expect(guardConfig('whatsapp', withWhatsApp((p) => { p.allowReadTracking = false; })).allow).toEqual([]);
    const on = guardConfig('whatsapp', withWhatsApp((p) => { p.allowReadTracking = true; }));
    expect(on.allow).toContain('whatsapp:receipt:w[read]');
    expect(on.allow).toContain('whatsapp:chatstate:w[composing]');
    expect(on).toMatchObject({ mode: 'enforce', hosts: ['web.whatsapp.com'], binding: BINDING });
  });

  it('carries the mode', () => {
    expect(guardConfig('whatsapp', withWhatsApp((p) => { p.mode = 'monitor'; })).mode).toBe('monitor');
  });
});

describe('guardedSocketHost', () => {
  it('knows the site’s page and its blob: workers', () => {
    const p = withWhatsApp();
    expect(guardedSocketHost('https://web.whatsapp.com/', p)).toBe(true);
    expect(guardedSocketHost('blob:https://web.whatsapp.com/1f2e', p)).toBe(true);
    expect(guardedSocketHost('https://www.whatsapp.com/', p)).toBe(false);
  });
});

describe('parseReport', () => {
  it('takes the guard’s reports and nothing else', () => {
    expect(parseReport(BINDING, '{"shape":"whatsapp:message:w[text]","enforced":true}')).toEqual({ shape: 'whatsapp:message:w[text]', enforced: true });
    expect(parseReport('other', '{"shape":"whatsapp:message:w[text]"}')).toBeUndefined();
    expect(parseReport(BINDING, '{"shape":"<img src=x>"}')).toBeUndefined();
    expect(parseReport(BINDING, 'not json')).toBeUndefined();
  });
});

describe('guardExpression', () => {
  it('hands the guard its configuration as a parameter, not a page global', () => {
    const expr = guardExpression('report(orSocketConfig.mode)', guardConfig('whatsapp', withWhatsApp()));
    expect(expr.startsWith('(function (orSocketConfig) {')).toBe(true);
    expect(expr).toContain('"mode":"enforce"');
  });
});

describe('arming a tab', () => {
  it('turns the Page domain on before registering the script, checks the guard is in the page, and only then arms', async () => {
    const { onTabHeld, armedTabs, onTabReleased } = await import('./socket-guard');
    const { S } = await import('./state');
    const before = S.policy;
    S.policy = withWhatsApp();
    const calls: string[] = [];
    let inPage = true;
    const send = async (_t: unknown, method: string, params?: { expression?: string }) => {
      calls.push(method);
      if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: '1' };
      if (method === 'Runtime.evaluate') return { result: { value: params?.expression?.startsWith('typeof') ? inPage : undefined } };
      return {};
    };
    const stubs = installChromeStubs();
    try {
      await onTabHeld(7, 'https://web.whatsapp.com/', send, () => {});
      expect(calls.indexOf('Page.enable')).toBeGreaterThanOrEqual(0);
      expect(calls.indexOf('Page.enable')).toBeLessThan(calls.indexOf('Page.addScriptToEvaluateOnNewDocument'));
      expect(armedTabs()).toContain(7);
      onTabReleased(7, () => {});
      // The guard is not in the page after injection: the tab stays unarmed, its socket refused.
      inPage = false;
      await onTabHeld(8, 'https://web.whatsapp.com/', send, () => {});
      expect(armedTabs()).not.toContain(8);
    } finally { stubs(); S.policy = before; }
  });
});

describe('Telegram\'s HTTP channel', () => {
  it('goes through checked once the guard is in every worker; refused, apart from other refusals, while one is still getting it', async () => {
    const { onTabHeld, onTabReleased, workerStarting, guardedChannel, guardStarting } = await import('./socket-guard');
    const { S } = await import('./state');
    const before = S.policy;
    S.policy = withWhatsApp((p) => { p.sites = { telegram: { enabled: true } }; });
    const send = async (_t: unknown, method: string, params?: { expression?: string }) => {
      if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: '1' };
      if (method === 'Runtime.evaluate') return { result: { value: params?.expression?.startsWith('typeof') ? true : undefined } };
      return {};
    };
    const stubs = installChromeStubs();
    const post = { tabId: 9, method: 'POST', url: 'https://venus.web.telegram.org/apiw1', path: '/apiw1' };
    try {
      await onTabHeld(9, 'https://web.telegram.org/k/', send, () => {});
      expect([guardedChannel(post), guardStarting(post)]).toEqual([true, false]);
      await workerStarting(9, 's1', 'https://web.telegram.org/k/index.worker.js', send);
      expect([guardedChannel(post), guardStarting(post)]).toEqual([false, true]);
      // Not the channel: another path, a GET, another tab.
      expect(guardStarting({ ...post, path: '/other' })).toBe(false);
      expect(guardStarting({ ...post, method: 'GET' })).toBe(false);
      expect(guardStarting({ ...post, tabId: 10 })).toBe(false);
      onTabReleased(9, () => {});
      expect([guardedChannel(post), guardStarting(post)]).toEqual([false, false]);
    } finally { stubs(); S.policy = before; }
  });
});

describe('switching a guarded site off', () => {
  it('reloads the tabs that carried the guard on that site, and no others', async () => {
    const { tabsToReloadOnGuardOff } = await import('./socket-guard');
    const both = withWhatsApp((p) => { p.sites = { telegram: { enabled: true }, whatsapp: { enabled: true } }; });
    const tgOff = withWhatsApp();
    const off = { ...both, enabled: false };
    const tabs = [{ id: 1, url: 'https://web.telegram.org/k/' }, { id: 2, url: 'https://web.whatsapp.com/' }, { id: 3, url: 'https://example.com/' }, { id: 4 }];
    expect(tabsToReloadOnGuardOff(both, tgOff, tabs)).toEqual([1]);
    expect(tabsToReloadOnGuardOff(both, off, tabs)).toEqual([1, 2]);
    expect(tabsToReloadOnGuardOff(both, both, tabs)).toEqual([]);
    expect(tabsToReloadOnGuardOff(tgOff, both, tabs)).toEqual([]); // switched on: the sweep's business, not this
  });
});

/** chrome.* as the arming path uses it: the hook file, the session rule and the policy in force. */
function installChromeStubs(): () => void {
  const g = globalThis as Record<string, unknown>;
  const prev = { chrome: g.chrome, fetch: g.fetch };
  g.chrome = {
    runtime: { getURL: (p: string) => `chrome-extension://x/${p}` },
    declarativeNetRequest: { getSessionRules: async () => [], updateSessionRules: async () => {} },
  };
  g.fetch = async () => new Response('/* guard */');
  return () => { g.chrome = prev.chrome; g.fetch = prev.fetch; };
}
