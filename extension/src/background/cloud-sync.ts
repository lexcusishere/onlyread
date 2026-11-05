// Guarded sites managed from the Pro account. The person keeps a list
// of guarded sites on their account; every browser signed in to the account guards it in addition to its own list (a
// union: `policy.managed`, sites.ts sitesInForce). Sites are added to it on the account page. The account
// page is a normal website, which an agent in this browser could reach and drive, so a change from it is a change like
// any other to the settings lock: one that lowers protection (a site only the account guards switched
// off or removed, management switched off, the account signed out or lapsed) applies only when `lockFor` allows, and
// waits otherwise: for the agent session to end, for the settings PIN; what the same list adds applies meanwhile
// (`raiseMeanwhile`). One that raises protection applies at once. In Pro mode this browser's site changes go to the
// account (local first: kept in `policy.accountEdits`, guarded at once, and sent in order, flushEdits); with an own key
// the extension only reads the lists. The list is fetched with the ETag
// of the last answer (a 304 costs nothing) every half hour while Web Push reaches this browser and every five minutes
// when it does not (managedPollDue), when the popup or the settings page opens, when an agent
// session starts, on Sync now and on sign-in or sign-out; offline, what is in force stays, since it is part of the
// stored policy. The last answer is kept beside its ETag and offered again on a 304, so a list lost locally comes back
// at the next sync.
import type { AccountEdit, GuardAllLevel, ManagedSites, Policy } from '../shared/types';
import { CloudError, type CloudClient, type CloudConfig, type SiteEdit } from './judge/cloud';
import { accountGuards, builtinSite, sitesInForce } from './sites';
import { cloudClient, signInGeneration } from './cloud-session';
import { lastWrittenPolicy, normalizeManaged, normalizePolicy, setPolicy, withManaged } from './policy';
import { lockFor, weakeningChanges, type LockReason } from './protection';
import { outsideWritesSettled } from './owned-storage';
import { S, settingsLock, system } from './state';

/** How often the list is asked for when nothing else asks, measured from the last fetch for any reason. While Web Push
 *  reaches this browser (cloud-push.ts pushActive) a change on the account arrives in seconds, so the poll is only the
 *  net under a push lost: every half hour. Without push it is the way changes arrive: every five minutes. Also how soon
 *  this browser learns that the account page elsewhere signed it out (the service answers `signed_out`), unless a Pro
 *  judge call learns it first. */
export const MANAGED_POLL_PUSH_MS = 30 * 60_000;
export const MANAGED_POLL_MS = 5 * 60_000;
/** How often the background looks whether a poll is due: the intervals above are a minute's precision. */
export const MANAGED_POLL_TICK_MS = 60_000;

/** A change that lowers protection and is waiting for the lock: the list to apply (undefined: the browser's own
 *  settings), what it lowers, and why it waits. A newer fetch replaces it. */
interface Pending { managed: ManagedSites | undefined; changes: string[]; reason: LockReason }
let pending: Pending | undefined;

/** The last answer that went through `offer` (applied, or kept pending): its ETag, sent as If-None-Match, and the list
 *  itself, offered again on a 304 or while the service cannot be reached. With only the ETag kept, a list lost locally (an
 *  outside write between sessions with no PIN, an own settings write that raced the sync's queued change event) or
 *  never stored (the storage write failed) would be answered 304 until the server's version moved or the worker
 *  restarted. Kept for the client and the sign-in it came from, since another account's list can be at the same
 *  version; memory only, so a restarted
 *  worker fetches the whole list once. */
interface Last { client: CloudClient; generation: number; tag: string; managed: ManagedSites | undefined }
let last: Last | undefined;

let whenReady: () => Promise<void> = () => Promise.resolve();
/** index.ts: nothing is compared or written before a startup has read the stored policy. */
export function initManagedSync(opts: { whenReady: () => Promise<void> }): void { whenReady = opts.whenReady; }

/** One sync, edit or apply at a time, in order (like index.ts's policy changes): two could otherwise compare against
 *  the same policy and the second miss what the first lowered. `run` hands the work's failure to its caller as well
 *  (an edit the person is waiting on); `queue` only logs it (a sync nobody waits on). */
