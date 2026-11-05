// Consent to what the AI judge is sent. The judge is the one place request data leaves the browser (a short
// description of a request nothing on the device could settle, to the provider of the person's key or to OnlyRead Pro),
// so the setup window and the settings page say what is sent and ask for agreement first, and until it is given no
// judge runs: requests no rule covers are refused, as with no judge set up. The Chrome Web Store's user data policy
// asks for this disclosure and consent inside the product.
import { devBuild } from './policy';

const KEY = 'judgeConsent';

interface Stored { agreed: boolean; at: number }

/** Whether the person agreed. A development build counts as agreed until it is withdrawn, so the harness's judge runs
 *  without a click; a release asks. */
export function consentFrom(stored: unknown, dev = devBuild()): boolean {
  const s = stored as Partial<Stored> | undefined;
  return s && typeof s.agreed === 'boolean' ? s.agreed : dev;
}

export async function readConsent(): Promise<boolean> {
  try { return consentFrom((await chrome.storage.local.get(KEY))[KEY]); } catch { return consentFrom(undefined); }
}

export async function writeConsent(agreed: boolean): Promise<void> {
  await chrome.storage.local.set({ [KEY]: { agreed, at: Date.now() } satisfies Stored });
}

/** What the judge problem says while consent is missing (status-text.ts shows it). */
export const CONSENT_PROBLEM = 'your agreement to what it is sent';
