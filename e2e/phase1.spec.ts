// Phase 1 acceptance: debugger interception, fingerprints, rules fast path,
// UI-action context, worker coverage, webRequest observer, monitor vs enforce.
import { test, expect } from '@playwright/test';
import { Harness } from './helpers';

// Shared browser state across tests: stop at the first failure instead of cascading.
test.describe.configure({ mode: 'serial' });

const h = new Harness(4201);

test.beforeAll(async () => { await h.start({ mode: 'monitor', uploads: false, reviewBand: 'block' }); });
test.afterAll(async () => { await h.stop(); });

const fpOf = (entries: Awaited<ReturnType<typeof h.audit>>) => entries.filter((e) => e.kind === 'decision').map((e) => e.fingerprint);

test('debugger attaches to the fixture tab', async () => {
  await h.waitFor(async () => (await h.status()).attachedTabs >= 1, 'attached tab');
  expect((await h.status()).judge).toBe('rules-only');
});

test('monitor: gray-zone POST passes, is judged as review, carries fingerprint and the click that caused it', async () => {
  await h.page.click('button[data-req="POST /api/items"]');
  await expect(h.page.locator('#out')).toContainText('→ 201');
  await h.waitFor(async () => fpOf(await h.audit()).includes('POST localhost/api/items json:name'), 'audit entry');
  const e = (await h.audit()).find((x) => x.fingerprint === 'POST localhost/api/items json:name')!;
  expect(e).toMatchObject({ verdict: 'review', source: 'rules-only', reason: 'review-band:block', enforced: false, pWrite: 0.5 });
  expect(e.lastUiActions?.[0]).toMatchObject({ type: 'click', tag: 'button' });
  expect(e.lastUiActions?.[0]?.name).toContain('POST /api/items (create)');
});

test('monitor: GET and telemetry are allowed by rule without judging', async () => {
  expect(await h.pageFetch('GET', '/api/items')).toBe('status:200');
  expect(await h.pageFetch('POST', '/collect', '{"e":1}')).toBe('status:204');
  await h.waitFor(async () => (await h.audit()).some((e) => e.reason === 'telemetry'), 'telemetry entry');
  const a = await h.audit();
  expect(a.find((e) => e.fingerprint === 'GET localhost/api/items none')).toMatchObject({ verdict: 'allow', source: 'rule', reason: 'safe-method' });
  expect(a.find((e) => e.reason === 'telemetry')).toMatchObject({ verdict: 'allow', method: 'POST' });
});

test('the initial document request predates attach: absent from decisions, present in observations', async () => {
  // This is the "before-attach" coverage bucket. Layer 0 (DNR) still covers it for mutating methods.
  const decisions = await h.audit();
  expect(decisions.find((e) => e.kind === 'decision' && e.method === 'GET' && new URL(e.url).pathname === '/')).toBeUndefined();
  await h.waitFor(async () => (await h.observations()).some((o) => o.method === 'GET' && new URL(o.url).pathname === '/'), 'document observation');
});

test('monitor: GraphQL fingerprints separate query, mutation and mixed batch', async () => {
  expect(await h.pageFetch('POST', '/graphql', '{"query":"query { items { id } }"}')).toBe('status:200');
  expect(await h.pageFetch('POST', '/graphql', '{"operationName":"Create","query":"mutation Create { createItem { id } }","variables":{"name":"m"}}')).toBe('status:200');
  expect(await h.pageFetch('POST', '/graphql', '[{"query":"{ items { id } }"},{"query":"mutation { createItem { id } }"}]')).toBe('status:200');
  await h.waitFor(async () => fpOf(await h.audit()).includes('POST localhost/graphql gql[]:query,mutation'), 'batch fingerprint');
  const fps = fpOf(await h.audit());
  expect(fps).toEqual(expect.arrayContaining(['POST localhost/graphql gql:query:-', 'POST localhost/graphql gql:mutation:Create', 'POST localhost/graphql gql[]:query,mutation']));
});

test('monitor: a dedicated worker request is intercepted too', async () => {
  expect(await h.workerFetch('POST', '/rpc', '{"op":"list"}')).toBe('status:200');
  await h.waitFor(async () => fpOf(await h.audit()).includes('POST localhost/rpc json:op;op=list'), 'worker fingerprint');
});

test('monitor: file inputs stay enabled (a read pass needs the upload sent so it can be labeled)', async () => {
  await h.page.waitForTimeout(300); // the content script's guard answer
  expect(await h.page.evaluate(() => document.querySelector<HTMLInputElement>('input[type=file]')?.disabled)).toBe(false);
});

