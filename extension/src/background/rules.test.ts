import { describe, it, expect } from 'vitest';
import { backgroundHosts, beaconTelemetryRegex, buildExtensionPageRule, buildExtensionUntabbedRule, buildRules, buildWorkerOriginRule, normalizeDomains, dnrReasonFor, RULE_ID_BASE, EXTENSION_PAGE_RULE_ID, EXTENSION_UNTABBED_RULE_ID, FAIL_CLOSED_POST_RULE_ID, FAIL_CLOSED_RULE_ID, WORKER_ORIGIN_RULE_ID } from './rules';
import type { Policy } from '../shared/types';
import { defaultPolicy } from './policy';
import { resolveEffective } from './sites';

const base = (): Policy => {
  const p = defaultPolicy();
  p.customSites = [{ id: 'fixture', name: 'fixture', domains: ['localhost', '127.0.0.1'], enabled: true }];
  p.effective = resolveEffective(p);
  return p;
};

describe('normalizeDomains', () => {
  it('strips scheme, port and path, lowercases, dedupes', () => {
    expect(normalizeDomains(['https://App.Example.com:443/x/y', 'app.example.com', ' ', 'API.example.com:8080']))
      .toEqual(['app.example.com', 'api.example.com']);
  });
});

describe('buildRules', () => {
  it('produces no rules when there are no target domains', () => {
    const p = base(); p.effective.targetDomains = [];
    expect(buildRules(p).rules).toEqual([]);
  });

  it('lets a site\'s live-updates PUT through above the mutating-method rule, its exact path on its own domains only', () => {
    expect(buildRules(base()).rules.some((r) => r.action.type === 'allow' && r.condition.requestMethods?.includes('put'))).toBe(false);
    const p = defaultPolicy(); p.sites = { linkedin: { enabled: true } }; p.effective = resolveEffective(p);
    const { rules, reasons } = buildRules(p);
    const allow = rules.filter((r) => reasons.get(r.id)?.startsWith('read-put:'));
    expect(allow).toEqual([expect.objectContaining({ priority: 150, action: { type: 'allow' }, condition: { urlFilter: '||linkedin.com/realtime/realtimeFrontendSubscriptions^', requestMethods: ['put'], resourceTypes: ['xmlhttprequest'] } })]);
    expect(allow[0]!.priority).toBeGreaterThan(rules.find((r) => reasons.get(r.id) === 'mutating-method')!.priority!);
  });

  it('always blocks PUT/PATCH/DELETE on target domains for every resource type', () => {
    const { rules, reasons } = buildRules(base());
    const r = rules.find((x) => reasons.get(x.id) === 'mutating-method');
    expect(r).toBeDefined();
    expect(r!.action.type).toBe('block');
    expect(r!.condition.requestMethods).toEqual(['put', 'patch', 'delete']);
    expect(r!.condition.requestDomains).toEqual(['localhost', '127.0.0.1']);
    expect(r!.condition.resourceTypes).toContain('main_frame');
    expect(r!.condition.resourceTypes).toContain('xmlhttprequest');
  });

  it('blocks POST page loads (main_frame/sub_frame) and nothing else with that rule', () => {
    const { rules, reasons } = buildRules(base());
    const r = rules.find((x) => reasons.get(x.id) === 'post-navigation');
    expect(r).toBeDefined();
    expect(r!.condition.requestMethods).toEqual(['post']);
    expect(r!.condition.resourceTypes).toEqual(['main_frame', 'sub_frame']);
    expect(r!.condition.requestDomains).toEqual(['localhost', '127.0.0.1']);
  });

  it('blocks websocket upgrades only for domains that block them', () => {
    const on = buildRules(base());
    expect([...on.reasons.values()]).toContain('websocket');
    const ws = on.rules.find((x) => on.reasons.get(x.id) === 'websocket');
    expect(ws!.condition.resourceTypes).toEqual(['websocket', 'webtransport']);
    const p = base(); p.websockets = 'allow'; p.effective = resolveEffective(p);
    const off = buildRules(p);
    expect([...off.reasons.values()]).not.toContain('websocket');
  });
  it('refuses beacons to guarded sites: a closing page sends them after the debugger session ended', () => {
    const { rules, reasons } = buildRules(base());
    const r = rules.find((x) => reasons.get(x.id) === 'beacon');
    expect(r!.condition).toMatchObject({ requestMethods: ['post'], resourceTypes: ['ping'] });
    expect(r!.action.type).toBe('block');
  });
  it('lets beacons to a site\'s telemetry addresses through, on its own domains, and refuses every other beacon', () => {
    const p = defaultPolicy(); p.sites = { facebook: { enabled: true } }; p.effective = resolveEffective(p);
    const { rules, reasons } = buildRules(p);
    const allow = rules.find((x) => reasons.get(x.id) === 'beacon-telemetry:/ajax/bnzai');
    expect(allow).toMatchObject({ priority: 101, action: { type: 'allow' }, condition: { requestMethods: ['post'], resourceTypes: ['ping'], requestDomains: ['facebook.com'] } });
    expect(rules.find((x) => reasons.get(x.id) === 'beacon')!.priority).toBeLessThan(allow!.priority ?? 0);
    // The browser rules and their mirror (dnrReasonFor) agree.
    const story = 'https://www.facebook.com/ajax/bnzai?__a=1&__crn=comet.fbweb.CometStoriesSuspenseViewerRoute';
    expect(dnrReasonFor('POST', story, 'ping', p.effective, { tabId: 3 })).toBeNull();
    expect(dnrReasonFor('POST', 'https://www.facebook.com/api/graphql/', 'ping', p.effective, { tabId: 3 })).toBe('beacon');
    expect(dnrReasonFor('POST', 'https://www.facebook.com/ajax/bnzaiX', 'ping', p.effective, { tabId: 3 })).toBe('beacon');
    // Not another site's telemetry address: Facebook's list holds on Facebook alone.
    expect(dnrReasonFor('POST', 'https://www.linkedin.com/ajax/bnzai', 'ping', p.effective, { tabId: 3 })).toBe('beacon');
  });
  it('lets Reddit\'s analytics beacons through (perfMetrics, the browser\'s reports), and refuses its other beacons', () => {
    const p = defaultPolicy(); p.sites = { reddit: { enabled: true } }; p.effective = resolveEffective(p);
    expect(dnrReasonFor('POST', 'https://www.reddit.com/svc/shreddit/perfMetrics', 'ping', p.effective, { tabId: 3 })).toBeNull();
    expect(dnrReasonFor('POST', 'https://w3-reporting.reddit.com/reports', 'ping', p.effective, { tabId: 3 })).toBeNull();
    expect(dnrReasonFor('POST', 'https://www.reddit.com/svc/shreddit/graphql', 'ping', p.effective, { tabId: 3 })).toBe('beacon');
  });
  it('turns a telemetry address into a URL pattern no broader than the exclude-list, or leaves it out', () => {
    const hit = (p: string, u: string) => new RegExp(beaconTelemetryRegex(p)!, 'i').test(u);
    expect(hit('/ajax/bnzai', 'https://www.facebook.com/ajax/bnzai?__a=1')).toBe(true);
    expect(hit('/ajax/bnzai', 'https://www.facebook.com/x/ajax/bnzai')).toBe(false); // the path must start with it
    expect(hit('/to11y*', 'https://www.linkedin.com/to11yAbc')).toBe(true);
    expect(hit('s.linear.app/tunnel', 'https://s.linear.app/tunnel')).toBe(true);
    expect(hit('s.linear.app/tunnel', 'https://evils.linear.app/tunnel')).toBe(false);
    expect(hit('/a.b', 'https://h.example/aXb')).toBe(false);
    expect(hit('/beacon', 'https://h.example/beacon/settings/update')).toBe(false); // it must end the path, as in the list
    expect(hit('/beacon', 'https://h.example/beacon-settings')).toBe(false);
    expect(hit('/beacon', 'https://h.example/beacon/?x=1')).toBe(true);
    expect(hit('/TealeafTarget', 'https://h.example/TealeafTarget.jsp')).toBe(true);
    expect(hit('/analytics', 'https://h.example/api/analytics.delete')).toBe(false); // an RPC verb, not an extension
    expect(beaconTelemetryRegex('re:^www\\.x\\.com/')).toBeUndefined();
    expect(beaconTelemetryRegex('/log?kind=1')).toBeUndefined();
  });

  it('WS block list follows the per-site setting, with the global default for sites that have none', () => {
    const p = base(); // the custom 'fixture' site has no websockets setting → follows the global default
    p.sites = { ...p.sites, gmail: { enabled: true }, linear: { enabled: true } };
    p.websockets = 'block'; p.effective = resolveEffective(p);
    expect(p.effective.websocketBlockDomains).toContain('mail.google.com'); // profile: block
    expect(p.effective.websocketBlockDomains).not.toContain('linear.app');  // profile: allow (sync socket carries updates)
    expect(p.effective.websocketBlockDomains).toContain('localhost');       // custom site: follows global block
    // Global allow drops sites with no setting (the custom one), but a profile that blocks stays blocked.
    p.websockets = 'allow'; p.effective = resolveEffective(p);
    expect(p.effective.websocketBlockDomains).not.toContain('localhost');
    expect(p.effective.websocketBlockDomains).toContain('mail.google.com');
  });

  it('resolves rejectDomains per site: Linear rejects, Gmail falls back to the global default', () => {
    const p = base();
    p.customSites = [];
    p.blockResponse = 'fail';
    p.sites = { ...p.sites, gmail: { enabled: true }, linear: { enabled: true } };
    p.effective = resolveEffective(p);
    expect(p.effective.rejectDomains).toContain('linear.app');       // Linear profile: reject
    expect(p.effective.rejectDomains).not.toContain('mail.google.com'); // Gmail: global default (fail)
  });

  it('resolves editorGuardDomains only for sites that opt in (Linear), not Gmail', () => {
    const p = base();
    p.customSites = [];
    p.sites = { ...p.sites, gmail: { enabled: true }, linear: { enabled: true } };
    p.effective = resolveEffective(p);
    expect(p.effective.editorGuardDomains).toContain('linear.app');
    expect(p.effective.editorGuardDomains).not.toContain('mail.google.com');
  });

  it('adds one GET rule per blocked path', () => {
    const p = base(); p.effective.blockedGetPaths = ['/logout', '/mark-read', ''];
    const { rules, reasons } = buildRules(p);
    const paths = rules.filter((x) => reasons.get(x.id)?.startsWith('blocked-get-path:'));
    expect(paths.map((x) => x.condition.urlFilter)).toEqual(['/logout^', '/mark-read^']);
    for (const x of paths) {
      expect(x.condition.requestMethods).toEqual(['get']);
      // Never a script/stylesheet/image: a chunk named LogoutHelper.js must load.
      expect(x.condition.resourceTypes).not.toContain('script');
      expect(x.condition.resourceTypes).toContain('main_frame');
      expect(x.condition.resourceTypes).toContain('xmlhttprequest');
    }
  });

  it('assigns unique, deterministic ids from RULE_ID_BASE', () => {
    const a = buildRules(base()); const b = buildRules(base());
    const ids = a.rules.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(Math.min(...ids)).toBe(RULE_ID_BASE);
    expect(b.rules.map((r) => r.id)).toEqual(ids);
  });

  it('adds the fail-closed rule only when asked', () => {
    expect(buildRules(base()).rules.some((r) => r.id === FAIL_CLOSED_RULE_ID)).toBe(false);
    const { rules, reasons } = buildRules(base(), { failClosed: true });
    // Two halves: the POSTs, which leave out the background's own, and every other covered method.
    const r = rules.find((x) => x.id === FAIL_CLOSED_RULE_ID);
    const post = rules.find((x) => x.id === FAIL_CLOSED_POST_RULE_ID);
    expect(r?.condition.requestMethods).toEqual(['put', 'patch', 'delete', 'other']);
    expect(post?.condition.requestMethods).toEqual(['post']);
    expect(reasons.get(FAIL_CLOSED_RULE_ID)).toBe('fail-closed:debugger-detached');
    expect(reasons.get(FAIL_CLOSED_POST_RULE_ID)).toBe('fail-closed:debugger-detached');
  });
});

