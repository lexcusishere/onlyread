// Setup by an AI agent from the Pro service's agent-setup page: the page learns OnlyRead is installed, a
// real click on Apply switches the named sites on and refuses writes, a click the page's own script makes changes
// nothing, the same page on another origin changes nothing, and a setup link signs the browser in. Against the fixture's mock Pro service (background/agent-setup.ts, content/agent-setup.ts).
import { test, expect, type Page } from '@playwright/test';
import { Harness } from './helpers';

test.describe.configure({ mode: 'serial' });

const h = new Harness(4243);
type Posted = { type: string; data: Record<string, unknown> };
type Stored = { mode: string; sites: Record<string, { enabled: boolean }>; customSites: Array<{ id: string; enabled: boolean }>; judge: { provider: string } };
const stored = async () => (await h.sw.evaluate(() => chrome.storage.local.get('policy'))).policy as Stored;
const posted = (page: Page) => page.evaluate(() => (window as unknown as { __onlyread: unknown[] }).__onlyread) as Promise<Posted[]>;

test.beforeAll(async () => {
  // The browser guards some other site, not the fixture, whose host also serves the mock service.
  await h.start({ mode: 'monitor', customSites: [{ id: 'other.example', name: 'Other', domains: ['other.example'], enabled: true }] });
  await h.setPolicy({ cloud: { serviceUrl: `${h.base}/cloud`, timeoutMs: 8000 } });
});
test.afterAll(async () => { await h.stop(); });

test('the page hears that OnlyRead is installed, with what it guards', async () => {
  const page = await h.ctx.newPage();
  await page.goto(`${h.base}/cloud/agent-setup`);
  await expect.poll(async () => (await posted(page)).find((m) => m.type === 'status')?.data.version).toBeTruthy();
  const status = (await posted(page)).find((m) => m.type === 'status')!.data;
  expect(status.mode).toBe('monitor');
  await page.close();
});

test('a click by the page itself, or the page on another origin, changes nothing', async () => {
  const before = await stored();
  const page = await h.ctx.newPage();
  await page.goto(`${h.base}/cloud/agent-setup`);
  await page.fill('#onlyread-sites', 'gmail');
  await page.evaluate(() => document.getElementById('onlyread-apply')!.click()); // untrusted
  const other = await h.ctx.newPage();
  await other.goto(`${h.base.replace('localhost', '127.0.0.1')}/cloud/agent-setup`);
  await other.fill('#onlyread-sites', 'gmail');
  await other.click('#onlyread-apply'); // trusted, but not the service this browser uses
  await page.waitForTimeout(1000);
  expect(await stored()).toEqual(before);
  expect((await posted(other)).filter((m) => m.type === 'status')).toEqual([]);
  await page.close(); await other.close();
});

test('a real click guards the named sites and refuses writes; the settings page offers to undo it', async () => {
  const page = await h.ctx.newPage();
  await page.goto(`${h.base}/cloud/agent-setup`);
  await page.fill('#onlyread-sites', 'Gmail, google calendar\napp.example.org, not a site');
  await page.click('#onlyread-apply');
  await expect.poll(async () => (await posted(page)).find((m) => m.type === 'result')?.data).toBeTruthy();
  const result = (await posted(page)).find((m) => m.type === 'result')!.data;
  expect(result).toMatchObject({ ok: true, added: ['Gmail', 'Google Calendar', 'Example'], unknown: ['not a site'] });
  const p = await stored();
  expect(p.mode).toBe('enforce');
  expect(p.sites.gmail?.enabled).toBe(true);
  expect(p.sites.calendar?.enabled).toBe(true);
  expect(p.customSites.find((c) => c.id === 'app.example.org')?.enabled).toBe(true);
  await page.close();

  const options = await h.ctx.newPage();
  await options.goto(`chrome-extension://${new URL(h.sw.url()).host}/options.html`);
  await expect(options.locator('#setup-text')).toContainText('An AI agent set up OnlyRead: made Gmail, Google Calendar, Example read-only, set it to refuse writes.');
  await expect(options.locator('#setup-undo')).toBeVisible();
  // Undo lowers protection, so it waits while an agent works (Playwright's CDP session counts as one).
  await options.locator('#setup-undo').click();
  await expect(options.locator('#lock-text')).toContainText('An AI agent is active');
  expect((await stored()).sites.gmail?.enabled).toBe(true);
  await options.close();
});

