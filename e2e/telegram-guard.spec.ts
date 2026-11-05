// The Telegram guard (inpage/telegram-worker.ts) against a stand-in for Telegram Web: a local HTTPS server answers for
// web.telegram.org (Chrome is pointed at it, its throwaway certificate accepted). Its MTProto worker carries schema
// declarations as Telegram's script does, hands each request to a crypto port as Telegram's does, first for its key
// (`sha256` over 32 bytes of key, then the request), then to "encrypt" it (the stand-in's crypto returns the bytes as
// they are, so the server can read them), and sends the result over its socket. Enforcing, a read must reach the
// server as it was and a write must not: its message arrives as a method no server knows, the reads beside it intact.
import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import type { AddressInfo } from 'node:net';
import { Harness } from './helpers';
import { methodTable } from '../extension/src/inpage/mtproto';
import { shapesOf } from '../extension/src/inpage/mtproto.testing';

test.describe.configure({ mode: 'serial' });

const h = new Harness(4255);

// Telegram's own ids for these methods, declared the way its worker script declares them.
const SCHEMA = '{id:-17526942,method:`messages.sendMessage`,params:[],type:`Updates`},{id:1143203525,method:`messages.getHistory`,params:[],type:`messages.Messages`}';

const PAGE = `<!doctype html><title>stand-in</title><script>
  const w = new Worker('/k/index.worker.js?__tweb_threaded_worker_protocol=4');
  const waiting = new Map(); let n = 0;
  w.onmessage = (e) => { waiting.get(e.data.id)?.(e.data.result); waiting.delete(e.data.id); };
  // A blob: worker: its script never crosses the network, so the guard cannot come with it.
  let blob;
  window.blobProbe = () => new Promise((resolve) => {
    blob ??= new Worker(URL.createObjectURL(new Blob(["onmessage = () => postMessage(typeof globalThis[Symbol.for('onlyread.socket-guard')]?.configure === 'function')"], { type: 'text/javascript' })));
    blob.onmessage = (e) => resolve(e.data); blob.postMessage(0);
  });
  window.cmd = (msg) => new Promise((resolve) => { const id = ++n; waiting.set(id, resolve); w.postMessage({ id, ...msg }); });
</script>`;

