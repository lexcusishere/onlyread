// The stanza guard for WhatsApp Web, injected by the debugger (background/socket-guard.ts) into a guarded tab's page
// and its workers before WhatsApp's own code runs. Not a content script: it lives in the page's own world, where the
// socket and its encryption are.
//
// Two hooks, both on prototypes the page calls through each time:
// - SubtleCrypto.encrypt: a frame's plaintext (wap.ts) is named here. A write in enforce mode is encrypted as a
//   keepalive ping instead, so the server never sees it and the Noise counter stays in step. The decision is
//   synchronous: frames keep their order. Each ciphertext is remembered once encrypted.
// - WebSocket.send on the chat socket: past the Noise handshake, every frame must be one this guard encrypted. The
//   handshake is the socket's first two sends at most (the WA header and ClientHello, then ClientFinish: protobufs
//   sent before the transport keys exist, so no stanza is in them); it ends early with the first vetted frame. A frame
//   past it that is not vetted (encrypted elsewhere, by a code path that bypassed the hook, or one the hook could not
//   read as a stanza) closes the socket in enforce mode: it fails closed, and WhatsApp reconnects through the guard.
//   That holds when no frame is ever vetted too (WhatsApp encrypting off SubtleCrypto): the socket then closes at its
//   third send. A send that is not bytes (a string or a Blob, which the guard cannot read) counts as unvetted. The window
//   is two sends whatever the handshake: a shorter one (a resumed handshake with one send) leaves room for one unvetted
//   frame before the first vetted one, and within the window a send that mixes vetted and unvetted frames goes too.
//   An unvetted frame is reported once per socket (enforce closes the socket on it each time).
// Decisions that refuse (or would, in monitor mode) are reported through the debugger's binding.
import { decodeFrame, isRead, pingFrame, shapeOf } from './wap';

interface SocketGuardConfig {
  mode: 'monitor' | 'enforce';
  /** Write shapes let through anyway: the policy's allowedShapes, and the read-tracking ones when that is on. */
  allow: string[];
  /** Hostnames this guard acts on; anywhere else it stays inert. */
  hosts: string[];
  binding: string;
}
interface Guard { configure(c: SocketGuardConfig): void }

declare const orSocketConfig: SocketGuardConfig;

const KEY = Symbol.for('onlyread.socket-guard');
/** The client's sends in WhatsApp's Noise XX handshake, before the transport keys: the intro header (WA, or ED with
 *  routing info) with ClientHello, then ClientFinish (Baileys, src/Socket/socket.ts validateConnection and
 *  src/Utils/noise-handler.ts encodeFrame, which re-implement WhatsApp Web's handshake; a resumed IK handshake sends
 *  fewer). Every send after them carries transport frames, whose plaintexts are stanzas. */
const HANDSHAKE_SENDS = 2;
const g = globalThis as unknown as Record<symbol, Guard | undefined> & Record<string, unknown>;

