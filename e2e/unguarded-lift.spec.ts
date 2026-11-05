// A guarded tab the debugger did not hold when protection came on (the first-run demo opens its site just as it
// switches protection to "always") has its writes refused by rule. Once the debugger holds the tab, as its page loads,
// the rule is lifted at once: X loads its home timeline with POSTs in that first second, and refused, it stays empty.
import { test, expect } from '@playwright/test';
import { Harness } from './helpers';

const h = new Harness(4287);
test.beforeAll(async () => { await h.start({ mode: 'enforce', attachWhen: 'always' }); });
test.afterAll(async () => { await h.stop(); });

test('a tab marked as not held gets its writes back as soon as its page is held', async () => {
  const p = await h.ctx.newPage();
  await p.goto('about:blank');
  const tabId = await h.sw.evaluate(async () => Math.max(...(await chrome.tabs.query({})).map((t) => t.id ?? 0))); // the newest tab: this page
  const hooks = 'globalThis.__onlyread'; // the dev build's test hooks (background/index.ts), evaluated as plain JavaScript
  expect(await h.sw.evaluate(`${hooks}.markUnguarded(${tabId})`)).toBe(true);
  await p.goto(`${h.base}/`);
  await expect.poll(() => h.sw.evaluate(`${hooks}.attached().includes(${tabId})`), { timeout: 5000 }).toBe(true);
  await p.waitForTimeout(300);
  // A read the fixture's telemetry rule allows: refused only if the tab's rule were still there.
  const res = await p.evaluate(async () => { try { return (await fetch('/collect', { method: 'POST', body: 'x' })).status; } catch { return 'refused'; } });
  expect(res).toBe(204);
});
