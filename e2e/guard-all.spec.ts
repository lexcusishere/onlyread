// Guard every site: with no site listed, the fixture's host is guarded once everything is, its writes are
// refused in enforce; an allowed host is left alone; switching it on is open while an agent works, allowing a host is
// not; and OnlyRead's own requests from its background are not caught by the rules that now cover every host.
import { test, expect } from '@playwright/test';
import { Harness } from './helpers';

test.describe.configure({ mode: 'serial' });

const h = new Harness(4246);
const optionsUrl = () => `chrome-extension://${new URL(h.sw.url()).host}/options.html`;

test.beforeAll(async () => {
  await h.start({ mode: 'enforce', reviewBand: 'block' });
  // The harness starts with the fixture listed; here no site is. Its Pro service is elsewhere: OnlyRead's own service
  // is never guarded by guarding everything, and the development one is on localhost too.
  await h.setPolicy({ customSites: [], cloud: { serviceUrl: 'https://pro.example', timeoutMs: 8000 } });
  await h.page.reload();
});
test.afterAll(async () => { await h.stop(); });

test('with no site listed and guarding everything off, the fixture is not guarded', async () => {
  await h.reset();
  expect(await h.pageFetch('POST', '/api/items', '{"name":"free"}')).toBe('status:201');
});

test('guarding everything takes in the unlisted fixture: its gray-zone write is refused and never arrives', async () => {
  const options = await h.ctx.newPage();
  await options.goto(optionsUrl());
  // Raising protection is open while an agent works (Playwright's session counts as one).
  const on = await options.evaluate(() => chrome.runtime.sendMessage({ type: 'guard-all:set', on: true }));
  expect(on).toMatchObject({ guardAll: true, effective: { guardAll: true } });
  // Allowing a host lowers protection: locked while the agent works.
  const allow = await options.evaluate(() => chrome.runtime.sendMessage({ type: 'exclude:add', host: 'localhost' }));
  expect(JSON.stringify(allow)).toMatch(/AI agent is active/);
  await options.close();

  await h.page.reload();
  await h.waitFor(async () => (await h.status()).attachedTabs >= 1, 'attached tab');
  await h.reset();
  expect(await h.pageFetch('POST', '/api/items', '{"name":"blocked"}')).toMatch(/^error:/);
  expect(await h.pageFetch('PUT', '/api/items/1', '{"name":"blocked"}')).toMatch(/^error:/);
  expect((await h.serverLog()).filter((e) => e.method !== 'GET')).toEqual([]);
  expect(await h.pageFetch('GET', '/api/items')).toBe('status:200');
});

test("with everything guarded, an unlisted host's socket is refused too", async () => {
  await h.reset();
  const r = await h.page.evaluate(() => new Promise<string>((done) => {
    const ws = new WebSocket(`ws://${location.host}/ws`);
    ws.onopen = () => done('open'); ws.onerror = () => done('error'); ws.onclose = () => done('closed');
  }));
  expect(r).not.toBe('open');
  expect((await h.serverLog()).filter((e) => e.method === 'WS')).toEqual([]);
});

test('with everything guarded, a form posting into a new tab is refused before any debugger holds the tab', async () => {
  await h.reset();
  const before = h.ctx.pages().length;
  await h.page.evaluate(() => {
    const f = document.createElement('form'); f.method = 'post'; f.action = '/api/items'; f.target = '_blank';
    const i = document.createElement('input'); i.name = 'name'; i.value = 'new-tab'; f.append(i);
    document.body.append(f); f.submit();
  });
  await h.page.waitForTimeout(1500);
  expect((await h.serverLog()).filter((e) => e.method === 'POST')).toEqual([]);
  for (const p of h.ctx.pages().slice(before)) await p.close();
});

test("OnlyRead's own background requests are not caught by the rules that now cover every host", async () => {
  await h.reset();
  const r = await h.sw.evaluate(async (base) => {
    try { return `status:${(await fetch(`${base}/api/items`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"name":"own"}' })).status}`; } catch (e) { return `error:${(e as Error).message}`; }
  }, h.base);
  expect(r).toBe('status:201');
});

test('an allowed host is left alone, and the rest stay guarded', async () => {
  await h.setPolicy({ guardAll: true, excludeSites: ['localhost'] });
  await h.reset();
  expect(await h.pageFetch('POST', '/api/items', '{"name":"allowed"}')).toBe('status:201');
  // 127.0.0.1 is the same fixture under a host that is not allowed.
  const other = await h.ctx.newPage();
  await other.goto(h.base.replace('localhost', '127.0.0.1'));
  await h.waitFor(async () => (await h.status()).attachedTabs >= 2, 'second tab attached');
  const r = await other.evaluate(async () => { try { return `status:${(await fetch('/api/items', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"name":"x"}' })).status}`; } catch (e) { return `error:${(e as Error).name}`; } });
  expect(r).toMatch(/^error:/);
  await other.close();
});