function install(initial: SocketGuardConfig): Guard {
  let cfg = initial;
  let allow = new Set(cfg.allow);
  let seq = 0;
  const host = (() => { try { return location.hostname; } catch { return ''; } })();
  const active = () => cfg.hosts.some((h) => host === h || host.endsWith(`.${h}`));

  const report = (shape: string, enforced: boolean) => {
    const fn = g[cfg.binding];
    if (typeof fn === 'function') try { (fn as (s: string) => void)(JSON.stringify({ shape, enforced })); } catch { /* binding gone */ }
  };

  // Ciphertexts this guard produced, by a short signature, until the socket sends them. Bounded: a frame is sent right
  // after it is encrypted.
  const vetted = new Set<string>();
  const signature = (u: Uint8Array) => `${u.length}:${Array.prototype.join.call(u.subarray(0, 16), ',')}`;
  const remember = (sig: string) => { vetted.add(sig); if (vetted.size > 512) vetted.delete(vetted.values().next().value!); };

  const bytesOf = (d: unknown): Uint8Array | undefined => {
    if (d instanceof ArrayBuffer) return new Uint8Array(d);
    if (ArrayBuffer.isView(d)) return new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
    return undefined;
  };

  /** The plaintext to encrypt instead, and whether it is a stanza (its ciphertext is then remembered). A write in
   *  enforce mode becomes a keepalive; one in monitor mode, or one the policy allows, is left as it is. */
  const decide = (alg: AlgorithmIdentifier, data: BufferSource): { input: BufferSource; stanza: boolean } => {
    if (!active() || (alg as { name?: string })?.name !== 'AES-GCM') return { input: data, stanza: false };
    const plain = bytesOf(data);
    const node = plain && decodeFrame(plain);
    if (!node) return { input: data, stanza: false };
    const shape = shapeOf(node);
    if (isRead(shape) || allow.has(shape)) return { input: data, stanza: true };
    const enforced = cfg.mode === 'enforce';
    report(shape, enforced);
    return { input: enforced ? (pingFrame(seq++) as BufferSource) : data, stanza: true };
  };

  const encrypt = SubtleCrypto.prototype.encrypt;
  SubtleCrypto.prototype.encrypt = function (this: SubtleCrypto, alg: AlgorithmIdentifier, key: CryptoKey, data: BufferSource) {
    const { input, stanza } = decide(alg, data);
    const out = encrypt.call(this, alg, key, input) as Promise<ArrayBuffer>;
    if (!stanza) return out;
    // Remembered before the page's own continuation runs (it sends the frame once this resolves).
    return out.then((ct) => { remember(signature(new Uint8Array(ct))); return ct; });
  } as typeof SubtleCrypto.prototype.encrypt;

  /** Whether every frame in a send is one this guard encrypted. A send is one or more frames: a 3-byte length, then
   *  the ciphertext; the connection's first opens with the WA header. */
  const allVetted = (u: Uint8Array): boolean => {
    let p = u[0] === 0x57 && u[1] === 0x41 ? 4 : 0;
    let all = true;
    while (p + 3 <= u.length) {
      const n = (u[p]! << 16) | (u[p + 1]! << 8) | u[p + 2]!;
      if (!vetted.delete(signature(u.subarray(p + 3, p + 3 + n)))) all = false;
      p += 3 + n;
    }
    return all;
  };

  const chat = new WeakSet<WebSocket>(); // chat sockets that have carried a vetted frame: past the handshake
  const handshakeSends = new WeakMap<WebSocket, number>(); // unvetted sends on a socket before its first vetted frame
  /** Counts an unvetted send on a socket not yet past its handshake: whether it is still one of the handshake's. */
  const inHandshake = (ws: WebSocket): boolean => {
    const n = (handshakeSends.get(ws) ?? 0) + 1;
    handshakeSends.set(ws, n);
    return n <= HANDSHAKE_SENDS;
  };
  const reported = new WeakSet<WebSocket>(); // sockets whose unvetted frame was reported: once each, not every send
  /** Whether this send may go. The handshake's sends (HANDSHAKE_SENDS at most) come before any vetted frame; after
   *  them, or after the first vetted frame, every frame must be vetted, or the socket closes (enforce) and WhatsApp
   *  reconnects through the guard. A new socket starts its own handshake. */
  const mayGo = (ws: WebSocket, data: unknown): boolean => {
    if (!active() || !/\/ws\/chat/.test(ws.url)) return true;
    const u = bytesOf(data); // a string or a Blob cannot be read here: it is unvetted
    const pastHandshake = chat.has(ws);
    if (u && allVetted(u)) { chat.add(ws); return true; }
    if (!pastHandshake && inHandshake(ws)) return true;
    if (!reported.has(ws)) { reported.add(ws); report('whatsapp:frame:w[unvetted]', cfg.mode === 'enforce'); }
    if (cfg.mode !== 'enforce') return true;
    try { ws.close(); } catch { /* already closing */ }
    return false;
  };

  const send = WebSocket.prototype.send;
  WebSocket.prototype.send = function (this: WebSocket, data: string | ArrayBufferLike | Blob | ArrayBufferView) {
    if (mayGo(this, data)) send.call(this, data as never);
  };

  return {
    configure(c) { cfg = c; allow = new Set(c.allow); },
  };
}

const existing = g[KEY];
if (existing) existing.configure(orSocketConfig);
else g[KEY] = install(orSocketConfig);