describe('buildWorkerOriginRule', () => {
  it('lets past only the hosts whose workers the debugger holds', () => {
    expect(buildWorkerOriginRule(base())!.condition.excludedInitiatorDomains).toBeUndefined();
    expect(buildWorkerOriginRule(base(), ['www.facebook.com'])!.condition).toMatchObject({ tabIds: [-1], excludedInitiatorDomains: ['www.facebook.com'] });
  });
  it('labels a fenced worker request, but not one from a held worker\'s host, and labels a refused beacon', () => {
    const eff = { blockedGetPaths: [] };
    const u = 'https://www.facebook.com/api/graphql/';
    expect(dnrReasonFor('POST', u, 'xmlhttprequest', eff, { workerOrigin: true, tabId: -1, initiator: 'https://www.facebook.com' })).toBe('worker-origin');
    expect(dnrReasonFor('POST', u, 'xmlhttprequest', eff, { workerOrigin: true, tabId: -1, initiator: 'https://www.facebook.com', workerHosts: ['www.facebook.com'] })).toBeNull();
    expect(dnrReasonFor('POST', u, 'ping', eff, { tabId: 3 })).toBe('beacon');
  });
});

describe('dnrReasonFor (label a webRequest-observed block)', () => {
  const eff = { blockedGetPaths: ['/logout', 'action=RESPOND'] };
  const u = 'https://mail.google.com/x';

  it('labels mutating methods on any type', () => {
    expect(dnrReasonFor('PUT', u, 'xmlhttprequest', eff)).toBe('mutating-method');
    expect(dnrReasonFor('DELETE', u, 'other', eff)).toBe('mutating-method');
  });
  it('labels a POST page load as post-navigation, but a POST xhr as neither', () => {
    expect(dnrReasonFor('POST', u, 'main_frame', eff)).toBe('post-navigation');
    expect(dnrReasonFor('POST', u, 'sub_frame', eff)).toBe('post-navigation');
    expect(dnrReasonFor('POST', u, 'xmlhttprequest', eff)).toBeNull();
  });
  it('labels a blocked GET path only on side-effect types', () => {
    expect(dnrReasonFor('GET', 'https://calendar.google.com/calendar/event?action=RESPOND&x=1', 'main_frame', eff)).toBe('blocked-get-path:action=RESPOND');
    expect(dnrReasonFor('GET', 'https://a.com/logout', 'ping', eff)).toBe('blocked-get-path:/logout');
    expect(dnrReasonFor('GET', 'https://a.com/logout', 'image', eff)).toBeNull(); // a script/image on that path still loads
    expect(dnrReasonFor('GET', 'https://a.com/assets/logoutHelper.js', 'main_frame', eff)).toBeNull(); // boundary-aware
  });
  // Labelled from the socket rule actually built, not from the global flag alone.
  it('labels a websocket only on a host the socket rule refuses', () => {
    const ws = { ...eff, websocketBlockDomains: ['a.com', 'facebook.com'], websocketAllowDomains: ['linear.app'] };
    expect(dnrReasonFor('GET', 'wss://a.com/ws', 'websocket', ws, { websockets: 'block' })).toBe('websocket');
    expect(dnrReasonFor('CONNECT', 'https://gateway.facebook.com/ws/lightspeed', 'webtransport', ws, { websockets: 'block' })).toBe('websocket');
    // Linear allows sockets: a block there is another extension's.
    expect(dnrReasonFor('GET', 'wss://sync.linear.app/ws', 'websocket', ws, { websockets: 'block' })).toBeNull();
    // The global default allows, a site's profile still blocks: OnlyRead's own block is labelled.
    expect(dnrReasonFor('GET', 'wss://a.com/ws', 'websocket', ws, { websockets: 'allow' })).toBe('websocket');
    expect(dnrReasonFor('GET', 'wss://b.com/ws', 'websocket', ws, { websockets: 'allow' })).toBeNull();
    // Everything guarded: every host but the allowed, exempt and socket-allowing ones.
    const all = { ...ws, guardAll: true, excludeDomains: ['ok.example'], exemptDomains: ['pro.example'] };
    expect(dnrReasonFor('GET', 'wss://anything.example/ws', 'websocket', all, { websockets: 'block' })).toBe('websocket');
    expect(dnrReasonFor('GET', 'wss://ok.example/ws', 'websocket', all, { websockets: 'block' })).toBeNull();
    expect(dnrReasonFor('GET', 'wss://sync.linear.app/ws', 'websocket', all, { websockets: 'block' })).toBeNull();
  });
  // A non-standard method is covered where DNR is the only guard.
  it('labels a non-standard method with the cover rule that refused it', () => {
    expect(dnrReasonFor('PROPPATCH', u, 'xmlhttprequest', eff, { failClosed: true })).toBe('fail-closed:debugger-detached');
    expect(dnrReasonFor('MOVE', u, 'xmlhttprequest', eff, { tabId: 7, unguardedTabs: [7] })).toBe('unguarded-tab');
    expect(dnrReasonFor('QUERY', u, 'xmlhttprequest', eff, { workerOrigin: true, tabId: -1 })).toBe('worker-origin');
    expect(dnrReasonFor('HEAD', u, 'xmlhttprequest', eff, { failClosed: true })).toBeNull();
  });
  it('fail-closed outranks the per-method reason for every non-GET', () => {
    expect(dnrReasonFor('POST', u, 'xmlhttprequest', eff, { failClosed: true })).toBe('fail-closed:debugger-detached');
    expect(dnrReasonFor('PUT', u, 'xmlhttprequest', eff, { failClosed: true })).toBe('fail-closed:debugger-detached');
  });
  it('returns null for an ordinary read, so another extension’s block is not misattributed', () => {
    expect(dnrReasonFor('GET', 'https://a.com/api/items', 'xmlhttprequest', eff)).toBeNull();
    expect(dnrReasonFor('POST', 'https://a.com/api/search', 'xmlhttprequest', eff)).toBeNull();
  });
});