test('an allowed child under a listed site stays guarded: no socket, no form into a new tab', async () => {
  // localhost is listed as a site of its own; child.localhost (loopback too) is allowed. The listed site wins.
  await h.setPolicy({ guardAll: true, excludeSites: ['child.localhost'], customSites: [{ id: 'parent', name: 'Parent', domains: ['localhost'], enabled: true }] });
  await h.page.reload();
  await h.waitFor(async () => (await h.status()).attachedTabs >= 1, 'attached tab');
  await h.reset();
  const port = new URL(h.base).port;
  const ws = await h.page.evaluate((p) => new Promise<string>((done) => {
    const s = new WebSocket(`ws://child.localhost:${p}/ws`);
    s.onopen = () => done('open'); s.onerror = () => done('error'); s.onclose = () => done('closed');
  }), port);
  expect(ws).not.toBe('open');
  const before = h.ctx.pages().length;
  await h.page.evaluate((p) => {
    const f = document.createElement('form'); f.method = 'post'; f.action = `http://child.localhost:${p}/api/items`; f.target = '_blank';
    const i = document.createElement('input'); i.name = 'name'; i.value = 'child'; f.append(i); document.body.append(f); f.submit();
  }, port);
  await h.page.waitForTimeout(1500);
  expect((await h.serverLog()).filter((e) => e.method === 'POST' || e.method === 'WS')).toEqual([]);
  for (const p of h.ctx.pages().slice(before)) await p.close();
  await h.setPolicy({ guardAll: false, excludeSites: [], customSites: [] });
});

test('the Pro account can guard every site: a host this browser allows is no exception, and an allowance from the account waits while an agent works', async () => {
  await h.signInToMock(); // the mock service is on localhost, which is therefore exempt: the guarded page is 127.0.0.1
  await h.setPolicy({ guardAll: false, excludeSites: [] });
  await h.mock({ reset: true });
  await h.signInToMock();
  await h.mock({ status: 'active', managed: { enabled: true, sites: {}, customSites: [], guardAll: { on: true, excludeSites: ['example.org'] } } });
  const sync = () => h.sw.evaluate(async () => { await (globalThis as unknown as { __onlyread: { syncManaged: () => Promise<unknown> } }).__onlyread.syncManaged(); });
  const eff = async () => (await h.sw.evaluate(async () => ((await chrome.storage.local.get('policy')).policy as { effective: unknown }).effective)) as { guardAll: boolean; excludeDomains: string[] };
  await sync();
  await expect.poll(eff).toMatchObject({ guardAll: true, excludeDomains: ['example.org'] });

  const other = await h.ctx.newPage();
  await other.goto(h.base.replace('localhost', '127.0.0.1'));
  await h.waitFor(async () => (await h.status()).attachedTabs >= 2, 'tab attached');
  const post = () => other.evaluate(async () => { try { return `status:${(await fetch('/api/items', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"name":"x"}' })).status}`; } catch (e) { return `error:${(e as Error).name}`; } });
  expect(await post()).toMatch(/^error:/);

  // This browser allows the host: the account still guards it.
  await h.setPolicy({ guardAll: true, excludeSites: ['127.0.0.1'] });
  expect((await eff()).excludeDomains).toEqual([]);
  expect(await post()).toMatch(/^error:/);

  // The account allows it too: that lowers protection, so it waits while the agent (Playwright) works.
  await h.mock({ managed: { enabled: true, sites: {}, customSites: [], guardAll: { on: true, excludeSites: ['example.org', '127.0.0.1'] } } });
  await sync();
  expect((await eff()).excludeDomains).toEqual([]);
  expect((await h.status()).managedPending).toMatch(/exclude 127\.0\.0\.1/);
  expect(await post()).toMatch(/^error:/);
  await other.close();
});

test('the account page can guard a site in this browser alone', async () => {
  // The account's guard-everything as in force, so that the only change is the added site (a raise, applied at once).
  await h.mock({ managed: { enabled: true, sites: {}, customSites: [], guardAll: { on: true, excludeSites: ['example.org'] }, browserSites: { sites: {}, customSites: [{ id: 'crm.example.com', name: 'CRM', domains: ['crm.example.com'], enabled: true }] } } });
  await h.sw.evaluate(async () => { await (globalThis as unknown as { __onlyread: { syncManaged: () => Promise<unknown> } }).__onlyread.syncManaged(); });
  const eff = async () => ((await h.sw.evaluate(async () => ((await chrome.storage.local.get('policy')).policy as { effective: unknown }).effective)) as { targetDomains: string[] });
  await expect.poll(async () => (await eff()).targetDomains).toContain('crm.example.com');
});
