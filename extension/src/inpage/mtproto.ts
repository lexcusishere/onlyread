// Telegram's MTProto requests, read before they are encrypted, and named. Telegram Web runs its protocol in a worker
// that hands each request, still readable, to its crypto worker to encrypt (`aes-encrypt`); telegram-worker.ts reads
// it there and this file says what it calls.
//
// A request (MTProto 2.0, before encryption): server salt, session id, message id (8 bytes each), sequence number and
// body length (4 each), the body, padding. The body is one call or a container of several; a call may be gzip-packed
// or wrapped (invokeWithLayer, initConnection, invokeAfterMsg, …) around the call that matters. Calls are named with
// Telegram's own schema, which its worker carries (`{id:…,method:\`messages.sendMessage\`…}`), so the table follows
// Telegram's updates. Shapes follow the codecs' convention: `telegram:r[<method>]` for a read, `telegram:w[<method>]`
// for a write, and anything not known is a write (fails closed).

/** MTProto's own constructors and wrappers: protocol constants, not part of the API schema. */
const MSG_CONTAINER = 0x73f1f8dc;
const GZIP_PACKED = 0x3072cfa1;
const SERVICE_READS = new Map<number, string>([
  [0x62d6b459, 'msgs_ack'], [0x7d861a08, 'msg_resend_req'], [0x8610baeb, 'msg_resend_ans_req'], [0xda69fb52, 'msgs_state_req'],
  [0x8cc0d131, 'msgs_all_info'], [0x58e4a740, 'rpc_drop_answer'], [0x7abe77ec, 'ping'], [0xf3427b8c, 'ping_delay_disconnect'],
  [0x9299359f, 'http_wait'], [0xb921bd04, 'get_future_salts'], [0xe7512126, 'destroy_session'],
  // The temporary key's binding, encrypted with the permanent key inside auth.bindTempAuthKey.
  [0x75a3f765, 'bind_auth_key_inner'],
]);
const INVOKE_WITH_LAYER = 0xda9b0d0d;
const INIT_CONNECTION = 0xc1cd5ea9;
const INVOKE_AFTER_MSG = 0xcb9f372d;
const INVOKE_AFTER_MSGS = 0x3dc4b4f0;
const INVOKE_WITHOUT_UPDATES = 0xbf9459b7;
const INVOKE_WITH_TAKEOUT = 0xaca9fd2e;
const INPUT_CLIENT_PROXY = 0x75588b3f;
const JSON_OBJECT_VALUE = 0xc0de1bd9;
const JSON_VALUE = { null: 0x3f6d7b68, bool: 0xc7345e6a, number: 0x2be0dfa4, string: 0xb71e767a, array: 0xf7444763, object: 0x99c1d49d };
const VECTOR = 0x1cb5c415;

