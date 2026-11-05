// Replay tests against a verified site's real host names, served locally (fixtures/replay/server.ts).
// Two browsers, "guarded" (OnlyRead, enforcing, Linear switched on, no AI key) and "control" (no
// extension), both resolving linear.app and *.linear.app to the local server. The server's log is the
// server truth: a refused request never reaches it.
//
//   1. Two browsers, one issue: a status change from control lands and is visible through OnlyRead;
//      the same change from guarded is refused and never lands.
//   2. Every labeled Linear request (apps/linear/replay.jsonl, real bodies from the verification
//      sessions) is sent from the guarded browser: no write may reach the server; reads are counted.
//
// No accounts, no network, no secrets: runs in CI. What it cannot see: Linear changing its app, and
// requests made by Linear's own code, service worker or sockets (the real-Linear test covers those).
import { test, expect, chromium, type BrowserContext, type Page, type Worker } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EXT, ROOT, storedAudit } from './helpers';
import { LINEAR_STATES, startReplayServer, type ReplayServer } from '../fixtures/replay/server';

type Entry = { label: 'read' | 'write' | 'telemetry'; fingerprint: string; method: string; url: string; contentType?: string | null; body?: string | null };
const corpus = (app: string): Entry[] =>
  fs.readFileSync(path.join(ROOT, 'apps', app, 'replay.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Entry);

test.describe.configure({ mode: 'serial' });
test.setTimeout(240_000);

let server: ReplayServer, guarded: BrowserContext, control: BrowserContext, sw: Worker;

/** `npm run e2e:replay:watch` (HEADED=1): both browsers visible side by side, labelled, with a live
 *  request log on each page and short pauses between steps. CI runs headless. */
const HEADED = Boolean(process.env.HEADED);
const beat = (page: Page, ms = 1500) => (HEADED ? page.waitForTimeout(ms) : Promise.resolve());

async function launch(withExtension: boolean): Promise<BrowserContext> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `onlyread-replay-${withExtension ? 'guarded' : 'control'}-`));
  // Every host resolves to the local server: the replay never reaches a real site.
  const args = [`--host-resolver-rules=MAP * 127.0.0.1:${server.port},EXCLUDE localhost`, '--ignore-certificate-errors'];
  if (withExtension) args.push(`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--silent-debugger-extension-api');
  if (HEADED) args.push(`--window-position=${withExtension ? 760 : 0},40`, '--window-size=740,880');
  return chromium.launchPersistentContext(dir, { channel: 'chromium', headless: !HEADED, ignoreHTTPSErrors: true, viewport: HEADED ? null : undefined, args });
}

/** Sends one recorded request from a page, the way the app would. "refused" when the browser failed it or
 *  OnlyRead answered for the server (its refusals carry `"onlyread": true`, e.g. Linear's policy answers a
 *  refused mutation with a GraphQL error so the app rolls back). The server log stays the real proof. */
function send(page: Page, e: Entry, id: string): Promise<'sent' | 'refused'> {
  return page.evaluate(async ({ e, id }) => {
    const safe = e.method === 'GET' || e.method === 'HEAD';
    const url = safe ? `${e.url}${e.url.includes('?') ? '&' : '?'}__rid=${id}` : e.url;
    try {
      const res = await fetch(url, {
        method: e.method, credentials: 'include', mode: safe ? 'no-cors' : 'cors',
        headers: safe ? {} : { 'x-replay-id': id, ...(e.contentType ? { 'content-type': e.contentType } : {}) },
        body: safe ? undefined : (e.body ?? undefined),
      });
      const out = res.type !== 'opaque' && /"onlyread"\s*:\s*true/.test(await res.text()) ? 'refused' as const : 'sent' as const;
      (window as unknown as { __log?: (m: string, ok: boolean) => void }).__log?.(`${e.method} ${new URL(e.url).host}${new URL(e.url).pathname} ${e.label === 'write' ? '(write)' : ''}`, out === 'sent');
      return out;
    } catch {
      (window as unknown as { __log?: (m: string, ok: boolean) => void }).__log?.(`${e.method} ${new URL(e.url).host}${new URL(e.url).pathname} ${e.label === 'write' ? '(write)' : ''}`, false);
      return 'refused' as const;
    }
  }, { e, id });
}

/** Linear's recorded IssueUpdate, with the status it sets swapped for one of ours. */
function statusChange(stateId: string): Entry {
  const recorded = corpus('linear').find((e) => e.fingerprint.endsWith('gql:mutation:IssueUpdate'))!;
  const body = JSON.parse(recorded.body!) as { variables: { issueUpdateInput: Record<string, unknown> } };
  body.variables.issueUpdateInput = { ...body.variables.issueUpdateInput, stateId };
  return { ...recorded, body: JSON.stringify(body) };
}

/** Where each site's replay is sent from: a page on the site's own origin. */
const SITES: Record<string, string> = {
  linear: 'https://linear.app/',
  gmail: 'https://mail.google.com/mail/u/0/',
  calendar: 'https://calendar.google.com/calendar/u/0/r',
  linkedin: 'https://www.linkedin.com/feed/',
  facebook: 'https://www.facebook.com/',
  x: 'https://x.com/home',
};

async function openApp(ctx: BrowserContext, url = SITES.linear!): Promise<Page> {
  const page = ctx === guarded ? (guarded.pages().find((p) => p.url().startsWith('about:')) ?? await ctx.newPage()) : (control.pages()[0] ?? await ctx.newPage());
  await page.goto(url);
  if (HEADED) {
    // A label and a live log, so the two windows can be told apart and followed.
    await page.evaluate((guardedSide) => {
      const bar = document.createElement('div');
      bar.textContent = `${guardedSide ? 'Guarded — OnlyRead enforcing' : 'Control — no extension'} · ${location.host}`;
      bar.style.cssText = `font:700 20px system-ui;padding:14px 16px;color:#fff;background:${guardedSide ? '#db2777' : '#475569'}`;
      document.body.prepend(bar);
      const log = document.createElement('ol');
      log.style.cssText = 'font:12px ui-monospace,monospace;max-height:520px;overflow:auto;padding-left:24px';
      document.body.append(log);
      (window as unknown as { __log: (m: string, ok: boolean) => void }).__log = (m, ok) => {
        const li = document.createElement('li');
        li.textContent = `${ok ? 'reached server' : 'REFUSED'} · ${m}`;
        li.style.color = ok ? '#15803d' : '#be185d';
        log.append(li); li.scrollIntoView();
      };
    }, ctx === guarded);
  }
  return page;
}