let chain: Promise<void> = Promise.resolve();
function run<T>(work: () => Promise<T>): Promise<T> {
  const p = chain.then(async () => { await whenReady(); return work(); });
  chain = p.then(() => undefined, (err: unknown) => system(`managed-sites:error ${err instanceof Error ? err.message : String(err)}`.slice(0, 200)));
  return p;
}
function queue(work: () => Promise<void>): Promise<void> { return run(work).catch(() => undefined); }

/** Which client and sign-in an answer came from. */
interface Source { client: CloudClient; generation: number }
/** An answer from the service: the account's config with its ETag. */
interface Answer { config: CloudConfig; etag?: string }

/** What the account says now: its config (`managed: false` when signed out, lapsed, switched off, or an older server),
 *  with the ETag to keep once applied; or `changed: false` (a 304, or the service unreachable). */
type Fetched = ({ changed: true } & Answer & Source) | { changed: false };

const NONE: CloudConfig = { managed: false, version: 0 };

async function fetchManaged(): Promise<Fetched> {
  const client = cloudClient();
  const generation = signInGeneration();
  if (last && (last.client !== client || last.generation !== generation)) last = undefined; // a new sign-in or service starts over
  const none: Fetched = { changed: true, config: NONE, client, generation };
  if (!(await client.signedIn())) { last = undefined; return none; }
  let r: Awaited<ReturnType<CloudClient['config']>>;
  try {
    r = await client.config(last?.tag);
  } catch (err) {
    // A refused sign-in or a lapsed subscription manages nothing; anything else (offline, a 5xx) keeps the list.
    if (err instanceof CloudError && (err.code === 'not_signed_in' || err.code === 'subscription_inactive')) { last = undefined; return none; }
    system(`managed-sites:unreachable ${err instanceof Error ? err.message : String(err)}`.slice(0, 200));
    return { changed: false };
  }
  if (!r.changed) return { changed: false };
  return { changed: true, config: r.config, etag: r.etag, client, generation };
}

function listOf(c: CloudConfig): ManagedSites | undefined {
  if (!c.managed) return undefined;
  const m = normalizeManaged({ version: c.version, sites: c.sites, customSites: c.customSites, guardAll: c.guardAll, browser: c.browser, browserSites: c.browserSites, browserVersion: c.browserVersion, browsers: c.browsers, fetchedAt: Date.now() });
  if (!m) throw new Error(`managed list v${c.version} is not valid`);
  return m;
}

/** The same list, ignoring when it was fetched. */
function sameList(a: ManagedSites | undefined, b: ManagedSites | undefined): boolean {
  const key = (m: ManagedSites | undefined) => (m ? JSON.stringify([m.version, m.sites, m.customSites, m.guardAll ?? null, m.browser ?? null, m.browserSites ?? null, m.browserVersion ?? null, m.browsers ?? null]) : '');
  return key(a) === key(b);
}

/** Applies `managed` (undefined: the browser's own settings) through the lock, or keeps it as the pending change.
 *  The list is laid over the policy the background last wrote or accepted (policy.ts lastWrittenPolicy), which runs
 *  ahead of the one in force while a change event is queued, so a settings change the person just made is kept.
 *  What the list lowers is judged against both policies, so neither can hide a site the other guards; and only the
 *  list's own effect is named, laid over each in turn: a setting the person changed passed the lock when it was saved,
 *  and an outside write still queued is never the base, so the pending sentence cannot read "turn protection off" for
 *  a change the account never asked for. */