test('the same setup again changes nothing and says what is already guarded', async () => {
  const before = await stored();
  const page = await h.ctx.newPage();
  await page.goto(`${h.base}/cloud/agent-setup`);
  await page.fill('#onlyread-sites', 'gmail');
  await page.click('#onlyread-apply');
  await expect.poll(async () => (await posted(page)).find((m) => m.type === 'result')?.data).toMatchObject({ ok: true, added: [], already: ['Gmail'] });
  expect(await stored()).toEqual(before);
  await page.close();
});

test('two setups applied at once both land', async () => {
  const page = await h.ctx.newPage();
  await page.goto(`${h.base}/cloud/agent-setup`);
  await page.fill('#onlyread-sites', 'linear');
  await page.click('#onlyread-apply'); // the content script reads the field as it is clicked, then awaits the answer
  await page.fill('#onlyread-sites', 'linkedin');
  await page.click('#onlyread-apply');
  await expect.poll(async () => (await posted(page)).filter((m) => m.type === 'result').length).toBe(2);
  const p = await stored();
  expect(p.sites.linear?.enabled).toBe(true);
  expect(p.sites.linkedin?.enabled).toBe(true);
  expect(p.sites.gmail?.enabled).toBe(true); // and nothing from before is lost
  await page.close();
});

const linkCode = async () => ((await (await fetch(`${h.base}/cloud/__setup-link`, { method: 'POST' })).json()) as { code: string }).code;
const linkAnswer = async (page: Page) => {
  await expect.poll(async () => (await posted(page)).find((m) => m.type === 'link')?.data).toBeTruthy();
  return (await posted(page)).find((m) => m.type === 'link')!.data;
};

test('a setup link, just after install, signs in, guards every tab and refuses writes as the page loads, once', async () => {
  await h.sw.evaluate(() => (globalThis as unknown as { __onlyread: { releaseForTest: () => Promise<void> } }).__onlyread.releaseForTest());
  const code = await linkCode();
  const page = await h.ctx.newPage();
  await page.goto(`${h.base}/cloud/agent-setup#connect=${code}`);
  const r = await linkAnswer(page); // no click
  expect(r).toMatchObject({ ok: true, allTabs: true, mode: 'enforce' });
  expect(r.signedInAs).toBeTruthy();
  expect(r.needsClick).toBeUndefined();
  await expect.poll(() => new URL(page.url()).hash).toBe(''); // the code left the address
  expect((await h.sw.evaluate(() => chrome.storage.local.get('cloudTokens'))).cloudTokens).toBeDefined();
  expect((await stored()).judge.provider).toBe('cloud');
  await page.close();

  // The same link again, on a browser signed out meanwhile: refused, and no sign-in page either.
  await h.sw.evaluate(() => (globalThis as unknown as { __onlyread: { releaseForTest: () => Promise<void> } }).__onlyread.releaseForTest());
  const again = await h.ctx.newPage();
  await again.goto(`${h.base}/cloud/agent-setup#connect=${code}`);
  expect((await linkAnswer(again)).connectError).toContain('expired or was already used');
  expect(new URL(again.url()).pathname).toBe('/cloud/agent-setup');
  expect((await h.sw.evaluate(() => chrome.storage.local.get('cloudTokens'))).cloudTokens).toBeUndefined();
  await again.close();
});

test('a setup link on an older install waits for a real click on Connect; a click by the page does nothing', async () => {
  await h.sw.evaluate(() => chrome.storage.local.set({ installedAt: Date.now() - 2 * 60 * 60_000 }));
  await h.sw.evaluate(() => (globalThis as unknown as { __onlyread: { releaseForTest: () => Promise<void> } }).__onlyread.releaseForTest());
  const page = await h.ctx.newPage();
  await page.goto(`${h.base}/cloud/agent-setup#connect=${await linkCode()}`);
  expect(await linkAnswer(page)).toMatchObject({ ok: true, needsClick: true });
  await page.evaluate(() => document.getElementById('onlyread-connect')!.click()); // untrusted
  await page.waitForTimeout(800);
  expect((await h.sw.evaluate(() => chrome.storage.local.get('cloudTokens'))).cloudTokens).toBeUndefined();
  await page.click('#onlyread-connect');
  await expect.poll(async () => (await posted(page)).filter((m) => m.type === 'link').at(-1)?.data.signedInAs).toBeTruthy();
  expect((await h.sw.evaluate(() => chrome.storage.local.get('cloudTokens'))).cloudTokens).toBeDefined();
  await page.close();
});