/** Method id → name, as Telegram's worker script declares them. */
export function methodTable(script: string): Map<number, string> {
  const t = new Map<number, string>();
  for (const m of script.matchAll(/\{id:(-?\d+),method:`([\w.]+)`/g)) t.set(Number(m[1]) >>> 0, m[2]!);
  return t;
}

class Reader {
  p = 0;
  readonly u: Uint8Array;
  constructor(u: Uint8Array) { this.u = u; }
  u32(): number {
    if (this.p + 4 > this.u.length) throw new Error('end of request');
    const v = (this.u[this.p]! | (this.u[this.p + 1]! << 8) | (this.u[this.p + 2]! << 16) | (this.u[this.p + 3]! << 24)) >>> 0;
    this.p += 4;
    return v;
  }
  skip(n: number): void { if (this.p + n > this.u.length) throw new Error('end of request'); this.p += n; }
  /** A TL `bytes`/`string`: a 1- or 4-byte length, the data, padding to 4. */
  bytes(): Uint8Array {
    if (this.p >= this.u.length) throw new Error('end of request');
    let n = this.u[this.p]!;
    let head = 1;
    if (n === 254) { n = this.u[this.p + 1]! | (this.u[this.p + 2]! << 8) | (this.u[this.p + 3]! << 16); head = 4; }
    const start = this.p + head;
    if (start + n > this.u.length) throw new Error('end of request');
    this.p = start + n + ((4 - ((head + n) % 4)) % 4);
    return this.u.subarray(start, start + n);
  }
  rest(): Uint8Array { return this.u.subarray(this.p); }
}

/** A JSONValue's fields, after its constructor: none, a word, 8 bytes, a string, or a vector of values. */
function skipJsonFields(r: Reader, id: number, depth: number): void {
  if (id === JSON_VALUE.bool) { r.u32(); return; }
  if (id === JSON_VALUE.number) { r.skip(8); return; }
  if (id === JSON_VALUE.string) { r.bytes(); return; }
  if (r.u32() !== VECTOR) throw new Error('not a vector');
  const n = r.u32();
  for (let i = 0; i < n; i++) {
    if (id === JSON_VALUE.object) { if (r.u32() !== JSON_OBJECT_VALUE) throw new Error('not a json value'); r.bytes(); }
    skipJson(r, depth + 1);
  }
}

function skipJson(r: Reader, depth = 0): void {
  if (depth > 16) throw new Error('json too deep');
  const id = r.u32();
  if (id === JSON_VALUE.null) return;
  if (!Object.values(JSON_VALUE).includes(id)) throw new Error('unknown json value');
  skipJsonFields(r, id, depth);
}

/** The rest after initConnection's own fields: the call it wraps. */
function afterInitConnection(r: Reader): Uint8Array {
  const flags = r.u32();
  r.skip(4); // api_id
  for (let i = 0; i < 6; i++) r.bytes(); // device_model, system_version, app_version, system_lang_code, lang_pack, lang_code
  if (flags & 1) { if (r.u32() !== INPUT_CLIENT_PROXY) throw new Error('bad proxy'); r.bytes(); r.skip(4); }
  if (flags & 2) skipJson(r);
  return r.rest();
}

async function gunzip(data: Uint8Array): Promise<Uint8Array> {
  const out = new Response(new Blob([data.slice()]).stream().pipeThrough(new DecompressionStream("gzip")));
  return new Uint8Array(await out.arrayBuffer());
}

const MAX_DEPTH = 8;

/** The ids of the calls a body makes: containers opened, gzip unpacked, wrappers unwrapped. */
export async function calls(body: Uint8Array, depth = 0): Promise<number[]> {
  if (depth > MAX_DEPTH) throw new Error('request too deep');
  const r = new Reader(body);
  const id = r.u32();
  switch (id) {
    case MSG_CONTAINER: {
      const n = r.u32();
      const out: number[] = [];
      for (let i = 0; i < n; i++) {
        r.skip(12); // msg_id, seqno
        const len = r.u32();
        const inner = r.u.subarray(r.p, r.p + len);
        if (inner.length !== len) throw new Error('end of request');
        r.skip(len);
        out.push(...(await calls(inner, depth + 1)));
      }
      return out;
    }
    case GZIP_PACKED: return calls(await gunzip(r.bytes()), depth + 1);
    case INVOKE_WITH_LAYER: r.skip(4); return calls(r.rest(), depth + 1);
    case INVOKE_AFTER_MSG: r.skip(8); return calls(r.rest(), depth + 1);
    case INVOKE_WITH_TAKEOUT: r.skip(8); return calls(r.rest(), depth + 1);
    case INVOKE_WITHOUT_UPDATES: return calls(r.rest(), depth + 1);
    case INVOKE_AFTER_MSGS: { if (r.u32() !== VECTOR) throw new Error('not a vector'); r.skip(8 * r.u32()); return calls(r.rest(), depth + 1); }
    case INIT_CONNECTION: return calls(afterInitConnection(r), depth + 1);
    default: return [id];
  }
}

/** The body of a request as the worker hands it to `aes-encrypt`; undefined when it is not one (the key exchange
 *  encrypts other things with the same call). */
export function requestBody(plain: Uint8Array): Uint8Array | undefined {
  if (plain.length < 36) return undefined;
  const len = (plain[28]! | (plain[29]! << 8) | (plain[30]! << 16) | (plain[31]! << 24)) >>> 0;
  if (len < 4 || len % 4 !== 0 || 32 + len > plain.length || plain.length - 32 - len > 1024) return undefined;
  return plain.subarray(32, 32 + len);
}

/** How far a client message id's time may be from now. MTProto has the server refuse ids more than 300 seconds in the
 *  past or 30 in the future (by the server's clock, which the client follows); a day leaves room for this computer's
 *  clock being off. */
const MSG_TIME_SLACK = 86_400;

/** Whether plaintext is a request this client is sending, by everything MTProto requires of one: a message id the
 *  client made (divisible by 4) whose upper half is the time now, a body length that fits, and 12 to 1024 bytes of
 *  padding to a multiple of 16. Anything else the worker hashes or encrypts (a message from the server, the key
 *  exchange, a check of the stored key) fails it, and is never rewritten. */
export function isClientRequest(plain: Uint8Array, nowSeconds: number): boolean {
  if (plain.length < 48 || plain.length % 16 !== 0) return false;
  const v = new DataView(plain.buffer, plain.byteOffset, plain.byteLength);
  if (v.getUint32(16, true) % 4 !== 0) return false;
  if (Math.abs(v.getUint32(20, true) - nowSeconds) > MSG_TIME_SLACK) return false;
  const len = v.getUint32(28, true);
  const padding = plain.length - 32 - len;
  return len >= 4 && len % 4 === 0 && padding >= 12 && padding <= 1024;
}

/** Verbs of methods that only read. A `get` that acts is listed as a write below. */
const READ_VERB = /^(get|check|search|resolve|can|received|fetch)[A-Z]|^(get|check|search|resolve)$/;
/** Calls that keep the session up without changing anything the person made: key binding, moving to another data
 *  centre, the online status, client logs. */
const HOUSEKEEPING = new Set(['auth.bindTempAuthKey', 'auth.exportAuthorization', 'auth.importAuthorization', 'auth.dropTempAuthKeys', 'account.updateStatus', 'help.saveAppLog']);
/** Signing this browser in or out (docs/ARCHITECTURE.md "What counts as a write": sign-ins and sign-outs are reads):
 *  the code sent, resent, cancelled or reported missing, the code or a QR, web, bot, passkey or Firebase login on this
 *  device, and the log-out. Not here, so writes: creating an account (`auth.signUp`, `auth.firebasePnvSignUp`),
 *  approving another device's QR login (`auth.acceptLoginToken`: it gives that device a session), ending other
 *  sessions (`auth.resetAuthorizations`), password recovery and the login email (`auth.requestPasswordRecovery`,
 *  `auth.recoverPassword`, `auth.resetLoginEmail`: they change the account's sign-in itself), and
 *  `auth.cancelWebTokenAuthorization`, whose side is not known. `auth.checkPassword` and the other checks read by
 *  their verb. */
const SIGN_IN_OUT = new Set([
  'auth.sendCode', 'auth.resendCode', 'auth.cancelCode', 'auth.reportMissingCode', 'auth.requestFirebaseSms', 'auth.signIn',
  'auth.exportLoginToken', 'auth.importLoginToken', 'auth.importBotAuthorization', 'auth.importWebTokenAuthorization',
  'auth.initPasskeyLogin', 'auth.finishPasskeyLogin', 'auth.initFirebasePnvLogin', 'auth.finishFirebasePnvLogin', 'auth.logOut',
]);
/** Named like reads, but act: pressing a bot's button runs the bot's action. */
const ACTING_READS = new Set(['messages.getBotCallbackAnswer']);

/** What one call does, as a shape. */
export function shapeOfCall(id: number, table: Map<number, string>): string {
  const service = SERVICE_READS.get(id);
  if (service) return `telegram:r[${service}]`;
  const name = table.get(id);
  if (!name) return `telegram:w[unknown:0x${id.toString(16).padStart(8, '0')}]`;
  if (ACTING_READS.has(name)) return `telegram:w[${name}]`;
  const verb = name.split('.').pop() ?? '';
  return READ_VERB.test(verb) || HOUSEKEEPING.has(name) || SIGN_IN_OUT.has(name) || name.startsWith('langpack.') ? `telegram:r[${name}]` : `telegram:w[${name}]`;
}

/** The messages a body holds, where each one's own body sits in it: the body itself, or each message of a container. */
function messageSlots(body: Uint8Array): { offset: number; length: number }[] {
  const r = new Reader(body);
  if (r.u32() !== MSG_CONTAINER) return [{ offset: 0, length: body.length }];
  const n = r.u32();
  const out: { offset: number; length: number }[] = [];
  for (let i = 0; i < n; i++) {
    r.skip(12); // msg_id, seqno
    const length = r.u32();
    if (r.p + length > body.length) throw new Error('end of request');
    out.push({ offset: r.p, length });
    r.skip(length);
  }
  return out;
}

/** What a refused message's body becomes: a method no server knows, then filler to the same length. The server answers
 *  that one message with an error and the rest of the request goes as it was: lengths, padding, message ids and
 *  sequence numbers are untouched. */
export const REFUSED_METHOD = 0x0b1ebeef;

/** The request with every message that makes a write (not in `allow`) turned into the refused method, and those
 *  writes. Undefined when the plaintext is no request; an unreadable request comes back whole as one write (the
 *  caller refuses it outright). */
export async function refuseWrites(plain: Uint8Array, table: Map<number, string>, allow: Set<string>): Promise<{ plain: Uint8Array; writes: string[]; whole: boolean } | undefined> {
  const body = requestBody(plain);
  if (!body) return undefined;
  const bodyAt = 32; // salt, session id, message id, seqno, length
  try {
    const out = plain.slice();
    const writes: string[] = [];
    for (const slot of messageSlots(body)) {
      const shapes = (await calls(body.subarray(slot.offset, slot.offset + slot.length))).map((id) => shapeOfCall(id, table));
      const w = shapes.filter((x) => x.includes(':w[') && !allow.has(x));
      if (!w.length) continue;
      writes.push(...w);
      if (slot.length < 4) return { plain, writes: ['telegram:w[unparseable]'], whole: true };
      const at = bodyAt + slot.offset;
      out[at] = REFUSED_METHOD & 255; out[at + 1] = (REFUSED_METHOD >>> 8) & 255; out[at + 2] = (REFUSED_METHOD >>> 16) & 255; out[at + 3] = REFUSED_METHOD >>> 24;
      out.fill(0, at + 4, at + slot.length);
    }
    return { plain: out, writes, whole: false };
  } catch {
    return { plain, writes: ['telegram:w[unparseable]'], whole: true };
  }
}
