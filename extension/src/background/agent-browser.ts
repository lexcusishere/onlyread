// A browser that belongs to an AI agent: one set up with a setup link from the Pro account page, for a
// new agent. An agent that drives the computer (mouse, keyboard and screenshots, like Grok's) attaches no debugger, so
// OnlyRead cannot see it work (agent-detect.ts); such a browser is therefore locked as if an agent always worked:
// nothing here may lower protection (protection.ts lockFor, account-lock.ts, the setup's Undo, signing out of Pro).
// The person releases it from their own browser: signing it out on the account page ends its sign-in, and the next
// refresh refused here (cloud-session.ts) clears the mark.
import { refreshAccountLock } from './account-lock';
import { ownRemove, ownSet } from './owned-storage';
import { S, system } from './state';

const KEY = 'agentBrowser';
interface Mark { at: number; account: string }

export async function loadAgentBrowser(): Promise<void> {
  try {
    const m = (await chrome.storage.local.get(KEY))[KEY] as Mark | undefined;
    S.agentBrowser = Boolean(m && typeof m.at === 'number');
  } catch { /* storage unavailable: unmarked */ }
}

/** Marks this browser as an agent's: done when a setup link signs it in. Written as the background's own
 *  (owned-storage.ts): a removal written around it is put back while the mark holds. */
export async function markAgentBrowser(account: string): Promise<void> {
  await ownSet({ [KEY]: { at: Date.now(), account } satisfies Mark });
  S.agentBrowser = true;
  system(`agent-browser:marked ${account}`.slice(0, 200));
  await refreshAccountLock();
}

/** Clears the mark: the account signed this browser out (its refresh token was refused). */
export async function releaseAgentBrowser(why: string): Promise<void> {
  if (!S.agentBrowser) return;
  await ownRemove(KEY);
  S.agentBrowser = false;
  system(`agent-browser:released (${why})`);
  await refreshAccountLock();
}