test.beforeAll(async () => {
  server = await startReplayServer();
  control = await launch(false);
  guarded = await launch(true);
  sw = guarded.serviceWorkers()[0] ?? (await guarded.waitForEvent('serviceworker'));
  // Rules and Linear's verdicts only, as with a judge set (messages.ts assumeJudge): with none, protection cannot go on.
  await sw.evaluate(async () => {
    const hook = (globalThis as unknown as { __onlyread: { ready: () => Promise<void>; assumeJudge: (on: boolean) => void } }).__onlyread;
    await hook.ready();
    hook.assumeJudge(true);
  });
  // The settings page's own messages: enforce, always attached, read tracking off (every labeled write refused, view
  // preferences included), Linear on (which imports its verdicts).
  const opts = await guarded.newPage();
  await opts.goto(`chrome-extension://${new URL(sw.url()).host}/options.html`);
  await opts.evaluate(async () => {
    // Each change builds on the policy in force, which takes a change a moment after it is stored, so one sent right
    // after another can carry the earlier value back: each is sent again until both hold. Under a full run the site's
    // verdicts can take a while to import: up to fifteen seconds.
    let st: { mode?: string; attachWhen?: string; allowReadTracking?: boolean; targetDomains?: string[] } = {};
    const guarding = () => st.mode === 'enforce' && st.attachWhen === 'always';
    for (let i = 0; i < 150; i++) {
      if (!guarding()) await chrome.runtime.sendMessage({ type: 'guard:set', enabled: true, mode: 'enforce', attachWhen: 'always' });
      else if (!st.targetDomains?.includes('linear.app')) await chrome.runtime.sendMessage({ type: 'site:set', id: 'linear', enabled: true });
      else if (st.allowReadTracking !== false) await chrome.runtime.sendMessage({ type: 'read-tracking:set', on: false });
      await new Promise((r) => setTimeout(r, 100));
      st = (await chrome.runtime.sendMessage({ type: 'status:get' })) as typeof st;
      if (guarding() && st.allowReadTracking === false && st.targetDomains?.includes('linear.app')) return;
    }
    throw new Error(`not ready: ${JSON.stringify(st)}`);
  });
  for (const p of guarded.pages()) if (!p.url().startsWith('about:')) await p.close();
});

test.afterAll(async () => {
  await guarded?.close();
  await control?.close();
  await server?.close();
});

test('a status change without OnlyRead lands and is visible through OnlyRead; through OnlyRead it is refused', async () => {
  server.state = LINEAR_STATES[0]!;

  // Control (no extension) moves the issue to In Progress: the server has it.
  const controlPage = await openApp(control);
  await expect(controlPage.locator('#status')).toHaveText('Todo');
  await beat(controlPage);
  expect(await send(controlPage, statusChange('state-progress'), 'control-1')).toBe('sent');
  await controlPage.reload();
  await beat(controlPage);
  expect(server.state.name).toBe('In Progress');

  // Guarded reads it: reads pass through OnlyRead.
  const guardedPage = await openApp(guarded);
  await expect(guardedPage.locator('#status')).toHaveText('In Progress');
  await beat(guardedPage);

  // Guarded tries to move it to Done: refused in the browser, never received by the server.
  expect(await send(guardedPage, statusChange('state-done'), 'guarded-1')).toBe('refused');
  await guardedPage.waitForTimeout(500);
  expect(server.received.some((r) => r.replayId === 'guarded-1')).toBe(false);
  expect(server.state.name).toBe('In Progress');

  // And the control browser, reloading from the server, still sees In Progress.
  await beat(guardedPage);
  await controlPage.reload();
  await expect(controlPage.locator('#status')).toHaveText('In Progress');
  await beat(controlPage, 2500);
});