test('observer recorded every target request the browser attempted', async () => {
  const expected = ['GET /', 'GET /api/items', 'POST /api/items', 'POST /graphql', 'POST /rpc', 'POST /collect', 'GET /worker.js'];
  const seen = async () => (await h.observations()).map((o) => `${o.method} ${new URL(o.url).pathname}`);
  // Observations flush on a short debounce; wait for the full set rather than a count.
  await h.waitFor(async () => { const s = await seen(); return expected.every((e) => s.includes(e)); }, 'all observations flushed');
  const obs = await h.observations();
  expect(obs.filter((o) => o.url.includes('/api/items')).some((o) => o.outcome === 'completed')).toBe(true);
});

test.describe('enforce mode', () => {
  test.beforeAll(async () => {
    // Switching modes reloads the guarded tab (index.ts, onPolicyChange): wait for that reload to finish,
    // or the first fetch can run in a page that is being replaced.
    await h.page.evaluate(() => { (window as unknown as { __beforeSwitch?: boolean }).__beforeSwitch = true; });
    await h.setPolicy({ mode: 'enforce' });
    await h.waitFor(async () => (await h.status()).mode === 'enforce', 'enforce mode');
    await h.waitFor(async () => {
      try { return !(await h.page.evaluate(() => (window as unknown as { __beforeSwitch?: boolean }).__beforeSwitch)) && (await h.page.evaluate(() => document.readyState)) === 'complete'; }
      catch { return false; }
    }, 'guarded tab reloaded');
    await h.reset();
  });

  test('gray-zone POST is failed and never reaches the server', async () => {
    expect(await h.pageFetch('POST', '/api/items', '{"name":"blocked"}')).toMatch(/^error:/);
    const log = await h.serverLog();
    expect(log.filter((e) => e.method === 'POST' && e.path === '/api/items')).toEqual([]);
    await h.waitFor(async () => (await h.audit()).some((e) => e.fingerprint === 'POST localhost/api/items json:name' && e.enforced), 'enforced entry');
  });

  test('reads, telemetry and the page itself still pass', async () => {
    expect(await h.pageFetch('GET', '/api/items')).toBe('status:200');
    expect(await h.pageFetch('POST', '/collect', '{"e":2}')).toBe('status:204');
    await h.page.reload();
    await expect(h.page.locator('h1')).toContainText('OnlyRead fixture');
  });

  test('multipart upload is failed by rule', async () => {
    const out = await h.page.evaluate(async () => {
      const fd = new FormData(); fd.append('file', new Blob(['hello']), 'a.txt');
      try { const r = await fetch('/upload', { method: 'POST', body: fd }); return `status:${r.status}`; } catch (e) { return `error:${(e as Error).name}`; }
    });
    expect(out).toMatch(/^error:/);
    await h.waitFor(async () => (await h.audit()).some((e) => e.reason === 'upload' && e.enforced), 'upload entry');
    expect((await h.serverLog()).filter((e) => e.path === '/upload')).toEqual([]);
  });

  test('file inputs are disabled when uploads are off', async () => {
    await expect.poll(() => h.page.evaluate(() => document.querySelector<HTMLInputElement>('input[type=file]')?.disabled)).toBe(true);
  });

  test('writes a page sends as its tab closes (keepalive, beacon) never reach the server', async () => {
    // Sent after the tab's debugger session ends, so never judged: the content script stops the page's own close
    // handlers, beacons are refused by rule, and the closing tab's writes are refused by rule as a backstop.
    for (const runBeforeUnload of [false, true]) {
      const p = await h.ctx.newPage();
      await p.goto(`${h.base}/`);
      await h.waitFor(async () => (await h.sw.evaluate(async () => (await chrome.tabs.query({})).length)) > 0, 'tab');
      await p.waitForTimeout(300); // the content script's guard answer
      await p.evaluate(() => {
        const send = (op: string) => void fetch('/rpc', { method: 'POST', keepalive: true, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op }) });
        addEventListener('pagehide', () => { send('pagehide'); navigator.sendBeacon('/rpc', '{"op":"beacon"}'); });
        document.addEventListener('visibilitychange', () => send('visibilitychange'));
        addEventListener('unload', () => send('unload'));
      });
      await p.close({ runBeforeUnload });
    }
    await new Promise((r) => setTimeout(r, 1000));
    expect((await h.serverLog()).filter((e) => e.path === '/rpc')).toEqual([]);
  });

  test('writes a page sends as its tab leaves for another site never reach the server', async () => {
    // Chrome unloads the old page after the new one committed, and the old page's closing report does not reach the
    // background: stopping the page's own close handlers is the whole defence here, with no closing-tab rule as a
    // backstop (closing-tabs.ts). The new page is judged as itself: the rule names no tab once it has committed.
    const p = await h.ctx.newPage();
    await p.goto(`${h.base}/`);
    await p.waitForTimeout(300); // the content script's guard answer
    await p.evaluate(() => {
      const send = (op: string) => void fetch('/rpc', { method: 'POST', keepalive: true, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op }) });
      addEventListener('pagehide', () => { send('pagehide'); navigator.sendBeacon('/rpc', '{"op":"beacon"}'); });
      document.addEventListener('visibilitychange', () => send('visibilitychange'));
      addEventListener('unload', () => send('unload'));
    });
    await p.goto(`http://127.0.0.1:${h.port}/`);
    await new Promise((r) => setTimeout(r, 1000));
    expect((await h.serverLog()).filter((e) => e.path === '/rpc')).toEqual([]);
    // (Tabs the test before closed stay named for the grace period, so look for this one, not for an empty rule.)
    const closingTabRule = 1904; // rules.ts CLOSING_TAB_RULE_ID (RULE_ID_BASE + 904)
    const [tabId, named] = await h.sw.evaluate(async ({ id, url }) => [
      (await chrome.tabs.query({ url }))[0]?.id,
      (await chrome.declarativeNetRequest.getSessionRules()).find((r) => r.id === id)?.condition.tabIds ?? [],
    ] as const, { id: closingTabRule, url: `http://127.0.0.1:${h.port}/*` });
    expect(tabId).toBeDefined();
    expect(named).not.toContain(tabId);
    await p.close();
  });

  test('worker POST is failed', async () => {
    expect(await h.workerFetch('POST', '/rpc', '{"op":"create","name":"w"}')).toMatch(/^error:/);
    expect((await h.serverLog()).filter((e) => e.path === '/rpc')).toEqual([]);
  });

  // An extension page (a settings page driven by a debugger) shares the background's initiator; it
  // must not share its exemption. The background's own POSTs (the dev sink) still go out.
  test('a write from an OnlyRead extension page to a guarded host is refused; the background\'s own requests pass', async () => {
    const id = new URL(h.sw.url()).host;
    const options = await h.ctx.newPage();
    await options.goto(`chrome-extension://${id}/options.html`);
    await h.reset();
    const fromPage = (method: string, path: string, body?: string) => options.evaluate(async ({ method, url, body }) => {
      try { const r = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body }); return `status:${r.status}`; } catch (e) { return `error:${(e as Error).name}`; }
    }, { method, url: `${h.base}${path}`, body });
    expect(await fromPage('PUT', '/api/items/1', '{"name":"from-options"}')).toMatch(/^error:/);
    expect(await fromPage('DELETE', '/api/items/1')).toMatch(/^error:/);
    expect(await fromPage('POST', '/api/items', '{"name":"from-options"}')).toMatch(/^error:/);
    expect(await fromPage('GET', '/api/items')).toBe('status:200');
    const log = await h.serverLog();
    expect(log.filter((e) => e.method !== 'GET' && e.path.startsWith('/api/items'))).toEqual([]);
    await h.waitFor(async () => (await h.audit()).some((e) => e.reason === 'extension-page' && e.method === 'PUT'), 'extension-page refusal logged');
    // The dev sink's own batches (the background, no tab) are not refused: none is logged as a refusal.
    expect((await h.audit()).filter((e) => e.kind === 'decision' && e.url.includes('/__audit'))).toEqual([]);
    await options.close();
  });

  test('a service worker the debugger holds is judged, not fenced: reads pass, writes are refused, each decided once', async () => {
    const sw = await h.ctx.newPage();
    await sw.goto(`${h.base}/sw-page.html`);
    await sw.evaluate(() => (window as unknown as { swReady: Promise<boolean> }).swReady);
    const second = await h.ctx.newPage(); // a second tab holds the same worker too
    await second.goto(`${h.base}/sw-page.html`);
    await second.evaluate(() => (window as unknown as { swReady: Promise<boolean> }).swReady);
    await h.waitFor(async () => (await h.sw.evaluate(async () => (await chrome.declarativeNetRequest.getSessionRules()).some((r) => r.condition.excludedInitiatorDomains?.includes('localhost')))), 'worker judged, not fenced');
    const viaWorker = (body: string, url = '/rpc') => sw.evaluate(({ b, u }) => (window as unknown as { swFetch: (m: string, u: string, b: string) => Promise<string> }).swFetch('POST', u, b), { b: body, u: url });
    expect(await viaWorker('{"e":"sw"}', '/collect')).toBe('status:204'); // telemetry: allowed by rule
    expect(await viaWorker('{"op":"create","name":"sw"}')).toMatch(/^error:/); // gray zone: refused by the judge path
    const log = await h.serverLog();
    expect(log.filter((e) => e.path === '/collect' && e.body === '{"e":"sw"}')).toHaveLength(1);
    expect(log.filter((e) => e.path === '/rpc')).toEqual([]);
    await h.waitFor(async () => (await h.audit()).some((e) => e.kind === 'decision' && e.url.endsWith('/rpc') && e.source !== 'dnr' && e.enforced), 'judged worker write');
    // Two tabs hold the worker, so the request paused in both sessions: one decision, not two.
    const fromWorker = (await h.audit()).filter((e) => e.kind === 'decision' && e.url.endsWith('/collect') && (e as unknown as { bodyPreview?: string }).bodyPreview === '{"e":"sw"}');
    expect(fromWorker).toHaveLength(1);
    await second.close();
    await sw.close();
  });

  test('observer still saw the failed attempts', async () => {
    await h.waitFor(async () => (await h.observations()).some((o) => o.url.endsWith('/upload')), 'upload observation');
    const obs = await h.observations();
    const blocked = obs.filter((o) => o.url.endsWith('/upload') || (o.method === 'POST' && o.url.endsWith('/api/items')));
    expect(blocked.length).toBeGreaterThan(0);
  });

  test('server state is unchanged: only the monitor-phase writes exist', async () => {
    const state = (await (await fetch(`${h.base}/__state`)).json()) as Array<{ id: number; name: string }>;
    expect(state.map((s) => s.name)).not.toContain('blocked');
    expect(state.map((s) => s.name)).not.toContain('w');
  });
});

