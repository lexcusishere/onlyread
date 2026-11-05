// Signed out of OnlyRead Pro with no own key, protection goes off: there is no AI judge left to ask (messages.ts
// offWithoutJudge). With an agent at work the lock holds that back, and it is tried again when the agent finishes.
// That retry used to leave protection on ("On, always", with no judge): it moved the judge to the own key, and then asked
// whether a judge was missing before that move had been applied, so the missing key looked like a working judge.
import { test, expect } from '@playwright/test';
import { Harness } from './helpers';

const h = new Harness(4251);
const stored = async () => (await h.sw.evaluate(() => chrome.storage.local.get(['policy', 'cloudTokens']))) as { policy: { enabled: boolean; judge: { provider: string } }; cloudTokens?: unknown };
/** The agent finishing (index.ts endAgentSessionForTest), once: the lock opening retries what it held back, once. */
const endAgentSession = () => h.sw.evaluate(() => (globalThis as unknown as { __onlyread: { endAgentSessionForTest: () => Promise<void> } }).__onlyread.endAgentSessionForTest());

test.beforeAll(async () => { await h.start({ mode: 'enforce' }); });
test.afterAll(async () => { await h.stop(); });

test('signed out of Pro with "Always" and no own key: held on while an agent works, off once it finishes', async () => {
  await h.signInToMock();
  await h.setPolicy({ enabled: true, attachWhen: 'always', judge: { provider: 'cloud', byok: { id: 'openrouter' }, timeoutMs: 3000, llmTimeoutMs: 6000 } });
  await h.sw.evaluate(() => chrome.storage.local.remove('secrets')); // no own key to fall back on
  // From here the background asks whether a judge is really there, as a release does, instead of assuming one.
  await h.assumeJudge(false);
  const page = await h.ctx.newPage();
  await page.goto(`${h.base}/cloud/account`);
  expect((await h.status()).agentSession).toBe(true);

  await page.evaluate(() => window.postMessage({ source: 'onlyread-pro', type: 'signed-out', account: 'Test.User@example.com' }, location.origin));
  await expect.poll(async () => (await stored()).cloudTokens, { timeout: 10_000 }).toBeUndefined();
  await page.waitForTimeout(1000);
  expect((await stored()).policy).toMatchObject({ enabled: true, judge: { provider: 'cloud' } }); // the lock holds both

  await endAgentSession();
  await expect.poll(async () => (await stored()).policy, { timeout: 10_000 }).toMatchObject({ enabled: false, judge: { provider: 'byok' } });
  await page.close();
});

test('the Pro sign-in dropped by a write from outside (no sign-out hook runs): protection still goes off once it may', async () => {
  await h.assumeJudge(true);
  await h.signInToMock();
  await h.setPolicy({ enabled: true, attachWhen: 'always', judge: { provider: 'cloud', byok: { id: 'openrouter' }, timeoutMs: 3000, llmTimeoutMs: 6000 } });
  await h.assumeJudge(false);
  expect((await stored()).policy.enabled).toBe(true);
  await h.sw.evaluate(() => chrome.storage.local.remove('cloudTokens')); // not the background's own write
  await h.page.waitForTimeout(500);
  // Playwright's CDP session may start another agent session at once, which holds it again: the agent ends on every
  // try, as it would in the end.
  await expect.poll(async () => { await endAgentSession(); return (await stored()).policy.enabled; }, { timeout: 10_000 }).toBe(false);
});

test('an own key that fails its test changes nothing: Pro stays the judge and signed in, and no key is stored', async () => {
  await h.assumeJudge(true);
  await h.signInToMock();
  await h.setPolicy({ enabled: true, judge: { provider: 'cloud', byok: { id: 'openrouter' }, timeoutMs: 3000, llmTimeoutMs: 6000 } });
  const ext = await h.ctx.newPage();
  await ext.goto(`chrome-extension://${new URL(h.sw.url()).host}/options.html`);
  const r = await ext.evaluate(() => chrome.runtime.sendMessage({ type: 'judge:byok', choice: { id: 'openrouter' }, key: 'sk-or-not-a-real-key' })) as { ok: boolean; tested?: boolean };
  expect(r).toMatchObject({ ok: false, tested: true });
  const after = (await h.sw.evaluate(() => chrome.storage.local.get(['policy', 'cloudTokens', 'secrets']))) as { policy: { enabled: boolean; judge: { provider: string } }; cloudTokens?: unknown; secrets?: { keys?: Record<string, string> } };
  expect(after.policy).toMatchObject({ enabled: true, judge: { provider: 'cloud' } });
  expect(after.cloudTokens).toBeDefined();
  expect(after.secrets?.keys?.openrouter).toBeUndefined();
  await ext.close();
});
