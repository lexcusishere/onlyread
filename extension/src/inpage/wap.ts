// WhatsApp Web's stanzas: decode the binary XML ("WAP") a frame carries before it is encrypted, and name what it does.
// WhatsApp Web sends every read and write over one socket, wss://web.whatsapp.com/ws/chat, encrypted twice (TLS, then
// the Noise protocol inside the page), so neither the network layer nor a proxy can tell a read from a send. The page
// encrypts each frame with the browser's own AES-GCM (SubtleCrypto.encrypt); the plaintext there is a flag byte and one
// stanza. whatsapp-socket.ts reads it at that call, and this file names it.
//
// A stanza is a list: a tag, attribute pairs, then children or content. Strings are dictionary tokens (wap-tokens.json,
// the page's WAWapDict), raw bytes, packed digits or a JID. Shapes follow the codecs' convention: `whatsapp:<tag>:r[…]`
// for a read, `whatsapp:<tag>:w[…]` for a write, and anything not recognised is a write (fails closed).
import tokens from './wap-tokens.json' with { type: 'json' };

export interface WapNode { tag: string; attrs: Record<string, string>; kids: WapNode[] | null; content: string | null }

const LIST_EMPTY = 0, DICT_0 = 236, DICT_3 = 239, AD_JID = 247, LIST_8 = 248, LIST_16 = 249, JID_PAIR = 250;
const HEX_8 = 251, BINARY_8 = 252, BINARY_20 = 253, BINARY_32 = 254, NIBBLE_8 = 255;
const MAX_DEPTH = 32;

/** Bytes as text when they read as a short printable word (an attribute value), else a length marker: the decoder
 *  only needs names, never a message's bytes. */
function bytesText(b: Uint8Array): string {
  if (b.length > 64) return `<bin${b.length}>`;
  for (const x of b) if (x < 0x20 || x > 0x7e) return `<bin${b.length}>`;
  return String.fromCharCode(...b);
}

class Reader {
  p = 0;
  constructor(private readonly u: Uint8Array) {}
  byte(): number {
    if (this.p >= this.u.length) throw new Error('end of stanza');
    return this.u[this.p++]!;
  }
  int(n: number): number { let v = 0; for (let i = 0; i < n; i++) v = v * 256 + this.byte(); return v; }
  bytes(n: number): Uint8Array {
    if (this.p + n > this.u.length) throw new Error('end of stanza');
    const b = this.u.subarray(this.p, this.p + n);
    this.p += n;
    return b;
  }
  listSize(t: number): number { return t === LIST_8 ? this.byte() : t === LIST_16 ? this.int(2) : t === LIST_EMPTY ? 0 : -1; }
  packed(t: number): string {
    const head = this.byte();
    const alphabet = t === HEX_8 ? '0123456789ABCDEF' : '0123456789-.';
    let out = '';
    for (let i = 0; i < (head & 0x7f); i++) {
      const b = this.byte();
      out += (alphabet[b >> 4] ?? '') + (alphabet[b & 15] ?? '');
    }
    return head >> 7 ? out.slice(0, -1) : out;
  }
  str(t: number): string {
    if (t >= 1 && t < DICT_0) return tokens.single[t - 1] ?? `?${t}`;
    if (t >= DICT_0 && t <= DICT_3) return tokens.double[t - DICT_0]?.[this.byte()] ?? `?${t}`;
    switch (t) {
      case LIST_EMPTY: return '';
      case BINARY_8: return bytesText(this.bytes(this.byte()));
      case BINARY_20: return bytesText(this.bytes(((this.byte() & 15) << 16) | this.int(2)));
      case BINARY_32: return bytesText(this.bytes(this.int(4)));
      case JID_PAIR: { const user = this.str(this.byte()); return `${user ? 'u' : ''}@${this.str(this.byte())}`; }
      case AD_JID: { this.byte(); this.byte(); this.str(this.byte()); return 'u@ad'; }
      case HEX_8: case NIBBLE_8: return this.packed(t);
      default: throw new Error(`bad token ${t}`);
    }
  }
  node(depth = 0): WapNode {
    if (depth > MAX_DEPTH) throw new Error('stanza too deep');
    const size = this.listSize(this.byte());
    if (size <= 0) throw new Error('empty node');
    const tag = this.str(this.byte());
    const attrs: Record<string, string> = {};
    for (let i = 0; i < (size - 1) >> 1; i++) { const k = this.str(this.byte()); attrs[k] = this.str(this.byte()); }
    if (size % 2 === 1) return { tag, attrs, kids: null, content: null };
    const t = this.byte();
    const n = this.listSize(t);
    if (n < 0) return { tag, attrs, kids: null, content: this.str(t) };
    const kids: WapNode[] = [];
    for (let i = 0; i < n; i++) kids.push(this.node(depth + 1));
    return { tag, attrs, kids, content: null };
  }
}

/** The stanza a frame's plaintext carries: flag byte 0 (uncompressed) and one node. Undefined when it is not one: a
 *  compressed frame (flag 2), the handshake's payloads, or the page's other AES-GCM work (its encrypted local storage). */
export function decodeFrame(plain: Uint8Array): WapNode | undefined {
  if (plain.length < 3 || plain[0] !== 0 || (plain[1] !== LIST_8 && plain[1] !== LIST_16)) return undefined;
  try {
    const r = new Reader(plain.subarray(1));
    const node = r.node();
    return r.p === plain.length - 1 ? node : undefined;
  } catch {
    return undefined;
  }
}

