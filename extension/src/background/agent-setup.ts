// Setup by an AI agent, from OnlyRead Pro's agent-setup page. The person pastes the page's link into
// their agent's chat; the agent fills in the page's form (the sites to make read-only, whether to guard every tab,
// whether to use Pro) and presses its button. The content script passes the press on only when the browser marks
// the click trusted (content/agent-setup.ts), so a page that merely opens the link changes nothing, and the
// background takes it only from that page of the service this browser uses, top frame (messages.ts).
//
// Setup only raises protection: it switches sites on, turns protection on, refuses writes (enforce), and on request
// guards every tab and chooses Pro as the judge where no own key is set (from a judge with no key, that adds a
// judge). Anything that would lower protection is refused. What it changed is kept for a day, so the person can
// undo exactly that from the settings page, through the settings lock like any other lowering.
import type { CustomSite, Policy } from '../shared/types';
import { nameFromHost } from '../shared/names';
import { BUILTIN_SITES, builtinForHost, builtinSite, hostToSiteId, isPublicSuffix, sitesInForce, validHost } from './sites';
import { weakeningChanges } from './protection';
import { AGENT_SETUP_PATH, MAX_SETUP_SITES, SETUP_LINK_CODE } from '../shared/agent-setup';

/** How long the settings page offers to undo a setup. */
export const SETUP_UNDO_MS = 24 * 60 * 60_000;
export const SETUP_KEY = 'agentSetup';
/** When OnlyRead was installed in this browser (index.ts onInstalled), for linkRunsByItself. */
export const INSTALLED_KEY = 'installedAt';
/** A setup link connects by itself, with no click, only this soon after install: the agent that installed OnlyRead
 *  for its person then reloads the page. Later, a page could send a browser that uses OnlyRead without Pro to a
 *  link someone else made and connect it unseen, so the page then asks for one real click. */
export const LINK_FRESH_INSTALL_MS = 60 * 60_000;

/** Reloads the open pages of the service in use that need OnlyRead and cannot reach it (on install: a page opened
 *  before it has no content script, and Chrome adds none to an open tab): the agent-setup page, which goes on by
 *  itself, and the account page, whose Browsers list asks which browser this is (its "Add OnlyRead to this browser"
 *  went away only on a reload). Only those pages: isAgentSetupPage and isAccountPage check each tab's address. A page
 *  that already has the script is left as it is: it answers the popup's `site:meta` (content actions.ts), which needs
 *  no permission to ask. That is a page loaded after the install while the background was still starting, where the
 *  agent may be partway through the setup: a reload there cut the name it was typing. */
export async function reloadServicePages(serviceUrl: string): Promise<void> {
  const tabs = await chrome.tabs.query({});
  for (const t of tabs) {
    if (t.id === undefined || !(isAgentSetupPage(t.url, serviceUrl) || isAccountPage(t.url, serviceUrl))) continue;
    const answers = await chrome.tabs.sendMessage(t.id, { type: 'site:meta' }).then(() => true, () => false);
    if (!answers) await chrome.tabs.reload(t.id).catch(() => {});
  }
}

export function linkRunsByItself(installedAt: unknown, now = Date.now()): boolean {
  return typeof installedAt === 'number' && now - installedAt >= 0 && now - installedAt <= LINK_FRESH_INSTALL_MS;
}

/** What a setup link sets: every tab guarded, writes refused, Pro as the judge; the sites are the account's. */
export function linkRequest(connect: string): SetupRequest {
  return { sites: [], allTabs: true, pro: true, connect };
}

/** Whether `url` is the agent-setup page of the service this browser uses. */
export function isAgentSetupPage(url: string | undefined, serviceUrl: string): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    const page = new URL(`${serviceUrl.replace(/\/$/, '')}${AGENT_SETUP_PATH}`);
    return u.origin === page.origin && u.pathname.replace(/\/$/, '') === page.pathname;
  } catch { return false; }
}

/** Whether `url` is a page of the Pro account (its sections live under /account) of the service this browser uses. */
export function isAccountPage(url: string | undefined, serviceUrl: string): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    const page = new URL(`${serviceUrl.replace(/\/$/, '')}/account`);
    const path = u.pathname.replace(/\/$/, '');
    return u.origin === page.origin && (path === page.pathname || path.startsWith(`${page.pathname}/`));
  } catch { return false; }
}

