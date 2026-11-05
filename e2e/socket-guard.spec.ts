// The stanza guard (background/socket-guard.ts, inpage/whatsapp-socket.ts) with the socket in a dedicated worker, as
// WhatsApp Web runs it for some accounts. A local HTTPS server stands in for web.whatsapp.com (Chrome is pointed at it,
// with its throwaway certificate accepted): its page starts a worker that opens the chat socket and encrypts each frame
// with the browser's AES-GCM, and it hands the server its key, so the server reads every frame that arrives. Enforcing,
// a write stanza must arrive as a keepalive, a read as itself, and a frame encrypted around the guard must close the
// socket instead of arriving.
import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import type { AddressInfo } from 'node:net';
import { Harness } from './helpers';
import tokens from '../extension/src/inpage/wap-tokens.json' with { type: 'json' };
import { decodeFrame, shapeOf } from '../extension/src/inpage/wap';

test.describe.configure({ mode: 'serial' });

const h = new Harness(4251);

/** A stanza as the page would encrypt it: flag byte 0, then one node (dictionary tokens, raw strings otherwise). */
function stanza(tag: string, attrs: Record<string, string>): number[] {
  const str = (s: string) => { const i = tokens.single.indexOf(s); return i >= 0 ? [i + 1] : [0xfc, s.length, ...Array.from(s, (c) => c.charCodeAt(0))]; };
  const a = Object.entries(attrs);
  return [0, 0xf8, 1 + a.length * 2, ...str(tag), ...a.flatMap(([k, v]) => [...str(k), ...str(v)])];
}

const PAGE = `<!doctype html><title>stand-in</title><script>
  const w = new Worker('/worker.js');
  const waiting = new Map(); let n = 0;
  w.onmessage = (e) => { waiting.get(e.data.id)?.(e.data.result); waiting.delete(e.data.id); };
  window.cmd = (msg) => new Promise((resolve) => { const id = ++n; waiting.set(id, resolve); w.postMessage({ id, ...msg }); });
</script>`;

// The worker: connect, then encrypt and send stanzas as told, a counter in each IV as the Noise protocol does.
const WORKER = `
  const guardedAtStart = typeof globalThis[Symbol.for('onlyread.socket-guard')]?.configure === 'function'; // its own first line
  let ws, key, counter = 0;
  const iv = (c) => { const v = new Uint8Array(12); new DataView(v.buffer).setUint32(8, c); return v; };
  const frame = (ct) => { const u = new Uint8Array(ct); return Uint8Array.from([u.length >> 16, (u.length >> 8) & 255, u.length & 255, ...u]); };
  onmessage = async (e) => {
    const { id, op } = e.data; let result;
    if (op === 'probe') result = typeof globalThis[Symbol.for('onlyread.socket-guard')]?.configure === 'function';
    if (op === 'guardedAtStart') result = guardedAtStart;
    if (op === 'connect') {
      key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
      const raw = new Uint8Array(await crypto.subtle.exportKey('raw', key));
      ws = new WebSocket('wss://web.whatsapp.com/ws/chat');
      // The Noise handshake's two sends, as WhatsApp makes them before its transport keys exist: the WA header with a
      // ClientHello (here carrying the stand-in's key, for the server), then a ClientFinish. Neither passes the guard's
      // encrypt hook as a stanza; the guard lets the socket's first two unvetted sends go and no more.
      const lengthed = (b) => [b.length >> 16, (b.length >> 8) & 255, b.length & 255, ...b];
      result = await new Promise((r) => { ws.onopen = () => {
        ws.send(Uint8Array.from([0x57, 0x41, 6, 3, ...lengthed([0x12, 0x22, 0x0a, 0x20, ...raw])]));
        ws.send(Uint8Array.from(lengthed([0x22, 0x40, 0x0a, 0x30, ...new Array(48).fill(9), 0x12, 0x0c, ...new Array(12).fill(3)])));
        r('open');
      }; ws.onerror = () => r('error'); });
      ws.onclose = () => { result = 'closed'; };
    }
    if (op === 'send') ws.send(frame(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv(counter++) }, key, Uint8Array.from(e.data.plain))));
    if (op === 'raw') ws.send(frame(Uint8Array.from(e.data.ciphertext))); // encrypted elsewhere: a frame the guard never saw
    if (op === 'state') result = ws ? ws.readyState : -1;
    postMessage({ id, result });
  };`;

let server: https.Server;
/** What reached the server: each frame's stanza as a shape, in order, and whether the socket was closed. */
const got: { shapes: string[]; closed: boolean; key?: Uint8Array<ArrayBuffer>; handshake?: string } = { shapes: [], closed: false };

