// The settings page's empty-state recording (extension/assets/add-site-{light,dark}.webp), step 1: capture the real UI.
// A skeleton page at example.com (served here, nothing goes to the network) in one tab, the real popup on it before and after "Guard
// this site". scripts/add-site-demo.py then draws the browser around them and animates the clicks.
//   node scripts/add-site-demo.mjs && python3 scripts/add-site-demo.py
import { chromium } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';

const ext = path.resolve('extension');
const out = path.resolve('test-results/add-site-demo');
fs.mkdirSync(out, { recursive: true });
const SITE = 'https://example.com/';

// A skeleton page: grey placeholder blocks, no name, logo or words, so the recording shows no particular site.
const page = (dark) => `<!doctype html><html><head><meta charset="utf-8"><title>example.com</title>
<style>
  :root { --bg:${dark ? '#0f1115' : '#f7f8fa'}; --card:${dark ? '#181b22' : '#fff'}; --line:${dark ? '#262b36' : '#e6e9ef'}; --sk:${dark ? '#323846' : '#d9dde5'}; --sk2:${dark ? '#272c37' : '#e6e9ef'}; }
  * { box-sizing: border-box } body { margin:0; background: var(--bg); display: grid; grid-template-columns: 210px 1fr; height: 100vh; }
  .sk { background: var(--sk); border-radius: 7px; } .sk.l { background: var(--sk2); }
  aside { border-right: 1px solid var(--line); padding: 20px 16px; background: var(--card); display: grid; gap: 12px; align-content: start; }
  main { padding: 24px 28px; display: grid; gap: 12px; align-content: start; }
  .head { display:flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
  .card { background: var(--card); border:1px solid var(--line); border-radius: 12px; padding: 16px; display: grid; gap: 9px; }
</style></head><body>
<aside><div class="sk" style="width:120px;height:22px;margin-bottom:10px"></div>
${[100, 130, 90, 110].map((w) => `<div class="sk l" style="width:${w}px;height:14px"></div>`).join('')}</aside>
<main><div class="head"><div class="sk" style="width:170px;height:22px"></div><div class="sk" style="width:96px;height:30px;border-radius:9px"></div></div>
${[[220, 380], [180, 330], [240, 300], [200, 360]].map(([a, b]) => `<div class="card"><div class="sk" style="width:${a}px;height:14px"></div><div class="sk l" style="width:${b}px;height:11px"></div></div>`).join('')}
</main></body></html>`;

/** Playwright drives the browser over the debugger, so OnlyRead takes it for an AI agent and shows its lock banner; a
 *  person adding a site would not see it, so the recording leaves it out. */
const hideAgentBanner = (p) => p.evaluate(() => { const l = document.getElementById('lock'); if (l) l.hidden = true; });

async function capture(scheme) {
  const profile = fs.mkdtempSync('/tmp/onlyread-demo-');
  const ctx = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: true, deviceScaleFactor: 2, colorScheme: scheme,
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--silent-debugger-extension-api'],
  });
  await ctx.route('https://example.com/**', (route) => {
    if (new URL(route.request().url()).pathname !== '/') return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ contentType: 'text/html', body: page(scheme === 'dark') });
  });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const id = new URL(sw.url()).host;
  for (const p of ctx.pages()) if (p.url().includes('setup.html')) await p.close();
  const site = await ctx.newPage();
  await site.setViewportSize({ width: 960, height: 560 });
  await site.goto(SITE, { waitUntil: 'load' });
  await site.waitForTimeout(800);
  await site.screenshot({ path: `${out}/site-${scheme}.png` });

  const popup = await ctx.newPage();
  await popup.setViewportSize({ width: 356, height: 600 });
  await popup.goto(`chrome-extension://${id}/popup.html`);
  await popup.waitForSelector('#guard', { timeout: 10_000 });
  await popup.waitForTimeout(600);
  await hideAgentBanner(popup);
  const height = await popup.evaluate(() => document.body.scrollHeight);
  await popup.setViewportSize({ width: 356, height });
  const guard = await popup.locator('#guard').boundingBox();
  await popup.screenshot({ path: `${out}/popup-before-${scheme}.png` });
  await popup.click('#guard');
  await popup.waitForSelector('.site input[type=checkbox]:checked', { state: 'attached', timeout: 10_000 });
  await popup.waitForTimeout(600);
  await hideAgentBanner(popup);
  const after = await popup.evaluate(() => document.body.scrollHeight);
  await popup.setViewportSize({ width: 356, height: after });
  const toggle = await popup.locator('.site .switch').boundingBox();
  await popup.screenshot({ path: `${out}/popup-after-${scheme}.png` });
  await ctx.close();
  return { guard, toggle, height, after };
}

const boxes = { light: await capture('light'), dark: await capture('dark') };
fs.writeFileSync(`${out}/boxes.json`, JSON.stringify(boxes, null, 1));
console.log('captured', out, JSON.stringify(boxes.light));
