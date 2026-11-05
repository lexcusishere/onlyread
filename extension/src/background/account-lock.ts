// The Pro account page, while an AI agent works in this browser. The account's guarded sites apply to
// every browser signed in to it, so an agent that switched one off there would lower protection everywhere, its own
// browser included once its session ends (cloud-sync.ts defers such a change only while it works). So, as the
// settings lock does for this browser's own settings (protection.ts), the page's changes that lower protection are
// refused while an agent is at work (state.ts agentAtWork: a detected session, or a browser that belongs to one): a session rule blocks their addresses (rules.ts buildAccountLockRule), with
// or without a debugger attached. Adding sites stays open; the page says why a switch-off did not save.
import { ACCOUNT_LOCK_RULE_ID, buildAccountLockRule, replaceSessionRule } from './rules';
import { S, agentAtWork, system } from './state';

/** Puts the rule in place, or takes it away, to match agentAtWork() and the service in use. Compares with the
 *  session rules themselves, which outlive a restart of this worker. */
export async function refreshAccountLock(): Promise<void> {
  try {
    const want = agentAtWork() ? buildAccountLockRule(S.policy.cloud.serviceUrl) : null;
    const have = (await chrome.declarativeNetRequest.getSessionRules()).find((r) => r.id === ACCOUNT_LOCK_RULE_ID);
    if ((have?.condition.regexFilter ?? null) === (want?.condition.regexFilter ?? null)) return;
    await replaceSessionRule(ACCOUNT_LOCK_RULE_ID, want);
    system(`account-lock:${want ? 'on' : 'off'}`);
  } catch (err) {
    console.warn('[onlyread] account lock rule failed:', err);
  }
}
