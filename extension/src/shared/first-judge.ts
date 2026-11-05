// The first AI judge this browser sets up (a Pro sign-in, or an own key that tested well) is followed by the demo,
// wherever it was set up: the setup window goes on to its demo, the settings page opens it (background/messages.ts
// proSignInCode for Pro, options.ts and setup.ts for a key). Recorded once; removing the record, or reinstalling,
// makes the next one a first one again.

export const FIRST_JUDGE_KEY = 'firstJudgeAt';

/** Records the first judge set up; true only the first time. */
export async function markFirstJudge(): Promise<boolean> {
  const got = (await chrome.storage.local.get(FIRST_JUDGE_KEY).catch(() => ({}))) as Record<string, unknown>;
  if (got[FIRST_JUDGE_KEY]) return false;
  await chrome.storage.local.set({ [FIRST_JUDGE_KEY]: Date.now() }).catch(() => {});
  return true;
}