// The MTProto worker: a crypto port (the stand-in's crypto echoes), Telegram's task format, a socket to the server.
const WORKER = `/* ${SCHEMA} */
  const guardedAtStart = typeof globalThis[Symbol.for('onlyread.socket-guard')]?.configure === 'function'; // its own first line
  const { port1: crypto, port2: cryptoSide } = new MessageChannel();
  cryptoSide.onmessage = (e) => { for (const t of e.data.payload) cryptoSide.postMessage({ type: 'result', payload: { taskId: t.id, result: t.payload.payload.args[0] } }); };
  const awaiting = new Map(); let task = 0.5;
  crypto.onmessage = (e) => { const p = e.data.payload; const a = awaiting.get(p.taskId); awaiting.delete(p.taskId); if (a) 'error' in p ? a.reject(p.error) : a.resolve(p.result); };
  const task1 = (method, args) => new Promise((resolve, reject) => { const id = task++; awaiting.set(id, { resolve, reject }); crypto.postMessage({ type: 'batch', payload: [{ type: 'invoke', payload: { type: 'invoke', payload: { method, args } }, id }], id: task++ }); });
  // Telegram's order: the key from the request, then the request encrypted. keyFirst false skips the key step.
  const encrypt = async (plain, keyFirst = true) => { if (keyFirst) await task1('sha256', [[...new Array(32).fill(5), ...plain]]); return task1('aes-encrypt', [Array.from(plain), new Uint8Array(32), new Uint8Array(32)]); };
  const le = (n) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
  const call = (methodId) => [...le(methodId), 0, 0, 0, 0];
  // One call, or a container of several, as the client sends it: a message id of the time now, padding to 16.
  const request = (methods) => { const bodies = methods.map(call); const body = bodies.length === 1 ? bodies[0] : [...le(0x73f1f8dc), ...le(bodies.length), ...bodies.flatMap((b, i) => [...le(i + 8), 0, 0, 0, 0, ...le(i * 2 + 1), ...le(b.length), ...b])]; let pad = 12; while ((32 + body.length + pad) % 16) pad++; return Uint8Array.from([...new Array(16).fill(0), ...le(4 * ++sent), ...le(Math.floor(Date.now() / 1000)), ...le(1), ...le(body.length), ...body, ...new Array(pad).fill(0)]); };
  let sent = 0;
  let ws;
  onmessage = async (e) => {
    const { id, op } = e.data; let result;
    if (op === 'probe') result = typeof globalThis[Symbol.for('onlyread.socket-guard')]?.configure === 'function';
    if (op === 'guardedAtStart') result = guardedAtStart;
    if (op === 'connect') result = await new Promise((r) => { ws = new WebSocket('wss://web.telegram.org/apiws'); ws.onopen = () => r('open'); ws.onerror = () => r('error'); });
    if (op === 'call') { try { ws.send(Uint8Array.from(await encrypt(request(e.data.methods), e.data.keyFirst ?? true))); result = 'sent'; } catch (err) { result = 'refused: ' + err; } }
    // A message from the server, checked with the same key step: its id is not the client's (odd), and it must be
    // hashed as it came, or the worker would discard it. The stand-in returns what was hashed.
    if (op === 'incoming') { const m = request(e.data.methods); if (e.data.stale) m.fill(0, 20, 24); else m[16] = 5; result = (await task1('sha256', [[...new Array(32).fill(5), ...m]])).slice(32).join(',') === Array.from(m).join(','); }
    if (op === 'http') { try { const r = await fetch('/apiw1', { method: 'POST', body: Uint8Array.from(await encrypt(request(e.data.methods))) }); result = 'http ' + r.status; } catch (err) { result = 'refused: ' + err; } }
    postMessage({ id, result });
  };`;

// A page under a service worker that answers each script itself and keeps what it fetched (Cache API), as Telegram's
// does. The worker's script then comes from the service worker, never as the page's own response.
const SW_PAGE = `<!doctype html><title>stand-in under a service worker</title><script>
  window.swReady = async () => { await navigator.serviceWorker.register('/sw/sw.js', { scope: '/sw/' }); await navigator.serviceWorker.ready; return !!navigator.serviceWorker.controller; };
  let w;
  window.swProbe = () => new Promise((resolve) => { w ??= new Worker('/sw/w.js'); w.onmessage = (e) => resolve(e.data); w.postMessage(0); });
  window.swStored = async () => { const r = await (await caches.open('cachedAssets')).match('/sw/w.js'); return r ? r.text() : null; };
</script>`;
const SW = `onfetch = (e) => { if (!/\\.js$/.test(new URL(e.request.url).pathname)) return;
  e.respondWith((async () => { const r = await fetch(e.request); await (await caches.open('cachedAssets')).put(e.request, r.clone()); return r; })()); };
  oninstall = () => skipWaiting(); onactivate = (e) => e.waitUntil(clients.claim());`;
const SW_WORKER = "onmessage = () => postMessage(typeof globalThis[Symbol.for('onlyread.socket-guard')]?.configure === 'function');";

let server: https.Server;
/** The calls that reached the server, as shapes. */
const got: string[] = [];
/** The same, for requests that came over HTTP (Telegram's fallback transport). */
const gotHttp: string[] = [];