test.describe('extension UI', () => {
  test('popup renders the protection switch, the current page and the status line', async () => {
    const id = new URL(h.sw.url()).host;
    const popup = await h.ctx.newPage();
    const errors: string[] = [];
    popup.on('pageerror', (e) => errors.push(e.message));
    await popup.goto(`chrome-extension://${id}/popup.html`);
    await expect(popup.locator('#mode')).toBeChecked();
    await expect(popup.locator('#foot-left')).not.toHaveText('…');
    await expect(popup.locator('#current .site, #current .empty').first()).toBeVisible();
    await expect(popup.locator('#current')).not.toHaveText('…');
    expect(errors).toEqual([]);
    await popup.close();
  });

  test('options page shows the live protection state', async () => {
    const id = new URL(h.sw.url()).host;
    const options = await h.ctx.newPage();
    await options.goto(`chrome-extension://${id}/options.html`);
    await expect(options.locator('#enabled')).toBeChecked();
    await expect(options.locator('#when input[value="always"]')).toBeChecked();
    await expect(options.locator('#monitor')).not.toBeChecked(); // enforce
    await options.close();
  });

  // Playwright drives this browser over CDP, so it is an agent to OnlyRead: the extension pages it opens are
  // tabs with a debugger OnlyRead did not attach. The settings lock is therefore on for these pages, which
  // tests it against a real CDP client rather than a declared session.
  test('a CDP-driven page is detected as an agent and locks every change that lowers protection', async () => {
    const id = new URL(h.sw.url()).host;
    const options = await h.ctx.newPage();
    await options.goto(`chrome-extension://${id}/options.html`);
    const msg = (m: unknown) => options.evaluate((m) => chrome.runtime.sendMessage(m), m) as Promise<{ ok?: boolean; error?: string }>;
    await expect(options.locator('#lock')).toContainText('An AI agent is active');
    await expect(options.locator('#enabled')).toBeDisabled();
    await expect(options.locator('.site-row .icon-btn.danger').first()).toBeDisabled(); // a site's remove button
    expect((await msg({ type: 'guard:set', enabled: false })).error).toMatch(/^locked:agent:.*turn protection off/);
    expect((await msg({ type: 'guard:set', attachWhen: 'agent-session' })).error).toMatch(/^locked:agent:/);
    expect((await msg({ type: 'cache:clear' })).error).toMatch(/^locked:agent:.*tested verdicts/);
    // An agent cannot set a PIN the person does not know.
    expect((await msg({ type: 'pin:set', pin: '482913' })).error).toMatch(/^locked:agent:.*set a PIN/);
    // Writing the policy into storage around the background does not work either: it is put back.
    await options.evaluate(async () => {
      const { policy } = await chrome.storage.local.get('policy');
      await chrome.storage.local.set({ policy: { ...(policy as object), enabled: false } });
    });
    await h.waitFor(async () => ((await h.sw.evaluate(() => chrome.storage.local.get('policy'))).policy as { enabled?: boolean } | undefined)?.enabled === true, 'policy put back');
    const { policy } = await h.sw.evaluate(() => chrome.storage.local.get('policy'));
    expect(policy).toMatchObject({ enabled: true, attachWhen: 'always' });
    await options.close();
  });
});
