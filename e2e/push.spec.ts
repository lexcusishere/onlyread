// Real-time sync from OnlyRead Pro (background/cloud-push.ts, content/account-nudge.ts), against the fixture's mock
// service: a push wakes the service worker and the account's lists are asked for at once; the account page's "the
// account changed" does the same from a page of the service, and from no other site. The mock sends no real push (the
// push service is Google's): the test dispatches the push event in the worker, as the browser does on one.
import { test, expect } from '@playwright/test';
import { Harness } from './helpers';

test.describe.configure({ mode: 'serial' });

const h = new Harness(4251);
const configAsks = async () => ((await (await fetch(`${h.base}/cloud/__mock`)).json()) as { log: { path: string }[] }).log.filter((l) => l.path === 'GET /v1/config').length;

test.beforeAll(async () => {
  await h.start({ mode: 'enforce' });
  await h.signInToMock();
});
test.afterAll(async () => { await h.stop(); });

test('a push makes the worker ask for the account\'s lists at once', async () => {
  const before = await configAsks();
  await h.sw.evaluate(() => { (self as unknown as EventTarget).dispatchEvent(new (globalThis as unknown as { PushEvent: new (t: string) => Event }).PushEvent('push')); });
  await expect.poll(configAsks, { timeout: 5000 }).toBeGreaterThan(before);
});

test('the account page\'s "the account changed" does the same, from the service\'s own pages only', async () => {
  const other = await h.ctx.newPage();
  await other.goto(`${h.base}/`); // the fixture's site, not the service (/cloud)
  let before = await configAsks();
  await other.evaluate(() => window.postMessage({ source: 'onlyread-pro', type: 'account-changed' }, location.origin));
  await other.waitForTimeout(1500);
  expect(await configAsks()).toBe(before);
  const page = await h.ctx.newPage();
  await page.goto(`${h.base}/cloud/pricing`); // a page of the configured service
  before = await configAsks();
  await page.evaluate(() => window.postMessage({ source: 'onlyread-pro', type: 'account-changed' }, location.origin));
  await expect.poll(configAsks, { timeout: 5000 }).toBeGreaterThan(before);
});