async function offer(managed: ManagedSites | undefined, why: string): Promise<void> {
  const base = lastWrittenPolicy() ?? S.policy;
  const edits = Boolean(!managed && (base.accountEdits?.length || S.policy.accountEdits?.length));
  if (sameList(base.managed, managed) && sameList(S.policy.managed, managed) && !edits) { pending = undefined; return; }
  // A version already in force keeps the time it was first applied.
  const list = managed && base.managed && sameList(base.managed, managed) ? base.managed : managed;
  const next = normalizePolicy(list ? withManaged(base, list) : leftAccount(base));
  const inForce = normalizePolicy(list ? withManaged(S.policy, list) : leftAccount(S.policy));
  const changes = [...new Set([...weakeningChanges(S.policy, inForce), ...weakeningChanges(base, next)])];
  await outsideWritesSettled(); // the PIN the lock reads may be an outside write being put back
  const l = await settingsLock();
  // A lowering from the account is the person's own, made on the account page (an agent's browser's tokens cannot
  // lower the list, the service's TokenScope): it waits for a detected agent session and the PIN, not for the mark
  // that makes an agent's browser refuse its own lowering for good.
  const refusal = lockFor(changes, { agentActive: S.agentSession, pinSet: l.pinSet, pinUnlocked: l.pinUnlocked });
  if (refusal) {
    const was = pendingManaged();
    pending = { managed: list, changes, reason: refusal.reason };
    if (pendingManaged() !== was) system(`managed-sites:deferred(${why}) ${pendingManaged()}`);
    await raiseMeanwhile(list, base, why);
    return;
  }
  pending = undefined;
  await setPolicy(next);
  system(list ? `managed-sites:applied(${why}) v${list.version}` : `managed-sites:off(${why})`);
}

/** The policy once the account's lists are gone (signed out, the plan lapsed, the account deleted or this browser
 *  removed from it): what they guarded, with the additions not yet sent, is copied into this browser's own lists, so
 *  leaving the account guards the same sites or more (PLAN-PRO-UI D14). A removal the account never took is dropped:
 *  that site is guarded again (fail closed). */
function leftAccount(p: Policy): Policy {
  if (!p.managed && !p.accountEdits?.length) return withManaged(p, undefined);
  const { sites, customSites } = sitesInForce({ ...p, accountEdits: p.accountEdits?.filter((e) => e.op === 'add') });
  const { accountEdits: _, ...rest } = withManaged(p, undefined);
  return { ...rest, sites, customSites };
}

/** `next` with everything `inForce` guards that `next` would lower kept as it is: the new list's additions, none of its
 *  lowering. Every level: the account's sites, the sites guarded in this browser alone, and the
 *  two "guard every site" levels, each kept on with no new allowance. */
function keepGuarded(next: ManagedSites, inForce: ManagedSites | undefined): ManagedSites {
  if (!inForce) return next;
  const lists = keepLists(next, inForce);
  const browserSites = inForce.browserSites ? keepLists(next.browserSites ?? { sites: {}, customSites: [] }, inForce.browserSites) : next.browserSites;
  const guardAll = keepLevel(next.guardAll, inForce.guardAll);
  const browser = keepLevel(next.browser, inForce.browser);
  return { ...next, ...lists, ...(browserSites ? { browserSites } : {}), ...(guardAll ? { guardAll } : {}), ...(browser ? { browser } : {}) };
}

type Lists = Pick<ManagedSites, 'sites' | 'customSites'>;
/** `next` with every site `inForce` guards that `next` would switch off, remove or guard fewer domains of kept. */
function keepLists(next: Lists, inForce: Lists): Lists {
  const sites = { ...next.sites };
  for (const [id, s] of Object.entries(inForce.sites)) if (s.enabled && !sites[id]?.enabled) sites[id] = { enabled: true };
  const customSites = [...next.customSites];
  for (const c of inForce.customSites.filter((x) => x.enabled)) {
    const i = customSites.findIndex((x) => x.id === c.id);
    if (i < 0) customSites.push(c);
    else customSites[i] = { ...customSites[i]!, enabled: true, domains: [...new Set([...customSites[i]!.domains, ...c.domains])] };
  }
  return { sites, customSites };
}

/** A "guard every site" level kept on while it is in force, allowing only the hosts both allow: an allowance the new
 *  level adds is a lowering, left to the pending change. */
function keepLevel(next: GuardAllLevel | undefined, inForce: GuardAllLevel | undefined): GuardAllLevel | undefined {
  if (!inForce?.on) return next;
  if (!next?.on) return inForce;
  return { on: true, excludeSites: next.excludeSites.filter((h) => inForce.excludeSites.includes(h)) };
}