function has(node: WapNode, tag: string, depth = 0): boolean {
  if (depth > MAX_DEPTH) return false;
  return Boolean(node.kids?.some((k) => k.tag === tag || has(k, tag, depth + 1)));
}

const word = (s: string | undefined) => (s && /^[\w:.-]{1,40}$/.test(s) ? s : '?');

/** `iq type=set` namespaces that change nothing the person made: media hosts, the client's own stats, keys, the
 *  passive/active switch, the server's dirty bits, the keepalive. Everything else set is a write. */
const IQ_SET_READS = new Set(['w:m', 'w:stats', 'encrypt', 'passive', 'urn:xmpp:whatsapp:dirty', 'w:p', 'urn:xmpp:ping']);
/** Receipts that tell others the person read or played something: read-tracking, not a change of content. */
const READ_RECEIPTS = new Set(['read', 'read-self', 'played', 'played-self']);

/** Logging this browser out (a sign-out is a read: docs/ARCHITECTURE.md "What counts as a write"):
 *  `<iq type=set xmlns=md to=s.whatsapp.net><remove-companion-device jid=<a device jid> reason=…/></iq>`, its one child
 *  carrying nothing more (the form Baileys sends for its own log-out, jid its own device's). The decoder keeps no
 *  account or device number (a device jid reads `u@ad`), so which device is named is not checked: a companion asking to
 *  unlink another device would pass too. Everything else in `md` (pairing steps, other device changes) is a write. */
function companionLogOut(n: WapNode): boolean {
  const kid = n.kids?.length === 1 ? n.kids[0]! : undefined;
  if (kid?.tag !== 'remove-companion-device' || kid.kids !== null || kid.content !== null) return false;
  const keys = Object.keys(kid.attrs);
  const to = n.attrs.to;
  return kid.attrs.jid === 'u@ad' && keys.every((k) => k === 'jid' || k === 'reason') && (to === '@s.whatsapp.net' || to === 's.whatsapp.net');
}

function iqShape(n: WapNode): string {
  const type = n.attrs.type;
  const ns = word(n.attrs.xmlns);
  if (type === 'get' || type === 'result' || type === 'error') return `whatsapp:iq:r[${ns}]`;
  if (type !== 'set') return `whatsapp:iq:w[${word(type)}:${ns}]`;
  // App-state sync: a fetch names collections; a change (star, archive, pin, mute, mark read, labels) carries a patch.
  if (ns === 'w:sync:app:state') return has(n, 'patch') ? 'whatsapp:iq:w[app-state]' : 'whatsapp:iq:r[app-state]';
  if (ns === 'md' && companionLogOut(n)) return 'whatsapp:iq:r[md:signout]';
  return IQ_SET_READS.has(ns) ? `whatsapp:iq:r[${ns}]` : `whatsapp:iq:w[${ns}]`;
}

function messageShape(n: WapNode): string {
  // Peer messages go to the person's own devices only (key shares, history-sync requests): housekeeping.
  if (n.attrs.category === 'peer') return 'whatsapp:message:r[peer]';
  const edit = n.attrs.edit ? `:edit${word(n.attrs.edit)}` : '';
  return `whatsapp:message:w[${word(n.attrs.type)}${edit}]`;
}

/** What a stanza does, as a shape. Writes: messages (send, react, edit, pin, delete), calls, app-state changes, group
 *  and settings changes. Reads: queries, acknowledgements, delivery receipts, presence, the keepalive. Read receipts
 *  and the typing indicator are writes the read-tracking setting can allow. Anything else is a write. */
export function shapeOf(n: WapNode): string {
  switch (n.tag) {
    case 'iq': return iqShape(n);
    case 'message': return messageShape(n);
    case 'receipt': return READ_RECEIPTS.has(n.attrs.type ?? '') ? `whatsapp:receipt:w[${n.attrs.type}]` : `whatsapp:receipt:r[${word(n.attrs.type ?? 'delivery')}]`;
    case 'ack': return `whatsapp:ack:r[${word(n.attrs.class)}]`;
    case 'presence': return `whatsapp:presence:r[${word(n.attrs.type ?? 'available')}]`;
    case 'ib': return 'whatsapp:ib:r';
    case 'chatstate': return `whatsapp:chatstate:w[${word(n.kids?.[0]?.tag)}]`;
    case 'call': return 'whatsapp:call:w[call]';
    default: return `whatsapp:${word(n.tag)}:w[unknown]`;
  }
}

/** A shape that reads: anything outside the `:w[` form. */
export const isRead = (shape: string): boolean => !shape.includes(':w[');

const ID_PREFIX = [0x6f, 0x72]; // "or"
/** A keepalive (`<iq id type=get xmlns=w:p to=s.whatsapp.net/>`) to send in a refused stanza's place: each frame takes
 *  the next Noise counter, so dropping one would break the connection; a ping keeps the count and changes nothing.
 *  The id is printable ASCII, unique per call. */
export function pingFrame(seq: number, now = Date.now()): Uint8Array {
  const id = [...ID_PREFIX, ...Array.from(`${now.toString(36)}${seq.toString(36)}`, (c) => c.charCodeAt(0))];
  // list(9): iq, id=<binary>, type=get, xmlns=w:p, to=<jid pair: no user, s.whatsapp.net>
  return new Uint8Array([0, LIST_8, 9, 0x19, 0x08, BINARY_8, id.length, ...id, 0x04, 0x29, 0x16, 0x57, 0x11, JID_PAIR, LIST_EMPTY, 0x03]);
}
