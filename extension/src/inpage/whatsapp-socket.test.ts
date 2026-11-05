import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import tokens from './wap-tokens.json';
import { decodeFrame } from './wap';

// The guard is installed once per realm; these tests run it in Node's, with real WebCrypto and a stand-in WebSocket.
const reports: { shape: string; enforced: boolean }[] = [];
const sent: Uint8Array[] = [];
let closed = 0;

class FakeSocket {
  url = 'wss://web.whatsapp.com/ws/chat?ED=x';
  send(d: ArrayBufferView | string | Blob) { sent.push(ArrayBuffer.isView(d) ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength).slice() : new Uint8Array()); }
  close() { closed++; }
}

const g = globalThis as Record<string, unknown>;
const saved = { WebSocket: g.WebSocket, location: g.location, encrypt: SubtleCrypto.prototype.encrypt };
const config = (mode: 'monitor' | 'enforce', allow: string[] = []) => ({ mode, allow, hosts: ['web.whatsapp.com'], binding: '__testBinding' });

beforeAll(async () => {
  g.WebSocket = FakeSocket;
  Object.defineProperty(globalThis, 'location', { value: { hostname: 'web.whatsapp.com' }, configurable: true });
  g.__testBinding = (payload: string) => reports.push(JSON.parse(payload));
  g.orSocketConfig = config('enforce');
  await import('./whatsapp-socket');
});
afterAll(() => {
  g.WebSocket = saved.WebSocket;
  SubtleCrypto.prototype.encrypt = saved.encrypt;
  Object.defineProperty(globalThis, 'location', { value: saved.location, configurable: true });
});

const reconfigure = (c: ReturnType<typeof config>) => (g[Symbol.for('onlyread.socket-guard') as unknown as string] as { configure(c: unknown): void }).configure(c);

function stanza(tag: string, attrs: Record<string, string>): Uint8Array<ArrayBuffer> {
  const str = (s: string) => { const i = tokens.single.indexOf(s); return i >= 0 ? [i + 1] : [0xfc, s.length, ...Array.from(s, (c) => c.charCodeAt(0))]; };
  const a = Object.entries(attrs);
  return Uint8Array.from([0, 0xf8, 1 + a.length * 2, ...str(tag), ...a.flatMap(([k, v]) => [...str(k), ...str(v)])]);
}

let key: CryptoKey;
const iv = new Uint8Array(12);
async function roundTrip(plain: Uint8Array<ArrayBuffer>): Promise<{ ct: ArrayBuffer; seen: Uint8Array }> {
  key ??= await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain);
  const seen = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct));
  return { ct, seen };
}
const framed = (ct: ArrayBuffer) => { const u = new Uint8Array(ct); return Uint8Array.from([u.length >> 16, (u.length >> 8) & 255, u.length & 255, ...u]); };

describe('the stanza guard (enforce)', () => {
  it('encrypts a message as a keepalive and reports it; a read goes as it is', async () => {
    const write = await roundTrip(stanza('message', { type: 'text' }));
    expect(decodeFrame(write.seen)).toMatchObject({ tag: 'iq', attrs: { xmlns: 'w:p', type: 'get' } });
    expect(reports.at(-1)).toEqual({ shape: 'whatsapp:message:w[text]', enforced: true });

    const read = stanza('iq', { type: 'get', xmlns: 'usync' });
    const r = await roundTrip(read);
    expect(r.seen).toEqual(read);
  });

  it('lets the socket carry vetted frames and closes it on one that is not', async () => {
    const ws = new FakeSocket() as unknown as WebSocket;
    const a = await roundTrip(stanza('iq', { type: 'get', xmlns: 'w:p' }));
    ws.send(framed(a.ct));
    expect(sent).toHaveLength(1);
    // Encrypted outside the guard (a bypass): the frame is not sent, and the socket closes.
    const foreign = await saved.encrypt.call(crypto.subtle, { name: 'AES-GCM', iv: new Uint8Array(12).fill(1) }, key, stanza('message', { type: 'text' }));
    ws.send(framed(foreign));
    expect(sent).toHaveLength(1);
    expect(closed).toBe(1);
    expect(reports.at(-1)).toEqual({ shape: 'whatsapp:frame:w[unvetted]', enforced: true });
  });

  it('leaves the page’s other AES-GCM work alone', async () => {
    const other = new Uint8Array([10, 1, 2, 3, 4]);
    expect((await roundTrip(other)).seen).toEqual(other);
  });
});

// The handshake as WhatsApp's Noise XX runs it: the intro header and ClientHello, then ClientFinish, each a 3-byte length
// and a HandshakeMessage protobuf sent before the transport keys exist, so none of it passes the guard's encrypt hook
// as a stanza.
const lengthed = (body: number[]) => [body.length >> 16, (body.length >> 8) & 255, body.length & 255, ...body];
const clientHello = () => Uint8Array.from([0x57, 0x41, 6, 3, ...lengthed([0x12, 0x22, 0x0a, 0x20, ...new Array(32).fill(7)])]);
// With routing info the intro header is `ED`, 0, 1, a 3-byte length and the routing bytes, then the WA header.
const edClientHello = () => Uint8Array.from([0x45, 0x44, 0, 1, ...lengthed([8, 2, 8, 5]), ...clientHello()]);
const clientFinish = () => Uint8Array.from(lengthed([0x22, 0x40, 0x0a, 0x30, ...new Array(48).fill(9), 0x12, 0x0c, ...new Array(12).fill(3)]));
const foreignFrame = async (plain: Uint8Array<ArrayBuffer>) => {
  key ??= await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  return framed(await saved.encrypt.call(crypto.subtle, { name: 'AES-GCM', iv: new Uint8Array(12).fill(2) }, key, plain));
};