/** A refused list's additions applied meanwhile, its lowering left to the pending change: the new list with every site
 *  the lists in force guard kept (raise now, lower later). Were the whole answer to wait, a site the person had just
 *  added to the account on the account page while a lowering was pending would not be guarded in this
 *  browser until the agent session ended, while the settings page said it was. Fail closed: the
 *  interim list is written only when it lowers nothing against either policy, the same two comparisons `offer` makes. */
async function raiseMeanwhile(managed: ManagedSites | undefined, base: Policy, why: string): Promise<void> {
  if (!managed) return; // dropping the list adds nothing
  const interim = keepGuarded(keepGuarded(managed, S.policy.managed), base.managed);
  if (sameList(base.managed, interim) && sameList(S.policy.managed, interim)) return;
  const next = normalizePolicy(withManaged(base, interim));
  if (weakeningChanges(S.policy, normalizePolicy(withManaged(S.policy, interim))).length || weakeningChanges(base, next).length) return;
  await setPolicy(next);
  system(`managed-sites:raised(${why}) v${managed.version}`);
}

/** An answer from the service, a sync's or an edit's, applied through the lock (or kept pending), then kept as the
 *  last answer with its ETag. Only then: a storage write that failed is fetched and tried again rather than answered
 *  304. */
async function offerConfig(a: Answer, from: Source, why: string): Promise<void> {
  const managed = listOf(a.config);
  await offer(managed, why);
  last = a.etag ? { ...from, tag: a.etag, managed } : undefined;
}

/** Fetches the account's list and applies it through the lock. `reason` goes into the system log. */
/** The settings page asks on every open and whenever it is shown again, which can come in bursts (tabs switched back
 *  and forth): one fetch per PAGE_SYNC_MS is enough for it. Everything else (a poll, the popup opening, a sign-in, Sync
 *  now, the account page's ping) always fetches; a 304 costs one indexed read on the service. */
const PAGE_REASONS = new Set(['settings-shown']);
const PAGE_SYNC_MS = 15_000;
let lastSyncAt = 0;

/** Whether the list is due to be asked for by the poll: `pushing`, Web Push reaches this browser. */
export function managedPollDue(pushing: boolean, now = Date.now()): boolean {
  return now - lastSyncAt >= (pushing ? MANAGED_POLL_PUSH_MS : MANAGED_POLL_MS);
}

export function syncManagedSites(reason: string): Promise<void> {
  if (PAGE_REASONS.has(reason) && Date.now() - lastSyncAt < PAGE_SYNC_MS) return Promise.resolve();
  return queue(async () => {
    lastSyncAt = Date.now();
    const r = await fetchManaged();
    if (!r.changed) {
      // A 304, or the service out of reach: the pending change, else the list last answered, is offered again. Free
      // while it is in force (offer compares first); a list lost locally comes back here.
      if (pending) await offer(pending.managed, reason);
      else if (last) await offer(last.managed, reason);
    } else await offerConfig(r, r, reason);
    await moveLocalSites(reason);
    await flushEdits(reason);
  });
}

/** Sends the site changes made here in Pro mode (messages.ts) to the account now. */
export function flushAccountEdits(reason: string): Promise<void> {
  return queue(() => flushEdits(reason));
}

/** How many browsers the account has, from its last answer (one, or not known: a site goes on the account's list). */
export function accountBrowsers(p: Policy = lastWrittenPolicy() ?? S.policy): number {
  return p.managed?.browsers ?? 1;
}

/** The last change the account refused, in words, until a later one is taken (the settings page and popup show it). */
let refusal: string | undefined;
export function accountRefusal(): string | undefined { return refusal; }

/** Why the account would not take an addition, by the service's code (lib/managed.ts ManagedError). */
const ADD_REFUSED: Record<string, string> = {
  'too-many': 'its list is full',
  'public-suffix': 'that address belongs to many sites, not one',
  'not-a-host': 'that is not a site address',
  'covered-by-builtin': 'a verified site already covers it',
  'name-too-long': 'its name is too long',
  'unknown-site': 'the account does not know this site yet',
};