test('the agent clicks its name: the browser reports it to the Pro service; a click by the page does nothing', async () => {
  const page = await h.ctx.newPage();
  await page.goto(`${h.base}/cloud/agent-setup`);
  await page.evaluate(() => (document.querySelector('[data-onlyread-agent]') as HTMLElement).click()); // untrusted
  await page.waitForTimeout(500);
  expect((await h.sw.evaluate(() => chrome.storage.local.get('agentName'))).agentName).toBeUndefined();
  await page.fill('#onlyread-agent-name', '  Sales\u0007   assistant  ');
  await page.click('[data-onlyread-agent="grok"]');
  await expect.poll(async () => (await posted(page)).find((m) => m.type === 'agent')?.data).toMatchObject({ ok: true, agent: 'grok', name: 'Sales assistant', signedIn: true });
  expect((await h.sw.evaluate(() => chrome.storage.local.get('agentName'))).agentName).toBe('grok');
  const mock = await (await fetch(`${h.base}/cloud/__mock`)).json() as { browserRaw?: string };
  expect(JSON.parse(mock.browserRaw ?? '{}')).toMatchObject({ agent: 'grok', name: 'Sales assistant' });
  await page.close();
});

test('while an agent works, the Pro account page cannot switch sites off or sign browsers out; adding still works', async () => {
  const page = await h.ctx.newPage();
  await page.goto(`${h.base}/cloud/agent-setup`);
  // Playwright's own session counts as an agent at work, so the lock is on.
  await expect.poll(async () => (await h.sw.evaluate(() => chrome.declarativeNetRequest.getSessionRules())).some((r) => r.id === 1905)).toBe(true);
  const post = (path: string) => page.evaluate(async (p) => {
    try { return (await fetch(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status; } catch { return 'refused'; }
  }, `/cloud${path}`);
  expect(await post('/account/sites/off')).toBe('refused');
  expect(await post('/account/browsers/signout')).toBe('refused');
  expect(await post('/account/sites/edit')).toBe(200);
  // A beacon carries the same POST, cookies and Origin, so it is refused too.
  expect(await page.evaluate((p) => navigator.sendBeacon(p, new Blob(['{}'], { type: 'application/json' })), '/cloud/account/sites/off')).toBe(true);
  await page.waitForTimeout(800);
  const hits = ((await (await fetch(`${h.base}/cloud/__mock`)).json()) as { accountHits: string[] }).accountHits;
  expect(hits).toEqual(['/account/sites/edit']);
  await page.close();
});

test('a browser a setup link set up belongs to an agent: it cannot sign out or undo here, until the account signs it out', async () => {
  // The browser the link test connected is marked.
  expect((await h.sw.evaluate(() => chrome.storage.local.get('agentBrowser'))).agentBrowser).toBeDefined();
  const options = await h.ctx.newPage();
  await options.goto(`chrome-extension://${new URL(h.sw.url()).host}/options.html`);
  const signOut = await options.evaluate(() => chrome.runtime.sendMessage({ type: 'cloud:signout' }).then((r) => JSON.stringify(r), (e: Error) => e.message));
  expect(signOut).toMatch(/belongs to an AI agent/);
  const undo = await options.evaluate(() => chrome.runtime.sendMessage({ type: 'agent-setup:undo' }).then((r) => JSON.stringify(r), (e: Error) => e.message));
  expect(undo).toMatch(/belongs to an AI agent/);
  // Managed from the account alone: adding is refused here too, and the page says so.
  const add = await options.evaluate(() => chrome.runtime.sendMessage({ type: 'site:add', host: 'news.example.com' }).then((r) => JSON.stringify(r), (e: Error) => e.message));
  expect(add).toMatch(/managed from your OnlyRead Pro account page/);
  await options.reload();
  await expect(options.locator('#lock-text')).toContainText('belongs to an AI agent');
  await expect(options.locator('#add')).toBeHidden();
  expect((await h.sw.evaluate(() => chrome.storage.local.get('cloudTokens'))).cloudTokens).toBeDefined();
  await options.close();

  // Signed out from the account page (elsewhere): the next refresh is refused and the browser is released.
  await fetch(`${h.base}/cloud/__mock`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ signOutAll: true }) });
  await expect.poll(async () => {
    await h.sw.evaluate(async () => { await (globalThis as unknown as { __onlyread: { syncManaged: () => Promise<unknown> } }).__onlyread.syncManaged().catch(() => undefined); });
    return (await h.sw.evaluate(() => chrome.storage.local.get('agentBrowser'))).agentBrowser;
  }, { timeout: 15_000 }).toBeUndefined();
});