/** `connect`: a setup link's one-time code (the page's address carried it), which signs this browser in to the Pro
 *  account that made the link; it implies Pro. */
export interface SetupRequest { sites: string[]; allTabs: boolean; pro: boolean; connect?: string }

/** The request as the content script sent it, with anything malformed dropped. */
export function setupRequest(msg: { sites?: unknown; allTabs?: unknown; pro?: unknown; connect?: unknown }): SetupRequest {
  const sites = Array.isArray(msg.sites) ? msg.sites.filter((s): s is string => typeof s === 'string' && s.trim().length > 0 && s.length <= 255) : [];
  const connect = typeof msg.connect === 'string' && SETUP_LINK_CODE.test(msg.connect) ? msg.connect : undefined;
  return {
    sites: [...new Set(sites.map((s) => s.trim()))].slice(0, MAX_SETUP_SITES),
    allTabs: msg.allTabs === true,
    pro: msg.pro === true || connect !== undefined,
    ...(connect ? { connect } : {}),
  };
}

/** What a setup changed, kept so it can be undone: the sites it switched on or added, and each setting's earlier value. */
export interface SetupRecord {
  at: number;
  /** Built-in sites switched on in this browser's list. */
  sites: string[];
  /** Custom sites added to this browser's list. */
  customAdded: string[];
  /** Custom sites already in this browser's list, switched on. */
  customEnabled: string[];
  enabled?: boolean;
  mode?: Policy['mode'];
  attachWhen?: Policy['attachWhen'];
  provider?: Policy['judge']['provider'];
  /** It signed this browser in to Pro with a setup link; Undo signs it out. */
  connected?: boolean;
  /** What it did, in words, for the settings page. */
  summary: string;
}

type Resolved = { builtin: string } | { host: string } | { unknown: string };

/** A site as the agent wrote it: a built-in's id or name ("gmail", "Google Calendar"), or a host or address. */
export function resolveSite(token: string): Resolved {
  const t = token.trim();
  const lower = t.toLowerCase();
  const named = builtinSite(lower) ?? BUILTIN_SITES.find((s) => s.name.toLowerCase() === lower);
  if (named) return { builtin: named.id };
  const id = hostToSiteId(t);
  if (!validHost(id) || isPublicSuffix(id) || !id.includes('.')) return { unknown: t };
  const verified = builtinForHost(id);
  return verified ? { builtin: verified.id } : { host: id };
}

interface SetupPlan { next: Policy; record: SetupRecord; added: string[]; already: string[]; unknown: string[]; changed: boolean }

interface Draft { next: Policy; record: SetupRecord; added: string[]; already: string[]; unknown: string[] }

function addBuiltin(d: Draft, prev: Policy, id: string): void {
  const name = builtinSite(id)?.name ?? id;
  if (sitesInForce(prev).sites[id]?.enabled || d.record.sites.includes(id)) { if (!d.added.includes(name)) d.already.push(name); return; }
  d.next = { ...d.next, sites: { ...d.next.sites, [id]: { ...d.next.sites[id], enabled: true } } };
  d.record.sites.push(id);
  d.added.push(name);
}

function addHost(d: Draft, prev: Policy, id: string): void {
  const inForce = sitesInForce(prev).customSites.find((c) => c.id === id);
  if (inForce?.enabled || d.record.customAdded.includes(id) || d.record.customEnabled.includes(id)) { d.already.push(inForce?.name ?? id); return; }
  const own = d.next.customSites.find((c) => c.id === id);
  if (own) {
    d.next = { ...d.next, customSites: d.next.customSites.map((c) => (c.id === id ? { ...c, enabled: true } : c)) };
    d.record.customEnabled.push(id);
    d.added.push(own.name);
    return;
  }
  const site: CustomSite = { id, name: nameFromHost(id), domains: [id], enabled: true };
  d.next = { ...d.next, customSites: [...d.next.customSites, site] };
  d.record.customAdded.push(id);
  d.added.push(site.name);
}

/** The settings that only go up: protection on, enforce, and on request every tab and Pro. Protection goes on only with
 *  an AI judge (`hasJudge`): without one it could not stay on (messages.ts offWithoutJudge). */
