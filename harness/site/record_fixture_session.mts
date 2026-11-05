// Record a scripted "agent session" against the fixture in Playwright's Chromium with
// the extension loaded and Chrome NetLog on. Produces sessions/<name>/ with
// decisions.jsonl, observations.jsonl, system.jsonl, netlog.json(+.jsonl), server-log.json
// under apps/fixture/sessions/<name>/.
//
//   node harness/site/record_fixture_session.mts <name> [monitor|enforce]
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Harness } from '../../e2e/helpers.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'); // the repo root
const name = process.argv[2] ?? `fixture-${Date.now()}`;
const mode = (process.argv[3] ?? 'monitor') as 'monitor' | 'enforce';
const dir = path.join(ROOT, 'apps', 'fixture', 'sessions', name);
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });

const h = new Harness(4211);
await h.start({ mode, uploads: false }, {
  extraArgs: [`--log-net-log=${path.join(dir, 'netlog.json')}`, '--net-log-capture-mode=Default'],
  profileDir: path.join(dir, 'profile'),
});
await h.waitFor(async () => (await h.status()).attachedTabs >= 1, 'attach');
const log = (m: string) => console.log(`[record] ${m}`);
log(`mode=${mode} dir=${dir}`);

// --- the "agent" does a read task, then a write task, then the odd cases ---
const clickAll = async (selector: string) => {
  for (const el of await h.page.locator(selector).all()) {
    const label = (await el.textContent())?.trim();
    await el.click();
    await h.page.waitForTimeout(150);
    log(`click ${label}`);
  }
};
await clickAll('h2:has-text("Reads") + .grid button');
await clickAll('h2:has-text("Writes") + .grid button');
log(`worker POST /rpc list → ${await h.workerFetch('POST', '/rpc', '{"op":"list"}')}`);
log(`worker POST /rpc create → ${await h.workerFetch('POST', '/rpc', '{"op":"create","name":"w"}')}`);
log(`multipart upload → ${await h.page.evaluate(async () => {
  const fd = new FormData(); fd.append('file', new Blob(['x']), 'a.txt');
  try { const r = await fetch('/upload', { method: 'POST', body: fd }); return `status:${r.status}`; } catch (e) { return `error:${(e as Error).name}`; }
})}`);
// Form submit is a main_frame POST navigation.
await h.page.locator('#form button[type=submit]').click();
await h.page.waitForLoadState('domcontentloaded');
log(`form submit → ${h.page.url()}`);
await h.page.goto(`${h.base}/`);
// A second tab: its document request predates attach (before-attach bucket).
const p2 = await h.ctx.newPage();
await p2.goto(`${h.base}/api/items`);
await p2.close();
await h.page.waitForTimeout(1500);

// --- export ---
const { audit, observations } = await h.exportAll();
const decisions = audit.filter((e) => e.kind === 'decision');
const system = audit.filter((e) => e.kind === 'system');
const jsonl = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');
fs.writeFileSync(path.join(dir, 'decisions.jsonl'), jsonl(decisions));
fs.writeFileSync(path.join(dir, 'system.jsonl'), jsonl(system));
fs.writeFileSync(path.join(dir, 'observations.jsonl'), jsonl(observations));
fs.writeFileSync(path.join(dir, 'server-log.json'), JSON.stringify(await h.serverLog(), null, 1));
fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify({ targetDomains: ['localhost', '127.0.0.1'], mode, source: 'playwright-chromium', recordedAt: new Date().toISOString() }, null, 1));
log(`decisions ${decisions.length}  observations ${observations.length}  system ${system.length}`);
await h.stop(); // clean close flushes the NetLog
fs.rmSync(path.join(dir, 'profile'), { recursive: true, force: true });
const nl = spawnSync('python3', [path.join(ROOT, 'harness/site/netlog.py'), path.join(dir, 'netlog.json')], { encoding: 'utf8' });
log(nl.stdout.trim() || nl.stderr.trim());
