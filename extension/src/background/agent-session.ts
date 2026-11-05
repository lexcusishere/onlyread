// attachWhen='agent-session': OnlyRead stays dormant until an agent session starts (a tab another debugger
// holds, or one the harness declares), attaches for the session, and detaches when it ends.
import { AGENT_POLL_MS, idleAgentTabs, nextAgentTabs, probeDue } from './agent-detect';
import * as dbg from './debugger';
import { refreshAccountLock } from './account-lock';
import { broadcastEditorGuard, holdGuardedTabs, refreshRules, unguarded } from './guard';
import { S, attachmentOn, system } from './state';
import { applyPendingManaged, syncManagedSites } from './cloud-sync';
import { armedTabs } from './socket-guard';

let agentPoll: ReturnType<typeof setInterval> | undefined;

/** When an agent was last seen on each agent tab (agent-detect.ts AGENT_IDLE_MS), kept with the session. */
let seen = new Map<number, number>();
/** When each agent tab OnlyRead holds was last looked at (agent-detect.ts probeDue). */
const lastProbe = new Map<number, number>();
/** The agent tabs OnlyRead holds whose last look found no agent: only these can go idle (between looks, the report
 *  cannot say whether an agent is on a tab OnlyRead holds). */
const foundGone = new Set<number>();

export async function readAgentSession(): Promise<void> {
  try {
    const r = await chrome.storage.session.get(['declaredSession', 'agentTabs', 'agentSeen']);
    S.declaredSession = Boolean(r.declaredSession);
    S.agentTabs = new Set(Array.isArray(r.agentTabs) ? (r.agentTabs as number[]) : []);
    seen = new Map(Array.isArray(r.agentSeen) ? (r.agentSeen as [number, number][]) : []);
  } catch { /* session storage unavailable */ }
  S.agentSession = S.declaredSession || S.agentTabs.size > 0;
}
async function writeAgentSession(): Promise<void> {
  try { await chrome.storage.session.set({ declaredSession: S.declaredSession, agentTabs: [...S.agentTabs], agentSeen: [...seen] }); } catch { /* session storage unavailable */ }
}

/** Session changes and agent-tab checks run one at a time: an overlapping check could otherwise see
 *  OnlyRead's own attachments in progress, or interleave rule updates. */
let agentLock: Promise<void> = Promise.resolve();
export function withAgentLock(fn: () => Promise<void>): Promise<void> {
  const next = agentLock.then(fn, fn);
  agentLock = next.catch((err: unknown) => system(`agent-session:error ${err instanceof Error ? err.message : String(err)}`));
  return agentLock;
}

/** Recompute the session from its two sources and attach or detach when it changes. Call under the lock. */
export async function updateAgentSession(reason: string): Promise<void> {
  const active = S.declaredSession || S.agentTabs.size > 0;
  await writeAgentSession();
  if (active === S.agentSession) return;
  S.agentSession = active;
  await refreshAccountLock(); // the Pro account page's switch-offs, refused while an agent works (account-lock.ts)
  // The Pro account's site list (cloud-sync.ts): a session starts with the latest one, and a change from it that
  // lowers protection, deferred while the agent worked, applies when it ends (unless a PIN still holds it). Not
  // awaited: a network call has no place under the agent lock.
  void (active ? syncManagedSites('agent-session-start') : applyPendingManaged('agent-session-end'));
  // In "always" mode the session changes nothing about attachment (always attached); it only locks the
  // settings that would lower protection (protection.ts), which reads S.agentSession.
  if (S.policy.attachWhen !== 'agent-session') { system(`agent-session:${active ? 'start' : 'end'}(${reason}) settings ${active ? 'locked' : 'unlocked'}`); return; }
  if (attachmentOn()) {
    // Rules first: from here nothing non-GET reaches a guarded site until the debugger holds the tab.
    const closeGap = S.policy.mode === 'enforce';
    if (closeGap) { S.failClosed = true; await refreshRules(); }
    await holdGuardedTabs(closeGap); // a throw leaves the global block on
    system(`agent-session:start(${reason}) attached=${dbg.attachedTabs().length}`);
  } else {
    await dbg.detachAll();
    await unguarded.clear();
    S.failClosed = false;
    await refreshRules(); // clears dynamic rules → dormant, banner off
    system(`agent-session:end(${reason})`);
  }
  void broadcastEditorGuard();
}