test.beforeAll(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onlyread-tls-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=web.whatsapp.com',
    '-addext', 'subjectAltName=DNS:web.whatsapp.com', '-keyout', `${dir}/key.pem`, '-out', `${dir}/cert.pem`], { stdio: 'ignore' });
  server = https.createServer({ key: fs.readFileSync(`${dir}/key.pem`), cert: fs.readFileSync(`${dir}/cert.pem`) }, (req, res) => {
    if (req.url === '/worker.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(WORKER); return; }
    res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE);
  });
  const wss = new WebSocketServer({ server, path: '/ws/chat' });
  wss.on('connection', (ws) => {
    let key: Promise<CryptoKey> | undefined;
    let handshake = 0;
    let counter = 0;
    ws.on('message', async (data: Buffer) => {
      const u = new Uint8Array(data);
      // The handshake: the ClientHello (WA header, length, then 0x12 0x22 0x0a 0x20 and the 32-byte key), then the
      // ClientFinish. Nothing is decrypted until both are in.
      if (handshake++ === 0) { got.key = u.slice(11, 43); key = crypto.subtle.importKey('raw', got.key, 'AES-GCM', false, ['decrypt']); return; }
      if (handshake === 2) { got.handshake = u[3] === 0x22 ? 'ClientHello, ClientFinish' : 'unexpected'; return; }
      const ct = u.subarray(3, 3 + ((u[0]! << 16) | (u[1]! << 8) | u[2]!));
      const iv = new Uint8Array(12); new DataView(iv.buffer).setUint32(8, counter++);
      const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, await key!, ct));
      const node = decodeFrame(plain);
      got.shapes.push(node ? shapeOf(node) : 'not-a-stanza');
    });
    ws.on('close', () => { got.closed = true; });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  await h.start({ mode: 'enforce', reviewBand: 'block', sites: { whatsapp: { enabled: true } } }, {
    // The worker's script reaches it rewritten (the guard before its first line), and Chrome counts a worker whose script
    // was answered that way as public: its socket to the stand-in, on this machine, would be refused as a public site's
    // request into the local network. The real site's servers are public.
    extraArgs: [`--host-resolver-rules=MAP web.whatsapp.com 127.0.0.1:${port}`, '--ignore-certificate-errors', '--disable-features=LocalNetworkAccessChecks'],
  });
});
test.afterAll(async () => { await h.stop(); server?.close(); });

test('with the socket in a worker, writes go out as keepalives, reads as themselves, and a frame around the guard closes it', async () => {
  const page = h.page;
  await page.goto('https://web.whatsapp.com/');
  await h.waitFor(async () => (await h.audit()).some((e) => e.kind === 'system' && e.reason.startsWith('socket-guard-armed')), 'the tab armed');
  // The worker carries the guard (put in as it started), before it opens anything.
  const cmd = (msg: Record<string, unknown>) => page.evaluate((m) => (window as unknown as { cmd: (m: unknown) => Promise<unknown> }).cmd(m), msg);
  await h.waitFor(async () => (await cmd({ op: 'probe' })) === true, 'the guard in the worker');
  // The guard came with the worker's script, there before its own first line (no command was sent into the worker), and
  // the tab's socket opens once it has reported in.
  expect(await cmd({ op: 'guardedAtStart' })).toBe(true);
  await h.waitFor(async () => (await cmd({ op: 'connect' })) === 'open', 'the socket open');

  // Both handshake sends reached the server.
  await h.waitFor(async () => got.handshake !== undefined, 'the handshake at the server');
  expect(got.handshake).toBe('ClientHello, ClientFinish');

  // A read arrives as itself.
  await cmd({ op: 'send', plain: stanza('iq', { type: 'get', xmlns: 'usync' }) });
  await h.waitFor(async () => got.shapes.length >= 1, 'the read at the server');
  expect(got.shapes[0]).toBe('whatsapp:iq:r[usync]');

  // A message (a send) arrives as a keepalive; the server never sees a message.
  await cmd({ op: 'send', plain: stanza('message', { type: 'text' }) });
  await h.waitFor(async () => got.shapes.length >= 2, 'the refused write at the server');
  expect(got.shapes[1]).toBe('whatsapp:iq:r[w:p]');
  expect(got.shapes.some((s) => s.startsWith('whatsapp:message'))).toBe(false);
  await h.waitFor(async () => (await h.audit()).some((e) => e.method === 'WS' && e.bodyShape === 'whatsapp:message:w[text]' && e.enforced), 'the refusal in the log');

  // Encrypted around the guard (here outside the browser: the worker's own encrypt is guarded from its first line, so
  // there is no unguarded one to save): not sent; the socket closes.
  const iv = new Uint8Array(12); new DataView(iv.buffer).setUint32(8, 2);
  const bypassKey = await crypto.subtle.importKey('raw', got.key!, 'AES-GCM', false, ['encrypt']);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, bypassKey, Uint8Array.from(stanza('message', { type: 'text' }))));
  await cmd({ op: 'raw', ciphertext: Array.from(ciphertext) });
  await h.waitFor(async () => got.closed, 'the socket closed');
  expect(got.shapes.some((s) => s.startsWith('whatsapp:message'))).toBe(false);
  expect(await cmd({ op: 'state' })).toBe(3); // CLOSED
  await h.waitFor(async () => (await h.audit()).some((e) => e.method === 'WS' && e.bodyShape === 'whatsapp:frame:w[unvetted]' && e.enforced), 'the unvetted frame in the log');
});
