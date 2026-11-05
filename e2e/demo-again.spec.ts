// The demo again, any time after setup: the settings page's "Try the demo" opens the setup window straight at the
// demo's choice of site, where leaving is Close: back to the settings tab it came from, no new tab.
import { test, expect } from '@playwright/test';
import { Harness } from './helpers';

const h = new Harness(4271);
test.beforeAll(async () => { await h.start({ mode: 'enforce' }); });
test.afterAll(async () => { await h.stop(); });

test('"Try the demo" opens the setup window at the demo\'s sites', async () => {
  const o = await h.ctx.newPage();
  await o.goto(`chrome-extension://${new URL(h.sw.url()).host}/options.html`);
  await o.locator('#demo-again').click();
  // A new setup window, or the one already open (a first install opens it) sent to the demo's step.
  await expect.poll(() => h.ctx.pages().some((p) => p.url().endsWith('setup.html#demo')), { timeout: 10_000 }).toBe(true);
  const setup = h.ctx.pages().find((p) => p.url().endsWith('setup.html#demo'))!;
  await expect(setup.locator('#step-demo')).toBeVisible();
  await expect(setup.locator('#step-judge')).toBeHidden();
  await expect(setup.locator('#demo-tiles .tile')).toHaveCount(5);
  await expect(setup.locator('#demo-skip')).toHaveText('Close');
  const pages = h.ctx.pages().length;
  const closed = setup.waitForEvent('close', { timeout: 5_000 });
  await setup.locator('#demo-skip').click();
  await closed;
  await expect.poll(() => o.evaluate(() => document.visibilityState)).toBe('visible'); // its tab is the active one again
  expect(h.ctx.pages()).toHaveLength(pages - 1); // the setup window gone, no settings tab added
  await o.close();
});