function raiseSettings(d: Draft, prev: Policy, req: SetupRequest, hasOwnKey: boolean, hasJudge: boolean): string[] {
  const did: string[] = [];
  if (!prev.enabled && hasJudge) { d.record.enabled = prev.enabled; d.next = { ...d.next, enabled: true }; did.push('turned protection on'); }
  if (prev.mode !== 'enforce') { d.record.mode = prev.mode; d.next = { ...d.next, mode: 'enforce' }; did.push('set it to refuse writes'); }
  if (req.allTabs && prev.attachWhen !== 'always') { d.record.attachWhen = prev.attachWhen; d.next = { ...d.next, attachWhen: 'always' }; did.push('guarded every tab'); }
  if (req.pro && prev.judge.provider !== 'cloud' && !hasOwnKey) {
    d.record.provider = prev.judge.provider;
    d.next = { ...d.next, judge: { ...d.next.judge, provider: 'cloud' } };
    did.push('chose OnlyRead Pro as the AI judge');
  }
  return did;
}

/** The policy after the setup, and what it changed. `hasOwnKey`: an own-key judge has a key, so Pro is not chosen
 *  over it (that would replace a working judge, which only the person may do). */
export function planAgentSetup(prev: Policy, req: SetupRequest, hasOwnKey: boolean, now = Date.now(), hasJudge = true): SetupPlan {
  const d: Draft = { next: prev, record: { at: now, sites: [], customAdded: [], customEnabled: [], summary: '' }, added: [], already: [], unknown: [] };
  for (const token of req.sites) {
    const r = resolveSite(token);
    if ('builtin' in r) addBuiltin(d, prev, r.builtin);
    else if ('host' in r) addHost(d, prev, r.host);
    else d.unknown.push(r.unknown);
  }
  const did = raiseSettings(d, prev, req, hasOwnKey, hasJudge);
  if (d.added.length) did.unshift(`made ${d.added.join(', ')} read-only`);
  d.record.summary = did.join(', ');
  return { ...d, changed: did.length > 0 };
}

/** What the planned policy would lower, which must be nothing. Choosing Pro in place of a judge with no key is the one
 *  judge change a setup makes, and it adds a judge rather than replacing one. */
export function setupRefusals(prev: Policy, next: Policy, record: SetupRecord): string[] {
  return weakeningChanges(prev, next).filter((c) => !(record.provider && c === 'change the AI judge'));
}

/** Two setups within the undo window undo together: the sites of both, each setting's value from before the first. */
export function mergeRecords(old: SetupRecord | undefined, add: SetupRecord, now = Date.now()): SetupRecord {
  if (!old || now - old.at > SETUP_UNDO_MS) return add;
  const union = (a: string[], b: string[]) => [...new Set([...a, ...b])];
  return {
    at: add.at,
    sites: union(old.sites, add.sites),
    customAdded: union(old.customAdded, add.customAdded),
    customEnabled: union(old.customEnabled, add.customEnabled),
    enabled: old.enabled ?? add.enabled,
    mode: old.mode ?? add.mode,
    attachWhen: old.attachWhen ?? add.attachWhen,
    provider: old.provider ?? add.provider,
    ...(old.connected || add.connected ? { connected: true } : {}),
    summary: [old.summary, add.summary].filter(Boolean).join('; '),
  };
}

/** `p` with what the setup changed put back. Only those changes: a site switched on later by other means stays as
 *  the person left it unless the setup switched it on. */
export function undoSetup(p: Policy, r: SetupRecord): Policy {
  const sites = { ...p.sites };
  for (const id of r.sites) sites[id] = { ...sites[id], enabled: false };
  const customSites = p.customSites
    .filter((c) => !r.customAdded.includes(c.id))
    .map((c) => (r.customEnabled.includes(c.id) ? { ...c, enabled: false } : c));
  return {
    ...p,
    sites,
    customSites,
    ...(r.enabled !== undefined ? { enabled: r.enabled } : {}),
    ...(r.mode ? { mode: r.mode } : {}),
    ...(r.attachWhen ? { attachWhen: r.attachWhen } : {}),
    ...(r.provider ? { judge: { ...p.judge, provider: r.provider } } : {}),
  };
}

/** The kept record, if it is still within the undo window. */
export function liveRecord(raw: unknown, now = Date.now()): SetupRecord | undefined {
  const r = raw as SetupRecord | undefined;
  if (!r || typeof r.at !== 'number' || !Array.isArray(r.sites) || now - r.at > SETUP_UNDO_MS) return undefined;
  return r;
}