/** A tab that had another debugger on it when OnlyRead attached (debugger.ts): an agent tab. */
export function markAgentTab(tabId: number): Promise<void> {
  return withAgentLock(async () => {
    seen.set(tabId, Date.now());
    if (S.agentTabs.has(tabId)) return;
    S.agentTabs = new Set([...S.agentTabs, tabId]);
    await updateAgentSession(`debugger-already-on-tab=${tabId}`);
  });
}

/** Before a session ends, the tabs OnlyRead holds: the targets list cannot show an agent that attached to one
 *  after OnlyRead did, so look at each (debugger.ts foreignDebuggerOn), but those whose own look just found none. An agent that leaves its first tab (closed, or
 *  idle) and carries on in another must not end the session. */
async function agentTabsAmongOurs(justLooked: ReadonlySet<number>): Promise<number[]> {
  const found: number[] = [];
  for (const tabId of dbg.attachedTabs()) if (!justLooked.has(tabId) && (await agentOn(tabId))) found.push(tabId);
  return found;
}

/** Whether another debugger is on a tab OnlyRead holds (debugger.ts foreignDebuggerOn: writes refused by rule while
 *  it looks). A failed look answers yes, keeping the session. */
async function agentOn(tabId: number): Promise<boolean> {
  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  if (!tab?.url) return false;
  const cover = async (on: boolean) => {
    if (on && !(await unguarded.add(tabId, true))) throw new Error('rule not installed');
    if (!on) await unguarded.remove([tabId], true);
  };
  try { return await dbg.foreignDebuggerOn(tabId, tab.url, cover); } catch { return true; }
}

/** Notes when an agent was last seen on each agent tab: in the report (a debugger OnlyRead does not hold), and by
 *  looking at each agent tab OnlyRead holds when it is due (agent-detect.ts probeDue). */
async function noteAgentsSeen(next: Set<number>, targets: chrome.debugger.TargetInfo[], now: number): Promise<void> {
  const ours = dbg.ownedTabs();
  for (const t of targets) if (t.type === 'page' && t.tabId !== undefined && t.attached && !ours.has(t.tabId)) seen.set(t.tabId, now);
  for (const id of next) if (!seen.has(id)) seen.set(id, now);
  await lookAtHeldAgentTabs(next, ours, now);
}

/** Looks at each agent tab OnlyRead holds that is due (a tab with a socket guard less often: agent-detect.ts). */
async function lookAtHeldAgentTabs(next: Set<number>, ours: Set<number>, now: number): Promise<void> {
  const guarded = new Set(armedTabs());
  for (const id of next) {
    if (!ours.has(id)) continue;
    // A tab that just joined was just seen: its first look comes after the usual pause.
    const last = lastProbe.get(id);
    if (last === undefined) { lastProbe.set(id, now); continue; }
    if (!probeDue(last, now, guarded.has(id), dbg.busy(id))) continue;
    lastProbe.set(id, now);
    if (await agentOn(id)) { seen.set(id, Date.now()); foundGone.delete(id); } else foundGone.add(id);
  }
  forgetLooks(next, ours);
}

/** Drops what the looks noted about tabs no longer agent tabs, or no longer held. */
function forgetLooks(next: Set<number>, ours: Set<number>): void {
  for (const id of [...lastProbe.keys()]) if (!next.has(id)) lastProbe.delete(id);
  for (const id of [...foundGone]) if (!next.has(id) || !ours.has(id)) foundGone.delete(id);
}