test.beforeAll(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onlyread-tls-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=web.telegram.org',
    '-addext', 'subjectAltName=DNS:web.telegram.org', '-keyout', `${dir}/key.pem`, '-out', `${dir}/cert.pem`], { stdio: 'ignore' });
  server = https.createServer({ key: fs.readFileSync(`${dir}/key.pem`), cert: fs.readFileSync(`${dir}/cert.pem`) }, (req, res) => {
    const js = (body: string) => { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(body); };
    if (req.url === '/sw/sw.js') { js(SW); return; }
    if (req.url === '/sw/w.js') { js(SW_WORKER); return; }
    if (req.url === '/sw/') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(SW_PAGE); return; }
    if (req.url?.startsWith('/k/index.worker.js')) { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(WORKER); return; }
    if (req.url === '/apiw1' && req.method === 'POST') {
      const parts: Buffer[] = [];
      req.on('data', (c: Buffer) => parts.push(c));
      req.on('end', async () => { gotHttp.push(...((await shapesOf(new Uint8Array(Buffer.concat(parts)), methodTable(SCHEMA))) ?? ['not-a-request'])); res.end(); });
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE);
  });
  const table = methodTable(SCHEMA);
  new WebSocketServer({ server, path: '/apiws' }).on('connection', (ws) => {
    ws.on('message', async (data: Buffer) => { got.push(...((await shapesOf(new Uint8Array(data), table)) ?? ['not-a-request'])); });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  await h.start({ mode: 'enforce', reviewBand: 'block', sites: { telegram: { enabled: true } } }, {
    // The worker's script reaches it rewritten (the guard before its first line), and Chrome counts a worker whose script
    // was answered that way as public: its socket to the stand-in, on this machine, would be refused as a public site's
    // request into the local network. The real site's servers are public.
    extraArgs: [`--host-resolver-rules=MAP web.telegram.org 127.0.0.1:${port}`, '--ignore-certificate-errors', '--disable-features=LocalNetworkAccessChecks'],
  });
});
test.afterAll(async () => { await h.stop(); server?.close(); });

const GET_HISTORY = 0x4423e6c5;
const SEND_MESSAGE = 0xfef48f62;
const REFUSED = 'telegram:w[unknown:0x0b1ebeef]';

test('a read reaches the server as it was; a write arrives as a method no server knows, the reads beside it intact', async () => {
  const page = h.page;
  await page.goto('https://web.telegram.org/k/');
  await h.waitFor(async () => (await h.audit()).some((e) => e.kind === 'system' && e.reason === 'socket-guard-armed:telegram'), 'the tab armed');
  const cmd = (msg: Record<string, unknown>) => page.evaluate((m) => (window as unknown as { cmd: (m: unknown) => Promise<unknown> }).cmd(m), msg);
  await h.waitFor(async () => (await cmd({ op: 'probe' })) === true, 'the guard in the MTProto worker');
  // The guard came with the worker's script, there before its own first line (no command was sent into the worker), and
  // the tab's socket opens once it has reported in.
  expect(await cmd({ op: 'guardedAtStart' })).toBe(true);
  await h.waitFor(async () => (await cmd({ op: 'connect' })) === 'open', 'the socket open');
  const at = async (n: number) => { await h.waitFor(async () => got.length >= n, `${n} calls at the server`); return got.slice(); };

  expect(await cmd({ op: 'call', methods: [GET_HISTORY] })).toBe('sent');
  expect(await at(1)).toEqual(['telegram:r[messages.getHistory]']);

  // A write alone, and a write sharing a container with a read.
  expect(await cmd({ op: 'call', methods: [SEND_MESSAGE] })).toBe('sent');
  expect(await at(2)).toEqual(['telegram:r[messages.getHistory]', REFUSED]);
  expect(await cmd({ op: 'call', methods: [GET_HISTORY, SEND_MESSAGE] })).toBe('sent');
  expect((await at(4)).slice(2)).toEqual(['telegram:r[messages.getHistory]', REFUSED]);
  await h.waitFor(async () => (await h.audit()).some((e) => e.method === 'WS' && e.bodyShape === 'telegram:w[messages.sendMessage]' && e.enforced), 'the refusal in the log');

  // A method the schema does not name is a write too.
  expect(await cmd({ op: 'call', methods: [0x01020304] })).toBe('sent');
  expect((await at(5)).slice(4)).toEqual([REFUSED]);

  // A message the server sent (here one naming a write) is checked by the key step untouched.
  expect(await cmd({ op: 'incoming', methods: [SEND_MESSAGE] })).toBe(true);
  // Nor is anything else hashed there that is not surely a request the client is sending now (here a write's bytes under
  // a message id from long ago).
  expect(await cmd({ op: 'incoming', methods: [SEND_MESSAGE], stale: true })).toBe(true);

  // A write whose key was made without the guard seeing it cannot be rewritten (the server would refuse the request
  // for a key that does not match): its encryption is answered with an error, and nothing is sent.
  expect(await cmd({ op: 'call', methods: [SEND_MESSAGE], keyFirst: false })).toBe('refused: onlyread: refused');
  expect(got).toHaveLength(5);

  // Telegram's HTTP transport carries the same guarded requests: in an armed tab its binary posts go through (the
  // binary-body rule would refuse them anywhere else), rewritten the same way.
  expect(await cmd({ op: 'http', methods: [GET_HISTORY] })).toBe('http 200');
  expect(await cmd({ op: 'http', methods: [GET_HISTORY, SEND_MESSAGE] })).toBe('http 200');
  expect(gotHttp).toEqual(['telegram:r[messages.getHistory]', 'telegram:r[messages.getHistory]', REFUSED]);
});