describe('worker-origin session rule (requests from no tab)', () => {
  it('blocks non-GET requests with tabId -1 on the guarded domains, all resource types', () => {
    const r = buildWorkerOriginRule(base());
    expect(r?.id).toBe(WORKER_ORIGIN_RULE_ID);
    expect(r?.condition.tabIds).toEqual([-1]);
    expect(r?.condition.requestMethods).toEqual(['post', 'put', 'patch', 'delete', 'other']);
    expect(r?.condition.requestDomains).toEqual(['localhost', '127.0.0.1']);
    expect(r?.condition.resourceTypes).toContain('xmlhttprequest');
  });
  it('is absent with no target domains', () => {
    const p = base(); p.effective.targetDomains = [];
    expect(buildWorkerOriginRule(p)).toBeNull();
  });
  it('is labeled worker-origin only for a non-GET from no tab while the rule is installed', () => {
    const eff = { blockedGetPaths: [] as string[] };
    const u = 'https://www.facebook.com/api/graphql/';
    expect(dnrReasonFor('POST', u, 'xmlhttprequest', eff, { workerOrigin: true, tabId: -1 })).toBe('worker-origin');
    expect(dnrReasonFor('POST', u, 'xmlhttprequest', eff, { workerOrigin: true, tabId: 42 })).toBeNull();
    expect(dnrReasonFor('GET', u, 'xmlhttprequest', eff, { workerOrigin: true, tabId: -1 })).toBeNull();
    expect(dnrReasonFor('POST', u, 'xmlhttprequest', eff, { workerOrigin: false, tabId: -1 })).toBeNull();
    expect(dnrReasonFor('POST', u, 'xmlhttprequest', eff, { workerOrigin: true, tabId: -1, failClosed: true })).toBe('fail-closed:debugger-detached');
  });
});