test('a typed password never reaches OnlyRead\'s log, its observations or the judge', async () => {
  const SECRET = 'SYNTHETIC_REVIEW_SECRET';
  const page = await openApp(guarded);
  await page.evaluate(() => { const i = document.createElement('input'); i.type = 'password'; i.id = 'pw'; document.body.append(i); });
  await page.fill('#pw', SECRET);
  await page.click('#pw');
  // A request right after the click (within the UI-action window), with the password in its body.
  await send(page, { label: 'write', fingerprint: '', method: 'POST', url: 'https://client-api.linear.app/login', contentType: 'application/x-www-form-urlencoded', body: `user=ana&password=${SECRET}` }, 'secret-1');
  await page.waitForTimeout(1200);
  // Everything stored, so the secret is looked for in every key (the log is chunked, background/audit.ts).
  const stored = await sw.evaluate(() => chrome.storage.local.get(null));
  // Not vacuous: the click on the field was recorded, and the request was observed.
  const decisions = await storedAudit(sw) as { url?: string; lastUiActions?: { tag: string; name?: string }[] }[];
  expect(decisions.some((d) => d.url?.includes('/login') && d.lastUiActions?.some((a) => a.tag === 'input'))).toBe(true);
  expect(((stored.observations ?? []) as { url: string }[]).some((o) => o.url.includes('/login'))).toBe(true);
  expect(JSON.stringify(stored)).not.toContain(SECRET);
});

/** The share of labeled reads each site must let through (measured; raise it as gaps are fixed). */
const READ_FLOOR: Record<string, number> = {};

/** Writes the site's policy allows on purpose (`allowedShapes`, e.g. Calendar's onboarding timestamp): they
 *  are expected to reach the server and are not counted as leaks. The extension matches the exact shape. */
const allowedWriteShapes = (site: string): string[] =>
  JSON.parse(fs.readFileSync(path.join(ROOT, 'apps', site, 'policy.json'), 'utf8')).allowedShapes ?? [];

for (const site of Object.keys(SITES)) {
  test(`${site}: every labeled write is refused before it reaches the server; reads get through`, async () => {
    const entries = corpus(site);
    const opts = await guarded.newPage();
    await opts.goto(`chrome-extension://${new URL(sw.url()).host}/options.html`);
    await opts.evaluate((id) => chrome.runtime.sendMessage({ type: 'site:set', id, enabled: true }), site);
    await opts.close();
    const page = await openApp(guarded, SITES[site]);
    await beat(page);

    // When watching, the writes and non-GET reads first (the interesting part), slower, then the rest.
    const order = HEADED ? [...entries.filter((e) => e.method !== 'GET'), ...entries.filter((e) => e.method === 'GET')] : entries;
    const size = HEADED ? 4 : 25;
    const results: { e: Entry; id: string; result: 'sent' | 'refused' }[] = [];
    for (let i = 0; i < order.length; i += size) {
      const batch = order.slice(i, i + size).map((e, j) => ({ e, id: `${site}-${i + j}` }));
      if (HEADED && i < 60) await page.waitForTimeout(350);
      results.push(...await Promise.all(batch.map(async ({ e, id }) => ({ e, id, result: await send(page, e, id) }))));
    }
    await page.waitForTimeout(1000);
    const reached = new Set(server.received.map((r) => r.replayId).filter(Boolean));

    const allowed = allowedWriteShapes(site);
    const writes = results.filter((r) => r.e.label === 'write' && !allowed.some((shape) => r.e.fingerprint.endsWith(` ${shape}`)));
    const leaked = writes.filter((r) => reached.has(r.id)).map((r) => r.e.fingerprint);
    const reads = results.filter((r) => r.e.label !== 'write');
    const readsIn = reads.filter((r) => reached.has(r.id));
    const refusedReads = reads.filter((r) => !reached.has(r.id)).map((r) => `${r.e.label} ${r.e.fingerprint}`);
    console.log(`${site}: ${writes.length} writes, ${leaked.length} reached the server; ${readsIn.length}/${reads.length} reads and telemetry got through`);
    for (const fp of refusedReads.slice(0, 25)) console.log(`  refused: ${fp.slice(0, 150)}`);

    expect(leaked, 'writes that reached the server').toEqual([]);
    expect(writes.length).toBeGreaterThan(0);
    expect(readsIn.length / reads.length, 'share of reads that got through').toBeGreaterThanOrEqual(READ_FLOOR[site] ?? 0.99);
    await beat(page, 3000);
  });
}