describe('the stanza guard, the handshake bound', () => {
  const fresh = () => { const ws = new FakeSocket() as unknown as WebSocket; return { ws, sentBefore: sent.length, closedBefore: closed }; };

  it('lets the handshake go, then the socket’s vetted frames; a reconnect starts its own handshake', async () => {
    reconfigure(config('enforce'));
    for (let round = 0; round < 2; round++) {
      const { ws, sentBefore, closedBefore } = fresh();
      ws.send(clientHello());
      ws.send(clientFinish());
      const a = await roundTrip(stanza('iq', { type: 'get', xmlns: 'w:p' }));
      ws.send(framed(a.ct));
      const b = await roundTrip(stanza('iq', { type: 'get', xmlns: 'usync' }));
      ws.send(framed(b.ct));
      expect(sent.length - sentBefore).toBe(4);
      expect(closed).toBe(closedBefore);
      ws.close(); // and WhatsApp opens a new socket
    }
  });

  it('closes the socket when no frame is ever vetted (WhatsApp encrypting somewhere else), and reports it', async () => {
    reconfigure(config('enforce'));
    const { ws, sentBefore, closedBefore } = fresh();
    ws.send(clientHello());
    ws.send(clientFinish());
    expect(sent.length - sentBefore).toBe(2);
    ws.send(await foreignFrame(stanza('message', { type: 'text' })));
    expect(sent.length - sentBefore).toBe(2);
    expect(closed).toBe(closedBefore + 1);
    expect(reports.at(-1)).toEqual({ shape: 'whatsapp:frame:w[unvetted]', enforced: true });
  });

  it('closes it on a frame the hook could not read as a stanza, sent before any vetted one', async () => {
    reconfigure(config('enforce'));
    const { ws, sentBefore, closedBefore } = fresh();
    ws.send(clientHello());
    ws.send(clientFinish());
    // Through the hook, but not a stanza (a compressed frame, or a new token): never remembered as vetted.
    const compressed = await roundTrip(Uint8Array.from([2, 0x78, 0x9c, 1, 2, 3, 4]));
    ws.send(framed(compressed.ct));
    expect(sent.length - sentBefore).toBe(2);
    expect(closed).toBe(closedBefore + 1);
  });

  it('in monitor mode reports the unvetted frame once per socket and sends it', async () => {
    reconfigure(config('monitor'));
    const { ws, sentBefore, closedBefore } = fresh();
    ws.send(clientHello());
    ws.send(clientFinish());
    const n = reports.length;
    ws.send(await foreignFrame(stanza('message', { type: 'text' })));
    ws.send(await foreignFrame(stanza('message', { type: 'reaction' })));
    ws.send('not bytes');
    expect(sent.length - sentBefore).toBe(5);
    expect(closed).toBe(closedBefore);
    expect(reports.slice(n)).toEqual([{ shape: 'whatsapp:frame:w[unvetted]', enforced: false }]);
    reconfigure(config('enforce'));
  });

  it('lets a first send with the ED routing header go as the handshake', async () => {
    reconfigure(config('enforce'));
    const { ws, sentBefore, closedBefore } = fresh();
    ws.send(edClientHello());
    ws.send(clientFinish());
    ws.send(framed((await roundTrip(stanza('iq', { type: 'get', xmlns: 'w:p' }))).ct));
    expect(sent.length - sentBefore).toBe(3);
    expect(closed).toBe(closedBefore);
  });

  it('counts a send that is not bytes (a string, a Blob) as unvetted', async () => {
    reconfigure(config('enforce'));
    // Past the handshake: refused, and the socket closes.
    const past = fresh();
    past.ws.send(clientHello());
    past.ws.send(clientFinish());
    past.ws.send(framed((await roundTrip(stanza('iq', { type: 'get', xmlns: 'w:p' }))).ct));
    past.ws.send('{"tag":"message"}');
    expect(sent.length - past.sentBefore).toBe(3);
    expect(closed).toBe(past.closedBefore + 1);
    expect(reports.at(-1)).toEqual({ shape: 'whatsapp:frame:w[unvetted]', enforced: true });
    // Before any vetted frame it uses up the handshake's sends like any unvetted one.
    const early = fresh();
    early.ws.send(new Blob([clientHello()]));
    early.ws.send(clientFinish());
    early.ws.send(new Blob([Uint8Array.from([1, 2, 3])]));
    expect(sent.length - early.sentBefore).toBe(2);
    expect(closed).toBe(early.closedBefore + 1);
  });
});

describe('the stanza guard, reconfigured', () => {
  it('in monitor mode reports and sends the write unchanged', async () => {
    reconfigure(config('monitor'));
    const write = stanza('message', { type: 'reaction' });
    expect((await roundTrip(write)).seen).toEqual(write);
    expect(reports.at(-1)).toEqual({ shape: 'whatsapp:message:w[reaction]', enforced: false });
  });

  it('lets an allowed write shape through (read-tracking on)', async () => {
    reconfigure(config('enforce', ['whatsapp:receipt:w[read]']));
    const n = reports.length;
    const receipt = stanza('receipt', { type: 'read' });
    expect((await roundTrip(receipt)).seen).toEqual(receipt);
    expect(reports).toHaveLength(n);
  });
});