function refusalText(e: AccountEdit, detail: string | undefined): string {
  const name = (e.builtin ? builtinSite(e.id)?.name : e.name) ?? e.id;
  if (e.op === 'remove') {
    return detail === 'conflict'
      ? `Removing ${name} was not kept: your account's sites changed elsewhere in the meantime. ${name} is guarded again; remove it again if you still want to.`
      : `Your Pro account did not remove ${name}${detail ? ` (${detail})` : ''}. It is guarded again.`;
  }
  return `Your Pro account did not take ${name}: ${ADD_REFUSED[detail ?? ''] ?? detail ?? 'refused'}. It is not guarded.`;
}

const editKey = (e: AccountEdit) => `${e.at}|${e.op}|${e.scope}|${e.id}`;

function siteEdit(e: AccountEdit): SiteEdit {
  const target = e.op === 'remove' ? { remove: { id: e.id } } : e.builtin ? { add: { id: e.id } } : { add: { host: e.id, ...(e.name ? { name: e.name } : {}) } };
  return { ...target, scope: e.scope, ...(e.version !== undefined ? { version: e.version } : {}) };
}

/** The changes waiting, oldest first, each sent to the account: taken, the account's answer is applied and the change
 *  dropped (the list now has it); refused (a removal made against a list that has changed since, a site the account
 *  does not take), the change is dropped, which undoes it here; the service out of reach, it waits for the next sync.
 *  Dropping goes through the lock when it would lower protection (an addition the account refused): it waits then. */
async function flushEdits(why: string): Promise<void> {
  for (let n = 0; n < 100; n++) {
    const base = lastWrittenPolicy() ?? S.policy;
    const e = base.accountEdits?.[0];
    if (!e || base.judge.provider !== 'cloud' || !(await sendEdit(e, base, why))) return;
  }
}

/** Sends one waiting change and settles it; false when the rest must wait (out of reach, held by the lock). */
async function sendEdit(e: AccountEdit, base: Policy, why: string): Promise<boolean> {
  const client = cloudClient();
  const generation = signInGeneration();
  if (!(await client.signedIn())) return false;
  let a: Awaited<ReturnType<CloudClient['editSites']>>;
  try {
    a = await client.editSites(siteEdit(e));
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    if (!(err instanceof CloudError && err.code === 'bad_response')) { system(`account-edit:waits ${e.op} ${e.id} ${text}`.slice(0, 200)); return false; }
    if (!(await dropEdit(e))) return false;
    refusal = refusalText(e, err.detail);
    system(`account-edit:refused ${e.op} ${e.scope} ${e.id} ${text}`.slice(0, 200));
    return true;
  }
  refusal = undefined;
  await offerConfig(a, { client, generation }, `edit:${why}`);
  // The list's version moved with this change: later removals made against the version before it follow it (one made
  // against an older one still meets the conflict it should).
  const was = e.scope === 'account' ? base.managed?.version : base.managed?.browserVersion;
  const now = e.scope === 'account' ? a.config.version : a.config.browserVersion;
  if (!(await dropEdit(e, was !== undefined && now !== undefined ? { scope: e.scope, was, now } : undefined))) return false;
  system(`account-edit:sent ${e.op} ${e.scope} ${e.id}`);
  void notifyAccountPages();
  return true;
}

/** The account page open in this browser shows the change at once: the content script there passes the word on
 *  (content/account-nudge.ts). `account-lists-changed`: its Guarded sites asks for the list again;
 *  `this-browser-changed` (a sign-in or sign-out here, messages.ts): its Browsers list asks again which browser this
 *  is. Nothing is sent but that something changed. */
export async function notifyAccountPages(type: 'account-lists-changed' | 'this-browser-changed' = 'account-lists-changed'): Promise<void> {
  const service = S.policy.cloud.serviceUrl.replace(/\/$/, '');
  try {
    const tabs = await chrome.tabs.query({ url: `${service}/account*` });
    for (const t of tabs) if (t.id !== undefined) void chrome.tabs.sendMessage(t.id, { type }).catch(() => {});
  } catch { /* no such tabs, or an address Chrome cannot match: the page's own refresh catches up */ }
}

