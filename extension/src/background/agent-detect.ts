// Agent-session detection. Browser agents (Claude in Chrome and others) drive a tab through Chrome's
// debugger, and chrome.debugger.getTargets() reports every tab a debugger is attached to. A tab that has
// a debugger OnlyRead did not attach is an agent tab: the session starts when the first one appears and
// ends when the last one closes.
//
// Once OnlyRead attaches to an agent tab too, the report cannot tell the two debuggers apart, so a tab stays an agent
// tab while it is open and an agent was seen on it in the last AGENT_IDLE_MS: seen in the report while OnlyRead does
// not hold it, or found by a look at a tab OnlyRead holds (agent-session.ts: a short let-go, every few seconds). An
// agent that finished and left its tabs open does not hold the session (otherwise protection would stay attached,
// the banner up and the settings locked for as long as the tabs stayed open, with nothing working). DevTools or
// another debugging extension also count as an agent; that errs toward protecting.
//
// Claude in Chrome attaches its debugger for an action and lets go about twenty seconds after its last one, so its
// debugger is gone while it thinks between actions: an agent tab is not idle the moment the debugger leaves, only
// after AGENT_IDLE_MS.

/** An agent tab with no agent seen on it for this long stops counting. Short: the agent's own debugger stays about
 *  twenty seconds after its last action, so the session already outlasts most pauses, and an agent that comes back
 *  starts a new one safely (a session start refuses writes by rule before anything else: agent-session.ts). */
export const AGENT_IDLE_MS = 10_000;
/** How often an agent tab OnlyRead holds is looked at for another debugger (a short let-go, every POST of the tab
 *  refused by rule meanwhile, reads sent as POSTs included: debugger.ts foreignDebuggerOn). Shorter than the time
 *  an agent's debugger stays after its action, so no action goes unseen. */
export const AGENT_PROBE_MS = 5_000;
/** The same, for a tab whose page carries a socket guard: taking it back re-arms the guard in each of its workers. */
export const AGENT_PROBE_GUARDED_MS = 15_000;

/** Whether an agent tab OnlyRead holds is due a look. Not while a request of the tab is being decided (the look
 *  refuses the tab's POSTs until none is, reads sent as POSTs included), unless that has put it off for
 *  AGENT_PROBE_GUARDED_MS: a page that is never quiet is still looked at. */
export function probeDue(last: number, now: number, guarded: boolean, busy: boolean): boolean {
  const every = guarded ? AGENT_PROBE_GUARDED_MS : AGENT_PROBE_MS;
  return now - last >= (busy ? every + AGENT_PROBE_GUARDED_MS : every);
}

/** The agent tabs no agent was seen on for `idleMs`: they leave the session. */
export function idleAgentTabs(tabs: ReadonlySet<number>, seen: ReadonlyMap<number, number>, now: number, idleMs = AGENT_IDLE_MS): number[] {
  return [...tabs].filter((id) => now - (seen.get(id) ?? now) >= idleMs);
}

interface TargetLike { type: string; tabId?: number; attached: boolean }

/** The agent tabs after one look at the targets: new foreign attachments join, closed tabs leave. */
export function nextAgentTabs(prev: ReadonlySet<number>, targets: TargetLike[], ours: ReadonlySet<number>): Set<number> {
  const pages = targets.filter((t) => t.type === 'page' && t.tabId !== undefined);
  const open = new Set(pages.map((t) => t.tabId!));
  const next = new Set([...prev].filter((id) => open.has(id)));
  for (const t of pages) if (t.attached && !ours.has(t.tabId!)) next.add(t.tabId!);
  return next;
}

/** How often to look while "during agent sessions" is on: the time an agent that comes back can act before its
 *  session refuses writes. Each look is one cheap Chrome API call, which also keeps the service worker awake, so a
 *  session start is never missed while the worker sleeps. */
export const AGENT_POLL_MS = 100;
