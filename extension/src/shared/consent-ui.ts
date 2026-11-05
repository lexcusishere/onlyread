// What the AI judge is sent, on the setup window and the settings page: one sentence under the buttons that set up a
// judge, pointing to the privacy policy, which sets it all out. Pressing Sign in or Save is the agreement
// (background/consent.ts keeps it); the settings page can withdraw it.

/** Records the agreement before a judge is set up: the press of Sign in or Save is it. */
export async function agreeToJudge(): Promise<void> {
  await chrome.runtime.sendMessage({ type: 'consent:set', agreed: true }).catch(() => {});
}