/** One look for agent tabs (tabs with a debugger OnlyRead did not attach). */
async function pollAgentTabs(): Promise<void> {
  let targets: chrome.debugger.TargetInfo[];
  try { targets = await chrome.debugger.getTargets(); } catch { return; }
  const next = nextAgentTabs(S.agentTabs, targets, dbg.ownedTabs());
  const now = Date.now();
  await noteAgentsSeen(next, targets, now);
  const ours = dbg.ownedTabs();
  const idle = idleAgentTabs(next, seen, now).filter((id) => !ours.has(id) || foundGone.has(id));
  for (const id of idle) next.delete(id);
  // Before the session ends (its agent tabs closed or idle), the other tabs OnlyRead holds: the agent may carry on in
  // one OnlyRead attached to first. A tab found this way was just looked at: its next look is not due yet.
  if (!next.size && S.agentTabs.size) for (const tabId of await agentTabsAmongOurs(new Set(idle))) { next.add(tabId); seen.set(tabId, now); lastProbe.set(tabId, now); }
  for (const id of [...seen.keys()]) if (!next.has(id)) seen.delete(id);
  const changed = next.size !== S.agentTabs.size || [...next].some((id) => !S.agentTabs.has(id));
  if (!changed) return;
  S.agentTabs = next;
  await updateAgentSession(next.size ? `agent-tabs=${[...next].join(',')}` : idle.length ? 'agent-tabs-idle' : 'agent-tabs-closed');
}

/** Whether an agent's debugger is on any agent tab now: in the report for a tab OnlyRead does not hold, by a look for
 *  one it does. */
async function agentPresent(): Promise<boolean> {
  let targets: chrome.debugger.TargetInfo[];
  try { targets = await chrome.debugger.getTargets(); } catch { return true; }
  const ours = dbg.ownedTabs();
  for (const id of S.agentTabs) {
    if (!ours.has(id) && targets.some((t) => t.tabId === id && t.attached)) return true;
    if (ours.has(id) && (await agentOn(id))) return true;
  }
  return false;
}

/** Cancel on Chrome's bar detaches every tab OnlyRead holds within a moment: one look after they have gone. */
const CANCEL_SETTLE_MS = 250;
let cancelLook = false;

/** Cancel on Chrome's bar for OnlyRead, during a session that "during agent sessions" attached: a look, at once, for an
 *  agent's debugger on the agent tabs. With none there the session ends now instead of after AGENT_IDLE_MS; with one
 *  there (an agent at work, or one whose debugger has not let go yet) it holds, and the tabs are held again
 *  (interception.ts onDetach). A declared session ends only when it is declared over. */
export function onBannerCancel(): void {
  if (S.policy.attachWhen !== 'agent-session' || !S.agentSession || S.declaredSession || cancelLook) return;
  cancelLook = true;
  setTimeout(() => void withAgentLock(async () => {
    cancelLook = false;
    if (!S.agentSession || S.declaredSession || (await agentPresent())) return;
    S.agentTabs = new Set();
    seen.clear();
    lastProbe.clear();
    foundGone.clear();
    await updateAgentSession('banner-canceled');
  }), CANCEL_SETTLE_MS);
}

let polling = false;
/** A check is skipped while the previous one (or a session change) is still running. */
function scheduleAgentPoll(): void {
  if (polling) return;
  polling = true;
  void withAgentLock(pollAgentTabs).finally(() => { polling = false; });
}

/** Watch for agent tabs whenever protection is on: under "during agent sessions" a session attaches the guard,
 *  and in both modes it locks the settings that would lower protection. */
export function syncAgentWatch(): void {
  const want = S.policy.enabled;
  if (want && !agentPoll) { agentPoll = setInterval(scheduleAgentPoll, AGENT_POLL_MS); scheduleAgentPoll(); }
  if (!want && agentPoll) { clearInterval(agentPoll); agentPoll = undefined; }
}
