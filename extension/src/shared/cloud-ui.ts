// One wording for the OnlyRead Pro state (the subscription; `cloud` in code), shared by the popup, the
// options page and the setup window. Usage is shown as a share of the month's allowance, never as counts.
import type { CloudAccount, CloudStatus } from './types';

interface CloudProblem {
  /** Short sentence for status lines. */
  text: string;
  /** What the user can do about it. */
  action: 'signin' | 'subscribe' | 'wait' | 'retry';
}

/** How long a failure to reach Pro counts: within it, Pro is out of reach and this browser's own pages stand in. */
const UNREACHABLE_MS = 5 * 60_000;

/** Pro mode with the service reachable: OnlyRead is managed on the Pro account page (the background's settings
 *  buttons, and this browser's settings page cut short). Out of reach (an `unavailable` in the last few minutes), this
 *  browser's own page stands in. */
export function proManaged(c: CloudStatus | undefined, now = Date.now()): boolean {
  if (c?.provider !== 'cloud' || !c.signedIn) return false;
  return !(c.lastError?.code === 'unavailable' && now - c.lastError.at < UNREACHABLE_MS);
}

const shortDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

/** Undefined when Pro is not the provider or everything is fine. */
export function cloudProblem(c: CloudStatus | undefined): CloudProblem | undefined {
  if (c?.provider !== 'cloud') return undefined;
  if (!c.signedIn) return { text: 'No AI Judge configured for this browser', action: 'signin' };
  const plan = planProblem(c);
  if (plan) return plan;
  if (c.lastError?.code === 'unavailable' || c.lastError?.code === 'bad_response') {
    return { text: 'OnlyRead Pro: unreachable, so uncertain requests are refused', action: 'retry' };
  }
  if (c.lastError?.code === 'not_signed_in') return { text: 'OnlyRead Pro: signed out', action: 'signin' };
  return undefined;
}

/** Whether Pro judges for the account: the service's word when it gives one, else its status. */
export function accountActive(a: CloudAccount | undefined): boolean {
  if (!a) return false;
  return a.active ?? ((a.status === 'active' || a.status === 'trialing') && a.credits?.left !== 0);
}

/** The account's state after the e-mail: the service's words, else its status ("trial" for trialing). */
export function accountStatusText(a: CloudAccount): string {
  return a.statusText ?? (a.status === 'trialing' ? 'trial' : a.status);
}

/** What the account's plan stands in the way of: free credits used up, no subscription in force, the month used up.
 *  A refusal the service put in words is said in its words. */
function planProblem(c: CloudStatus): CloudProblem | undefined {
  return ownWordsProblem(c) ?? creditsProblem(c) ?? inactiveProblem(c) ?? limitProblem(c);
}

/** A refusal of the plan the service put in its own words: a whole sentence, said as given. */
function ownWordsProblem(c: CloudStatus): CloudProblem | undefined {
  const err = c.lastError?.code;
  const own = c.lastError?.message;
  if (!own || (err !== 'subscription_inactive' && err !== 'credits_exhausted' && err !== 'limit_reached')) return undefined;
  return { text: own, action: err === 'limit_reached' ? 'wait' : 'subscribe' };
}

function creditsProblem(c: CloudStatus): CloudProblem | undefined {
  const usedUp = c.lastError?.code === 'credits_exhausted' || (c.account?.active === undefined && c.account?.credits?.left === 0);
  return usedUp ? { text: 'OnlyRead Pro: your free judged requests are used up, so uncertain requests are refused. Add a code on your Pro account page', action: 'subscribe' } : undefined;
}

/** No plan in force: the service's verdict when it gives one; else a status that is neither active nor a trial. */
function inactiveProblem(c: CloudStatus): CloudProblem | undefined {
  const a = c.account;
  const inactive = a && (a.active === false || (a.active === undefined && Boolean(a.status) && !accountActive(a)));
  if (c.lastError?.code !== 'subscription_inactive' && !inactive) return undefined;
  const st = a?.statusText ? accountStatusText(a) : 'subscription inactive';
  return { text: `OnlyRead Pro: ${st}, so uncertain requests are refused`, action: 'subscribe' };
}

function limitProblem(c: CloudStatus): CloudProblem | undefined {
  const a = c.account;
  if (c.lastError?.code !== 'limit_reached' && !(a && a.usage >= a.cap)) return undefined;
  const when = a?.resetsAt ? `; it resets ${shortDate(a.resetsAt)}` : '';
  return { text: `OnlyRead Pro: this month's usage is used up, so uncertain requests are refused${when}`, action: 'wait' };
}

/** Share of this month's allowance used, 0–100 (rounded up, so any use shows at least 1%). */
export function usagePercent(usage: number, cap: number): number {
  if (usage <= 0) return 0;
  return Math.min(100, Math.max(1, Math.ceil((usage / Math.max(1, cap)) * 100)));
}

/** "26% of this month's usage · resets Oct 1", or, on free credits, "740 of 1,000 free judged requests left" */
export function cloudUsage(c: CloudStatus | undefined): string {
  const a = c?.account;
  if (!a) return '';
  if (a.usageText) return a.usageText;
  if (a.credits) return `${a.credits.left.toLocaleString('en')} of ${a.credits.total.toLocaleString('en')} free judged requests left`;
  return `${usagePercent(a.usage, a.cap)}% of this month's usage, resets ${shortDate(a.resetsAt)}`;
}
