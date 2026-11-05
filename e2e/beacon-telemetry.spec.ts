// Beacons (navigator.sendBeacon) to a guarded site are refused by a browser rule, except to the telemetry addresses the
// allow-lists name, which pass as they would sent any other way. In Chromium, with every built-in site switched on so
// Chrome installs every allow rule: none may be refused, or the whole rule set would fail to install.
import { test, expect } from '@playwright/test';
import { Harness } from './helpers';
import fs from 'node:fs';

/** Every built-in site, by its profile file (extension/policy/sites). */
const SITE_IDS = fs.readdirSync('extension/policy/sites').filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));

const h = new Harness(4279);
test.beforeAll(async () => {
  await h.start({ mode: 'enforce', sites: Object.fromEntries(SITE_IDS.map((id) => [id, { enabled: true }])) });
});
test.afterAll(async () => { await h.stop(); });

test('every rule installs, and a beacon passes to a telemetry address and is refused anywhere else', async () => {
  const installed = await h.sw.evaluate(async () => (await chrome.declarativeNetRequest.getDynamicRules()).filter((r) => r.condition.regexFilter && r.action.type === 'allow' && r.condition.resourceTypes?.includes('ping' as chrome.declarativeNetRequest.ResourceType)).length);
  expect(installed).toBeGreaterThan(50);
  await h.reset();
  const sent = await h.page.evaluate(() => [navigator.sendBeacon('/collect', 'x=1'), navigator.sendBeacon('/api/items', '{"name":"b"}')]);
  expect(sent).toEqual([true, true]); // queued by the browser; the network decides
  await expect.poll(async () => (await h.serverLog()).filter((e) => e.method === 'POST').map((e) => e.path), { timeout: 5000 }).toContain('/collect');
  await h.page.waitForTimeout(500);
  expect((await h.serverLog()).filter((e) => e.method === 'POST').map((e) => e.path)).not.toContain('/api/items');
});