test('a worker whose script never crosses the network (a blob: worker) gets the guard put in once it runs', async () => {
  const page = h.page;
  await h.waitFor(async () => (await page.evaluate(() => (window as unknown as { blobProbe: () => Promise<boolean> }).blobProbe())) === true, 'the guard in the blob worker');
  await h.waitFor(async () => (await h.audit()).some((e) => e.reason === 'socket-guard-worker-injected'), 'the guard put in through the session');
});

test('a worker script a service worker fetches is never rewritten: the guard would stay in its cache, past its settings and OnlyRead', async () => {
  const page = h.page;
  await page.goto('https://web.telegram.org/sw/');
  const call = <T>(fn: string) => page.evaluate((f) => (window as unknown as Record<string, () => Promise<unknown>>)[f]!(), fn) as Promise<T>;
  if (!(await call<boolean>('swReady'))) await page.reload(); // the first load registers it; the next is controlled by it
  await call('swReady');
  await h.waitFor(async () => (await call<boolean>('swProbe')) === true, 'the guard in the worker, put in through its session');
  const stored = await call<string | null>('swStored');
  expect(stored).not.toBeNull();
  expect(stored).toBe(SW_WORKER); // as the server sent it, without the guard
});

test('switching the site off reloads its tab: the page comes back without the guard', async () => {
  const page = h.page;
  await page.goto('https://web.telegram.org/k/');
  await h.waitFor(async () => (await h.audit()).some((e) => e.kind === 'system' && e.reason === 'socket-guard-armed:telegram'), 'the tab armed');
  const cmd = (msg: Record<string, unknown>) => page.evaluate((m) => (window as unknown as { cmd: (m: unknown) => Promise<unknown> }).cmd(m), msg);
  await h.waitFor(async () => (await cmd({ op: 'probe' })) === true, 'the guard in the MTProto worker');
  await page.evaluate(() => { (window as unknown as { before: boolean }).before = true; });

  await h.setPolicy({ sites: { telegram: { enabled: false } } });
  await h.waitFor(async () => (await h.audit()).some((e) => e.kind === 'system' && e.reason === 'socket-guard-off-reload'), 'the reload in the log');
  await h.waitFor(async () => (await page.evaluate(() => (window as unknown as { before?: boolean }).before).catch(() => true)) !== true, 'a new document');
  expect(await page.evaluate(() => typeof SharedWorker)).toBe('function');
  expect(await cmd({ op: 'probe' })).toBe(false);
});