/** Drops one waiting change; false when that would lower protection and the lock holds it. */
async function dropEdit(e: AccountEdit, rebase?: { scope: AccountEdit['scope']; was: number; now: number }): Promise<boolean> {
  const moved = (x: AccountEdit) => (rebase && x.op === 'remove' && x.scope === rebase.scope && x.version === rebase.was ? { ...x, version: rebase.now } : x);
  const without = (p: Policy) => normalizePolicy({ ...p, accountEdits: (p.accountEdits ?? []).filter((x) => editKey(x) !== editKey(e)).map(moved) });
  const base = lastWrittenPolicy() ?? S.policy;
  const next = without(base);
  // Judged against the policy in force and the one last written, each to what will be in force once this lands: the
  // policy in force may not hold the account's answer yet (its change event still queued), and dropping a change the
  // account has just taken lowers nothing.
  const changes = [...new Set([...weakeningChanges(S.policy, next), ...weakeningChanges(base, next)])];
  if (changes.length) {
    await outsideWritesSettled();
    const l = await settingsLock();
    const refusal = lockFor(changes, { agentActive: S.agentSession, pinSet: l.pinSet, pinUnlocked: l.pinUnlocked });
    if (refusal) { system(`account-edit:held ${e.op} ${e.id} (${refusal.reason})`); return false; }
  }
  await setPolicy(next);
  return true;
}

/** Pro mode guards no sites of this browser's own: the ones it guarded when it signed in (or from an install from
 *  before) go to the account, its own list when it is the account's only browser, else this browser's list there
 *  (PLAN-PRO-UI D16). In one write, as additions waiting to be sent, so nothing is unguarded meanwhile; kept as they are
 *  if moving them would lower anything (a custom site with domains of its own beyond its host). */
async function moveLocalSites(why: string): Promise<void> {
  const base = lastWrittenPolicy() ?? S.policy;
  if (base.judge.provider !== 'cloud' || !base.managed) return;
  const builtins = Object.entries(base.sites).filter(([, s]) => s.enabled).map(([id]) => id);
  if (!builtins.length && !base.customSites.length) return;
  const scope: AccountEdit['scope'] = accountBrowsers(base) <= 1 ? 'account' : 'browser';
  const at = Date.now();
  const edits: AccountEdit[] = [
    ...builtins.filter((id) => !accountGuards(base, id)).map((id): AccountEdit => ({ op: 'add', scope, id, builtin: true, at })),
    ...base.customSites.filter((c) => c.enabled && !accountGuards(base, c.id)).map((c): AccountEdit => ({ op: 'add', scope, id: c.id, builtin: false, name: c.name, at })),
  ];
  const sites = Object.fromEntries(Object.keys(base.sites).map((id) => [id, { enabled: false }]));
  const move = (p: Policy) => normalizePolicy({ ...p, sites: { ...p.sites, ...sites }, customSites: [], accountEdits: [...(p.accountEdits ?? []), ...edits] });
  const next = move(base);
  if (weakeningChanges(base, next).length || weakeningChanges(S.policy, move(S.policy)).length) { system(`local-sites:kept (${why}) moving them would lower protection`); return; }
  await setPolicy(next);
  system(`local-sites:moved (${why}) ${edits.length} to the ${scope} list`);
}

/** The lock may have opened (the agent session ended, the PIN was entered or removed): apply the pending change if
 *  it now may. */
export function applyPendingManaged(reason: string): Promise<void> {
  for (const fn of lockOpenHooks) fn();
  return queue(async () => { if (pending) await offer(pending.managed, reason); });
}
/** Told with applyPendingManaged: other changes the lock held back (messages.ts offWithoutJudge) try again. */
const lockOpenHooks: (() => void)[] = [];
export function whenLockOpens(fn: () => void): void { lockOpenHooks.push(fn); }

/** The change that could not be applied yet, in words, or undefined. */
export function pendingManaged(): string | undefined {
  if (!pending) return undefined;
  const what = pending.changes.join(', ');
  return pending.reason === 'agent'
    ? `Your Pro account asks to ${what}; this applies when the agent session ends`
    : `Your Pro account asks to ${what}; enter your settings PIN to apply it`;
}