import { buildUnguardedTabRule, UNGUARDED_TAB_RULE_ID } from './rules';

describe('unguarded-tab session rule', () => {
  it('blocks non-GET requests from exactly those tabs on the guarded domains', () => {
    const r = buildUnguardedTabRule(base(), [7, 9]);
    expect(r?.id).toBe(UNGUARDED_TAB_RULE_ID);
    expect(r?.condition.tabIds).toEqual([7, 9]);
    expect(r?.condition.requestMethods).toEqual(['post', 'put', 'patch', 'delete', 'other']);
    expect(r?.condition.requestDomains).toEqual(['localhost', '127.0.0.1']);
    expect(r?.condition.resourceTypes).toContain('xmlhttprequest');
  });
  it('is absent when every tab is held, or nothing is guarded', () => {
    expect(buildUnguardedTabRule(base(), [])).toBeNull();
    const p = base(); p.effective.targetDomains = [];
    expect(buildUnguardedTabRule(p, [7])).toBeNull();
  });
  it('labels a refused request from such a tab, and only from such a tab', () => {
    const eff = { blockedGetPaths: [] as string[] };
    const u = 'https://linear.app/api';
    expect(dnrReasonFor('POST', u, 'xmlhttprequest', eff, { unguardedTabs: [7], tabId: 7 })).toBe('unguarded-tab');
    expect(dnrReasonFor('POST', u, 'xmlhttprequest', eff, { unguardedTabs: [7], tabId: 8 })).toBeNull();
    expect(dnrReasonFor('GET', u, 'xmlhttprequest', eff, { unguardedTabs: [7], tabId: 7 })).toBeNull();
  });
});

