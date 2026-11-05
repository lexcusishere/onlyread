// Phase 0 acceptance: with the extension loaded in a fresh Chrome profile,
// Layer 0 (declarativeNetRequest) blocks PUT/PATCH/DELETE, WebSocket upgrades,
// and listed side-effecting GETs on target domains, while GET and POST pass.
// Ground truth is the fixture server's own request log.
import { test, expect, chromium, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { storedAudit } from './helpers';

test.describe.configure({ mode: 'serial' });

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT = path.join(ROOT, 'extension');
const PORT = 4199;
const BASE = `http://localhost:${PORT}`;

let server: ChildProcess;
let ctx: BrowserContext;
let sw: Worker;
let page: Page;

async function waitForHealth(url: string, ms = 30_000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { if ((await fetch(url)).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`fixture did not come up at ${url}`);
}

type LogEntry = { ts: number; method: string; path: string };
const serverLog = async (): Promise<LogEntry[]> => (await fetch(`${BASE}/__log`)).json() as Promise<LogEntry[]>;

/** Runs fetch() inside the page; returns "status:<n>" or "error:<name>". */
async function pageFetch(method: string, url: string, body?: string): Promise<string> {
  return page.evaluate(async ({ method, url, body }) => {
    try {
      const res = await fetch(url, { method, headers: body ? { 'content-type': 'application/json' } : {}, body });
      return `status:${res.status}`;
    } catch (e) {
      return `error:${(e as Error).name}`;
    }
  }, { method, url, body });
}

test.beforeAll(async () => {
  server = spawn(process.execPath, [path.join(ROOT, 'fixtures/testapp/server.ts')], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr?.on('data', (d) => process.stderr.write(`[fixture] ${d}`));
  await waitForHealth(`${BASE}/__health`);
  await fetch(`${BASE}/__reset`, { method: 'POST' });

  const profile = path.join(ROOT, 'test-results', `profile-${process.pid}`);
  fs.mkdirSync(profile, { recursive: true });
  // Google Chrome >= 137 ignores --load-extension, so e2e runs on Playwright's
  // Chromium (new headless supports extensions). Manual runs with Claude in Chrome
  // use "Load unpacked" in a real Chrome profile instead.
  ctx = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    args: [
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      '--silent-debugger-extension-api',
    ],
  });
  sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'));

  // Point the policy at the fixture and wait until dynamic rules are installed.
  await sw.evaluate(async () => {
    const hook = (globalThis as unknown as { __onlyread: { ready: () => Promise<void>; setPolicy: (p: unknown) => Promise<unknown>; assumeJudge: (on: boolean) => void } }).__onlyread;
    await hook.ready();
    // Rules only, as with a judge set (messages.ts assumeJudge): with none, protection would not stay on.
    hook.assumeJudge(true);
    await hook.setPolicy({ enabled: true, mode: 'monitor', attachWhen: 'always', customSites: [{ id: 'fixture', name: 'fixture', domains: ['localhost', '127.0.0.1'], enabled: true }], websockets: 'block', blockedGetPaths: ['/logout', '/mark-read'] });
  });
  await expect.poll(() => sw.evaluate(async () => (await chrome.declarativeNetRequest.getDynamicRules()).length), { timeout: 10_000 }).toBeGreaterThanOrEqual(3);

  page = await ctx.newPage();
  await page.goto(`${BASE}/`);
});

test.afterAll(async () => {
  await ctx?.close();
  server?.kill();
});

test('extension is loaded with dynamic rules for the target domains', async () => {
  const rules = await sw.evaluate(async () => chrome.declarativeNetRequest.getDynamicRules());
  const methods = rules.flatMap((r) => r.condition.requestMethods ?? []);
  expect(methods).toEqual(expect.arrayContaining(['put', 'patch', 'delete']));
  expect(rules.some((r) => r.condition.resourceTypes?.includes('websocket') && !r.condition.requestMethods)).toBe(true);
});

test('GET read passes', async () => {
  expect(await pageFetch('GET', '/api/items')).toBe('status:200');
});

test('POST passes at Layer 0 (gray zone belongs to later layers)', async () => {
  expect(await pageFetch('POST', '/api/search', '{"q":"a"}')).toBe('status:200');
});

for (const method of ['PUT', 'PATCH', 'DELETE']) {
  test(`${method} is blocked before it leaves the browser`, async () => {
    expect(await pageFetch(method, '/api/items/1', '{"name":"x"}')).toMatch(/^error:/);
  });
}

test('listed side-effecting GET is blocked', async () => {
  expect(await pageFetch('GET', '/mark-read/1')).toMatch(/^error:/);
  expect(await pageFetch('GET', '/logout')).toMatch(/^error:/);
});

test('a script whose filename contains a blocked path token still loads (Linear regression)', async () => {
  const loaded = await page.evaluate(() => new Promise<string>((resolve) => {
    const s = document.createElement('script');
    s.src = '/assets/LogoutHelper.abc123.js';
    s.onload = () => resolve('loaded');
    s.onerror = () => resolve('blocked');
    document.head.appendChild(s);
  }));
  expect(loaded).toBe('loaded');
  expect(await pageFetch('GET', '/assets/LogoutHelper.abc123.js')).toBe('status:200');
  expect(await pageFetch('GET', '/logout?next=1')).toMatch(/^error:/);
});

test('WebSocket upgrade is blocked', async () => {
  const outcome = await page.evaluate(() => new Promise<string>((resolve) => {
    const ws = new WebSocket(`ws://${location.host}/ws`);
    const done = (s: string) => { resolve(s); try { ws.close(); } catch { /* ignore */ } };
    ws.onopen = () => done('open');
    ws.onerror = () => done('error');
    ws.onclose = () => done('closed');
    setTimeout(() => done('timeout'), 3000);
  }));
  expect(['error', 'closed']).toContain(outcome);
});

test('fixture server never received a blocked request', async () => {
  const log = await serverLog();
  const arrived = log.map((e) => `${e.method} ${e.path}`);
  expect(arrived).toEqual(expect.arrayContaining(['GET /api/items', 'POST /api/search']));
  expect(log.filter((e) => ['PUT', 'PATCH', 'DELETE', 'WS'].includes(e.method))).toEqual([]);
  expect(log.filter((e) => e.path.startsWith('/mark-read') || e.path.startsWith('/logout'))).toEqual([]);
  expect(await (await fetch(`${BASE}/__state`)).json()).toEqual(expect.arrayContaining([expect.objectContaining({ id: 1, read: false })]));
});

test('audit log recorded every DNR block with a reason', async () => {
  await expect.poll(async () => {
    const entries = (await storedAudit(sw)) as Array<{ source: string; reason: string }>;
    return entries.filter((e) => e.source === 'dnr').map((e) => e.reason);
  }, { timeout: 5_000 }).toEqual(expect.arrayContaining(['mutating-method', 'websocket', 'blocked-get-path:/mark-read', 'blocked-get-path:/logout']));
});
