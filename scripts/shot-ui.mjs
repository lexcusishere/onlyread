// Render popup.html and options.html with the extension loaded in Playwright Chromium and save
// screenshots (light + dark) for a visual check: node scripts/shot-ui.mjs  → test-results/ui/*.png
import { chromium } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
const ext = path.resolve('extension');
const out = process.env.OUT ?? "test-results/ui"; fs.mkdirSync(out, { recursive: true });
const profile = fs.mkdtempSync('/tmp/onlyread-ui-');
const ctx = await chromium.launchPersistentContext(profile, {
  channel: 'chromium', headless: true, viewport: { width: 420, height: 640 }, colorScheme: 'light',
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--silent-debugger-extension-api'],
});
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent('serviceworker');
const id = new URL(sw.url()).host;
// A fresh profile is a first install with no key: the background opens setup.html in a popup window.
const setup = ctx.pages().find((p) => p.url().includes('setup.html'))
  ?? await ctx.waitForEvent('page', { predicate: (p) => p.url().includes('setup.html'), timeout: 8000 }).catch(() => null);
if (setup) {
  await setup.waitForLoadState('domcontentloaded'); await setup.waitForTimeout(800);
  await setup.screenshot({ path: `${out}/setup.png`, fullPage: true });
  await setup.emulateMedia({ colorScheme: 'dark' }); await setup.waitForTimeout(300);
  await setup.screenshot({ path: `${out}/setup-dark.png`, fullPage: true });
  await setup.close();
  console.log('setup window opened on first install');
} else {
  console.log('WARNING: setup window did not open on first install');
}
// enable two sites + a custom one so the popup shows every state
await sw.evaluate(async () => {
  await globalThis.__onlyread.setPolicy({
    mode: 'enforce',
    sites: { gmail: { enabled: true }, calendar: { enabled: true }, linear: { enabled: false } },
    customSites: [{ id: 'app.linear-clone.io', name: 'app.linear-clone.io', domains: ['app.linear-clone.io'], enabled: true }],
  });
});
// a web tab first, so the popup has a 'current site' to show
const site = await ctx.newPage(); await site.goto(process.env.SHOT_SITE ?? 'http://localhost:4173/', { waitUntil: 'domcontentloaded' }).catch(() => {}); await site.waitForTimeout(1500);
const page = await ctx.newPage();
await page.goto(`chrome-extension://${id}/popup.html`);
await page.waitForTimeout(1500);
await page.screenshot({ path: `${out}/popup-light.png`, fullPage: true });
await page.emulateMedia({ colorScheme: 'dark' });
await page.waitForTimeout(300);
await page.screenshot({ path: `${out}/popup-dark.png`, fullPage: true });
await page.emulateMedia({ colorScheme: 'light' });
await page.setViewportSize({ width: 900, height: 900 });
await page.goto(`chrome-extension://${id}/options.html`);
await page.waitForTimeout(1200);
await page.evaluate(() => { const d = document.querySelector('details'); if (d) d.open = true; });
await page.setViewportSize({ width: 900, height: 1250 });
await page.screenshot({ path: `${out}/options.png`, fullPage: false });
await page.emulateMedia({ colorScheme: 'dark' }); await page.waitForTimeout(300);
await page.screenshot({ path: `${out}/options-dark.png`, fullPage: false });
// The stored choice wins over the system scheme in both directions.
await sw.evaluate(() => chrome.storage.local.set({ theme: 'light' })); await page.waitForTimeout(400);
await page.screenshot({ path: `${out}/options-forced-light.png`, fullPage: false, clip: { x: 0, y: 0, width: 900, height: 420 } });
await page.emulateMedia({ colorScheme: 'light' });
await sw.evaluate(() => chrome.storage.local.set({ theme: 'dark' })); await page.waitForTimeout(400);
await page.screenshot({ path: `${out}/options-forced-dark.png`, fullPage: false, clip: { x: 0, y: 0, width: 900, height: 420 } });
await sw.evaluate(() => chrome.storage.local.remove('theme'));
await ctx.close();
console.log('done', id);