// The background's own requests (POSTs and GETs, no tab) are left out by initiator only where
// such a POST is refused: the worker-origin rule and the fail-closed rule's POST half. Every other rule names no
// initiator, since an extension page shares it: exempting it would let a driven settings page PUT and DELETE on a guarded host.
describe('the extension\'s own requests', () => {
  const withId = <T>(fn: () => T): T => {
    const g = globalThis as { chrome?: unknown };
    const was = g.chrome;
    g.chrome = { runtime: { id: 'onlyreadextid' } };
    try { return fn(); } finally { g.chrome = was; }
  };
  it('are left out by initiator only from the worker-origin rule and the fail-closed POST half', () => withId(() => {
    const p = base();
    const { rules } = buildRules(p, { failClosed: true });
    const own = rules.filter((r) => r.condition.excludedInitiatorDomains?.includes('onlyreadextid')).map((r) => r.id);
    expect(own).toEqual([FAIL_CLOSED_POST_RULE_ID]);
    expect(buildWorkerOriginRule(p, ['localhost'])?.condition.excludedInitiatorDomains).toEqual(['localhost', 'onlyreadextid']);
    expect(buildUnguardedTabRule(p, [3])?.condition.excludedInitiatorDomains).toBeUndefined();
  }));
  it('an extension page in a tab gets a rule of its own: every covered method to a guarded host, the background passing', () => withId(() => {
    const r = buildExtensionPageRule(base());
    expect(r?.id).toBe(EXTENSION_PAGE_RULE_ID);
    expect(r?.condition).toMatchObject({ initiatorDomains: ['onlyreadextid'], excludedTabIds: [-1], requestMethods: ['post', 'put', 'patch', 'delete', 'other'], requestDomains: ['localhost', '127.0.0.1'] });
    const all = { ...base() }; all.effective = { ...all.effective, guardAll: true, excludeDomains: ['ok.example'], exemptDomains: [] };
    expect(buildExtensionPageRule(all)?.condition).toMatchObject({ excludedRequestDomains: ['ok.example'], initiatorDomains: ['onlyreadextid'] });
    expect(dnrReasonFor('PUT', 'http://localhost/api/items/1', 'xmlhttprequest', { blockedGetPaths: [] }, { extensionPage: true, tabId: 4 })).toBe('extension-page');
    expect(dnrReasonFor('POST', 'http://localhost/x', 'xmlhttprequest', { blockedGetPaths: [] }, { extensionPage: true, tabId: -1 })).toBeNull();
  }));
  // The popup has no tab, so the rule above leaves its POSTs to a guarded host alone.
  it('the popup (an extension page in no tab) gets one too, the hosts of the background\'s own requests left out', () => withId(() => {
    const p = base();
    p.devSink = 'http://localhost:4173/sink';
    p.cloud.serviceUrl = 'https://pro.onlyread.ai';
    p.customSites = [{ id: 'mail', name: 'mail', domains: ['mail.example.com', 'openrouter.ai'], enabled: true }];
    p.effective = resolveEffective(p);
    expect(backgroundHosts(p)).toEqual(['ai-gateway.vercel.sh', 'localhost', 'openrouter.ai', 'pro.onlyread.ai']);
    const r = buildExtensionUntabbedRule(p);
    expect(r?.id).toBe(EXTENSION_UNTABBED_RULE_ID);
    expect(r?.condition).toMatchObject({ initiatorDomains: ['onlyreadextid'], tabIds: [-1], requestMethods: ['post', 'put', 'patch', 'delete', 'other'], requestDomains: ['mail.example.com', 'openrouter.ai'] });
    // A guarded judge host stays reachable for the background's judge.
    expect(r?.condition.excludedRequestDomains).toEqual(expect.arrayContaining(['openrouter.ai', 'pro.onlyread.ai', 'localhost']));
    // With everything guarded, the allowed hosts stay left out beside the background's.
    const all = base(); all.effective = { ...all.effective, guardAll: true, excludeDomains: ['ok.example'], exemptDomains: [] };
    expect(buildExtensionUntabbedRule(all)?.condition.excludedRequestDomains).toEqual(expect.arrayContaining(['ok.example', 'openrouter.ai']));
    // Labeled the way the rule matches: the popup's POST to a guarded host is the extension page's; the background's
    // own, to its services, is no rule's; without the hosts nothing in no tab is labeled.
    const opts = { extensionPage: true, tabId: -1, ownHosts: backgroundHosts(p) };
    expect(dnrReasonFor('POST', 'https://mail.example.com/api/send', 'xmlhttprequest', p.effective, opts)).toBe('extension-page');
    expect(dnrReasonFor('POST', 'https://openrouter.ai/api/v1/systemone', 'xmlhttprequest', p.effective, opts)).toBeNull();
    expect(dnrReasonFor('GET', 'https://mail.example.com/inbox', 'xmlhttprequest', p.effective, opts)).toBeNull();
    expect(dnrReasonFor('POST', 'https://mail.example.com/api/send', 'xmlhttprequest', p.effective, { extensionPage: true, tabId: -1 })).toBeNull();
  }));
  it('has no rule without an extension id (outside Chrome)', () => {
    expect(buildExtensionPageRule(base())).toBeNull();
    expect(buildExtensionUntabbedRule(base())).toBeNull();
  });
});
