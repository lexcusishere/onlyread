// The first-run demo: after the judge step the setup window offers to try OnlyRead on a real site. For the demo,
// protection is on and attached all the time ("always"), so the person's own click is guarded as an agent's would be;
// the site they chose is switched on. The first write OnlyRead refuses on that site ends the demo by itself: the
// settings the demo changed go back (the site stays guarded), and the setup window shows what was stopped. The
// person can skip at any point (the setup window, or the coach card on the site, content/demo-coach.ts), and a demo left
// running ends on its own after DEMO_TTL_MS. Ending puts back a "during agent sessions" that "always" replaced, which
// lowers protection: it goes through the settings lock like any such change (messages.ts), so an agent at work cannot
// end it.
import type { Policy } from '../shared/types';
import { type DemoRequest, demoSite } from '../shared/demo-sites';
import { checkFailure, operationName } from '../shared/refusals';
import { builtinSite } from './sites';
import { isTargetHost } from './decision';

/** What the demo changed, to put back, and what it stopped. */
interface DemoState {
  site: string;
  startedAt: number;
  /** The setup window's tab, brought forward when the demo ends. */
  setupTabId?: number;
  /** The tab the demo opened on its site: closing it skips the demo. */
  tabId?: number;
  prev: Pick<Policy, 'enabled' | 'mode' | 'attachWhen'>;
  /** The write refused, by name ("Like"), once there is one. */
  stopped?: { name: string; at: number };
}

/** A demo nobody finished ends on its own after this long. */
export const DEMO_TTL_MS = 15 * 60_000;
const KEY = 'demo';

let state: DemoState | undefined;
export const demoState = (): DemoState | undefined => state;

export async function readDemo(): Promise<void> {
  try { state = (await chrome.storage.session.get(KEY))[KEY] as DemoState | undefined; } catch { state = undefined; }
}
async function writeDemo(): Promise<void> {
  try { await (state ? chrome.storage.session.set({ [KEY]: state }) : chrome.storage.session.remove(KEY)); } catch { /* session storage unavailable */ }
}

/** The policy for the demo: protection on, refusing, attached all the time, the chosen site on. Only raises protection. */
export function demoPolicy(p: Policy, site: string): Policy {
  return { ...p, enabled: true, mode: 'enforce', attachWhen: 'always', sites: { ...p.sites, [site]: { enabled: true } } };
}

/** The policy after the demo: what it changed put back; the site it switched on stays on. */
export function afterDemoPolicy(p: Policy, prev: DemoState['prev']): Policy {
  return { ...p, enabled: prev.enabled || p.enabled, mode: prev.mode, attachWhen: prev.attachWhen };
}

export async function beginDemo(site: string, p: Policy, setupTabId: number | undefined, now = Date.now()): Promise<DemoState> {
  if (!demoSite(site) || !builtinSite(site)) throw new Error(`no demo for ${site}`);
  // A demo already running keeps what it changed: its own settings are not the ones to put back.
  const prev = state?.prev ?? { enabled: p.enabled, mode: p.mode, attachWhen: p.attachWhen };
  state = { site, startedAt: now, setupTabId, prev };
  await writeDemo();
  return state;
}

/** The tab the demo opened, once it has one. */
export async function setDemoTab(tabId: number): Promise<void> {
  if (!state) return;
  state = { ...state, tabId };
  await writeDemo();
}

export async function endDemo(): Promise<DemoState | undefined> {
  const was = state;
  state = undefined;
  await writeDemo();
  return was;
}

/** Whether a host belongs to the site of the demo running now. */
export function onDemoSite(host: string): boolean {
  const s = state && builtinSite(state.site);
  return Boolean(s && isTargetHost(host, s.domains));
}

/** A refusal on a guarded tab: the demo's when it is the write its site's suggested change sends (DemoSite.catches),
 *  refused on that site; not a write the page sent by itself, nor a request stopped only because a check could not
 *  run. Notes it once; true when this refusal is the one that ends the demo. */
async function noteDemoRefusal(host: string, req: DemoRequest, reason: string, now = Date.now()): Promise<boolean> {
  if (!state || state.stopped || !onDemoSite(host) || checkFailure(reason)) return false;
  if (!demoSite(state.site)?.catches(req)) return false;
  state = { ...state, stopped: { name: operationName(req.shape) ?? 'A change', at: now } };
  await writeDemo();
  return true;
}

/** Whether a refusal on `host` folds into the demo's own: once its write was refused, the site's follow-ups (the app's
 *  retries, the analytics beacon after the click) are logged but no longer added to OnlyRead's notice, which shows the
 *  demo's one change while step 2 is on screen. */
export function foldsIntoDemo(host: string): boolean {
  return Boolean(state?.stopped) && onDemoSite(host);
}

export function demoExpired(now = Date.now()): boolean {
  return Boolean(state && now - state.startedAt >= DEMO_TTL_MS);
}

/** What ends the demo once its write is refused (messages.ts, which saves settings through the lock). */
let onStopped: (tabId: number) => void = () => {};
export function whenDemoStops(fn: (tabId: number) => void): void { onStopped = fn; }

/** A refusal OnlyRead enforced on a tab (interception.ts): ends the demo when it is the demo's write. */
export async function demoRefusal(tabId: number, host: string, req: DemoRequest, reason: string): Promise<void> {
  if (await noteDemoRefusal(host, req, reason)) onStopped(tabId);
}
