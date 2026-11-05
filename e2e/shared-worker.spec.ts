// SharedWorkers on a guarded site (background/shared-workers.ts). Chrome's network rules refuse a socket a page or a
// dedicated worker opens, but not one a SharedWorker opens, and no tab's debugger session holds a SharedWorker. So a
// guarded page gets no SharedWorker (the site falls back to dedicated workers, which the rules cover), and, while
// enforcing, a SharedWorker of a guarded site that runs anyway (started before protection) is closed and its tab
// reloaded.
import { test, expect } from '@playwright/test';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import type { AddressInfo } from 'node:net';
import { Harness } from './helpers';

test.describe.configure({ mode: 'serial' });

const h = new Harness(4253);
let server: http.Server;
let base = '';
/** Sockets the server saw open, and how many of them are still open. */
const sockets = { opened: 0, open: 0 };

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/shared.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' });
      res.end(`onconnect = (e) => { const port = e.ports[0]; const ws = new WebSocket('ws://' + location.host + '/ws'); ws.onopen = () => port.postMessage('open'); ws.onerror = () => port.postMessage('error'); };`);
      return;
    }
    if (req.url === '/dedicated.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' });
      res.end(`const ws = new WebSocket('ws://' + location.host + '/ws'); ws.onopen = () => postMessage('open'); ws.onerror = () => postMessage('error');`);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><title>shared worker site</title>');
  });
  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (ws) => { sockets.opened++; sockets.open++; ws.on('close', () => { sockets.open--; }); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // The harness guards 127.0.0.1 (its fixture site); sockets to a guarded host are refused by default.
  await h.start({ mode: 'enforce', reviewBand: 'block' });
});
test.afterAll(async () => { await h.stop(); server?.close(); });

const sharedSocket = (page = h.page) => page.evaluate(() => new Promise<string>((res) => {
  const w = new SharedWorker('/shared.js');
  w.port.onmessage = (e) => res(String(e.data));
  w.port.start();
  setTimeout(() => res('timeout'), 4000);
}));

test('a guarded page has no SharedWorker, and a dedicated worker\'s socket is refused', async () => {
  await h.page.goto(`${base}/`);
  expect(await h.page.evaluate(() => typeof SharedWorker)).toBe('undefined');
  const dedicated = await h.page.evaluate(() => new Promise<string>((res) => {
    const w = new Worker('/dedicated.js');
    w.onmessage = (e) => res(String(e.data));
    setTimeout(() => res('timeout'), 4000);
  }));
  expect(dedicated).toBe('error');
  expect(sockets.opened).toBe(0);
});

test('a SharedWorker started before protection loses its socket once enforcing, and the page comes back without it', async () => {
  await h.setPolicy({ enabled: false });
  await h.waitFor(async () => (await h.status()).attachedTabs === 0, 'protection off, no tab held');
  const page = await h.ctx.newPage();
  await page.goto(`${base}/`);
  expect(await page.evaluate(() => typeof SharedWorker)).toBe('function');
  expect(await sharedSocket(page)).toBe('open');
  expect(sockets.open).toBe(1);

  await h.setPolicy({ enabled: true, mode: 'enforce' });
  await h.waitFor(async () => sockets.open === 0, 'the SharedWorker closed, its socket with it');
  await h.waitFor(async () => (await h.audit()).some((e) => e.kind === 'system' && e.reason === 'shared-worker-closed:127.0.0.1'), 'the closing in the log');
  // The tab was reloaded: its new document has no SharedWorker.
  await h.waitFor(async () => (await page.evaluate(() => typeof SharedWorker).catch(() => '')) === 'undefined', 'the reloaded page without SharedWorker');
});
