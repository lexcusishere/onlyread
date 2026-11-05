import { describe, expect, it } from 'vitest';
import { calls, isClientRequest, methodTable, REFUSED_METHOD, refuseWrites, requestBody, shapeOfCall } from './mtproto';
import { shapesOf } from './mtproto.testing';

// The schema as Telegram's worker script declares it (excerpt, its real ids).
const SCRIPT = [
  '{id:-17526942,method:`messages.sendMessage`,params:[],type:`Updates`}',
  '{id:1143203525,method:`messages.getHistory`,params:[],type:`messages.Messages`}',
  '{id:238054714,method:`messages.readHistory`,params:[],type:`messages.AffectedMessages`}',
  '{id:1486110434,method:`messages.setTyping`,params:[],type:`Bool`}',
  '{id:1713919532,method:`account.updateStatus`,params:[],type:`Bool`}',
  '{id:-1824339449,method:`messages.getBotCallbackAnswer`,params:[],type:`messages.BotCallbackAnswer`}',
  '{id:-1391484580,method:`messages.saveDraft`,params:[],type:`Bool`}',
].join(',');
const table = methodTable(SCRIPT);

const le = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
const id = (name: string) => [...table].find(([, n]) => n === name)![0];
const call = (name: string, args: number[] = []) => [...le(id(name)), ...args];
const tlBytes = (b: number[]) => { const head = b.length < 254 ? [b.length] : [254, b.length & 255, (b.length >> 8) & 255, (b.length >> 16) & 255]; const out = [...head, ...b]; while (out.length % 4) out.push(0); return out; };
const container = (...bodies: number[][]) => [...le(0x73f1f8dc), ...le(bodies.length), ...bodies.flatMap((b, i) => [...le(i + 1), 0, 0, 0, 0, ...le(i * 2 + 1), ...le(b.length), ...b])];
/** A request as the worker hands it to aes-encrypt: zeroed salt, session and message ids, then length, body, padding. */
const request = (body: number[]) => Uint8Array.from([...new Array(24).fill(0), ...le(1), ...le(body.length), ...body, ...new Array(16).fill(0)]);

describe('methodTable', () => {
  it('reads Telegram\'s schema declarations, ids as unsigned', () => {
    expect(table.get(0xfef48f62)).toBe('messages.sendMessage');
    expect(table.get(0x4423e6c5)).toBe('messages.getHistory');
  });
});

describe('shapes', () => {
  it('names reads, writes, housekeeping and acting reads', () => {
    expect(shapeOfCall(id('messages.getHistory'), table)).toBe('telegram:r[messages.getHistory]');
    expect(shapeOfCall(id('messages.sendMessage'), table)).toBe('telegram:w[messages.sendMessage]');
    expect(shapeOfCall(id('account.updateStatus'), table)).toBe('telegram:r[account.updateStatus]');
    expect(shapeOfCall(id('messages.getBotCallbackAnswer'), table)).toBe('telegram:w[messages.getBotCallbackAnswer]');
    expect(shapeOfCall(id('messages.readHistory'), table)).toBe('telegram:w[messages.readHistory]');
    expect(shapeOfCall(0x62d6b459, table)).toBe('telegram:r[msgs_ack]');
    expect(shapeOfCall(0x12345678, table)).toBe('telegram:w[unknown:0x12345678]');
  });

  // Ids from the schema (TDLib's telegram_api.tl). Signing this browser in or out is a read; creating an account, letting
  // another device in, ending other sessions and changing the account's sign-in are writes.
  it('reads signing in and out; writes creating an account and acting on other sessions or the password', () => {
    const AUTH: [string, number][] = [
      ['auth.sendCode', 0xa677244f], ['auth.resendCode', 0xcae47523], ['auth.cancelCode', 0x1f040578], ['auth.signIn', 0x8d52a951],
      ['auth.checkPassword', 0xd18b4d16], ['auth.exportLoginToken', 0xb7e085fe], ['auth.importLoginToken', 0x95ac5ce4],
      ['auth.logOut', 0x3e72ba19], ['auth.dropTempAuthKeys', 0x8e48a188],
      ['auth.signUp', 0xaac7b717], ['auth.acceptLoginToken', 0xe894ad4d], ['auth.resetAuthorizations', 0x9fab0d1a],
      ['auth.requestPasswordRecovery', 0xd897bc66], ['auth.recoverPassword', 0x37096c70], ['auth.resetLoginEmail', 0x7e960193],
      ['account.resetAuthorization', 0xdf77f3bc],
    ];
    const t = methodTable(AUTH.map(([m, n]) => `{id:${n | 0},method:\`${m}\`,params:[],type:\`X\`}`).join(','));
    const shape = (m: string) => shapeOfCall(AUTH.find(([n]) => n === m)![1], t);
    for (const m of ['auth.sendCode', 'auth.resendCode', 'auth.cancelCode', 'auth.signIn', 'auth.checkPassword', 'auth.exportLoginToken', 'auth.importLoginToken', 'auth.logOut', 'auth.dropTempAuthKeys']) {
      expect(shape(m)).toBe(`telegram:r[${m}]`);
    }
    for (const m of ['auth.signUp', 'auth.acceptLoginToken', 'auth.resetAuthorizations', 'auth.requestPasswordRecovery', 'auth.recoverPassword', 'auth.resetLoginEmail', 'account.resetAuthorization']) {
      expect(shape(m)).toBe(`telegram:w[${m}]`);
    }
  });

  it('opens containers and unwraps invokeWithLayer, invokeAfterMsg and initConnection', async () => {
    const init = [...le(0xc1cd5ea9), ...le(2), ...le(2496), ...[1, 2, 3, 4, 5, 6].flatMap((n) => tlBytes(new Array(n).fill(97))),
      ...le(0x99c1d49d), ...le(0x1cb5c415), ...le(1), ...le(0xc0de1bd9), ...tlBytes([116, 122]), ...le(0xb71e767a), ...tlBytes([85, 84, 67]),
      ...call('messages.getHistory', [0, 0, 0, 0])];
    const wrapped = [...le(0xda9b0d0d), ...le(214), ...init];
    const after = [...le(0xcb9f372d), ...new Array(8).fill(1), ...call('messages.sendMessage', [9, 9, 9, 9])];
    const ack = [...le(0x62d6b459), ...le(0x1cb5c415), ...le(0)];
    expect(await shapesOf(request(container(wrapped, after, ack)), table)).toEqual([
      'telegram:r[messages.getHistory]', 'telegram:w[messages.sendMessage]', 'telegram:r[msgs_ack]',
    ]);
  });

  it('unpacks gzip_packed', async () => {
    const inner = Uint8Array.from(call('messages.saveDraft', [1, 2, 3, 4]));
    const gz = new Uint8Array(await new Response(new Blob([inner]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
    expect(await calls(Uint8Array.from([...le(0x3072cfa1), ...tlBytes([...gz])]))).toEqual([id('messages.saveDraft')]);
  });

  it('fails closed on a request it cannot read, and says when the plaintext is no request at all', async () => {
    expect(await shapesOf(request([...le(0x73f1f8dc), ...le(3)]), table)).toEqual(['telegram:w[unparseable]']);
    expect(requestBody(new Uint8Array(224).fill(7))).toBeUndefined(); // the key exchange's data
  });
});

describe('refuseWrites', () => {
  const history = call('messages.getHistory', [1, 2, 3, 4]);
  const send = call('messages.sendMessage', [9, 9, 9, 9, 8, 8, 8, 8]);
  const ack = [...le(0x62d6b459), ...le(0x1cb5c415), ...le(0)];

  it('turns each write of a container into the refused method, same length, and leaves the reads as they were', async () => {
    const plain = request(container(history, send, ack));
    const r = (await refuseWrites(plain, table, new Set()))!;
    expect(r.whole).toBe(false);
    expect(r.writes).toEqual(['telegram:w[messages.sendMessage]']);
    expect(r.plain.length).toBe(plain.length);
    expect(await shapesOf(r.plain, table)).toEqual([
      'telegram:r[messages.getHistory]', `telegram:w[unknown:0x${REFUSED_METHOD.toString(16).padStart(8, '0')}]`, 'telegram:r[msgs_ack]',
    ]);
    // Only the write's body changed: its method, then zeros; every other byte (ids, seqnos, lengths, reads, padding) is the same.
    const changed = [...plain.keys()].filter((i) => plain[i] !== r.plain[i]);
    const at = 32 + 8 + 16 + history.length + 16; // header, container head, first message, second message's head
    expect(Math.min(...changed)).toBeGreaterThanOrEqual(at);
    expect(Math.max(...changed)).toBeLessThan(at + send.length);
    expect([...r.plain.subarray(at + 4, at + send.length)].every((b) => b === 0)).toBe(true);
    expect([...plain]).toEqual([...request(container(history, send, ack))]); // the input is not changed in place
  });

  it('rewrites a lone write, lets allowed writes and reads go untouched, and says when nothing changed', async () => {
    const lone = (await refuseWrites(request(send), table, new Set()))!;
    expect(lone.writes).toEqual(['telegram:w[messages.sendMessage]']);
    expect(await shapesOf(lone.plain, table)).toEqual([`telegram:w[unknown:0x${REFUSED_METHOD.toString(16).padStart(8, '0')}]`]);
    const allowed = (await refuseWrites(request(send), table, new Set(['telegram:w[messages.sendMessage]'])))!;
    expect(allowed.writes).toEqual([]);
    expect([...allowed.plain]).toEqual([...request(send)]);
    const reads = (await refuseWrites(request(container(history, ack)), table, new Set()))!;
    expect(reads.writes).toEqual([]);
  });

  it('refuses an unreadable request whole, and passes over plaintext that is no request', async () => {
    const bad = (await refuseWrites(request([...le(0x73f1f8dc), ...le(3)]), table, new Set()))!;
    expect(bad).toMatchObject({ whole: true, writes: ['telegram:w[unparseable]'] });
    expect(await refuseWrites(new Uint8Array(224).fill(7), table, new Set())).toBeUndefined();
  });
});

describe('isClientRequest', () => {
  const NOW = 1_790_000_000;
  /** A request as the client sends it: salt, session, a message id of `time` and `low`, seqno, length, body, padding. */
  const sent = (body: number[], { time = NOW, low = 4, pad = 16 } = {}) => {
    let padding = pad;
    while ((32 + body.length + padding) % 16) padding++;
    return Uint8Array.from([...new Array(16).fill(7), ...le(low), ...le(time), ...le(1), ...le(body.length), ...body, ...new Array(padding).fill(9)]);
  };
  const body = call('messages.sendMessage', [1, 2, 3, 4]);

  it('takes a request the client is sending', () => {
    expect(isClientRequest(sent(body), NOW)).toBe(true);
    expect(isClientRequest(sent(body, { time: NOW - 3600 }), NOW)).toBe(true); // this computer's clock an hour off
  });

  it('passes over a message from the server, a stale or future id, and wrong lengths or padding', () => {
    expect(isClientRequest(sent(body, { low: 5 }), NOW)).toBe(false); // a server reply's id
    expect(isClientRequest(sent(body, { low: 7 }), NOW)).toBe(false); // the server's own message
    expect(isClientRequest(sent(body, { time: NOW - 3 * 86_400 }), NOW)).toBe(false);
    expect(isClientRequest(sent(body, { time: NOW + 3 * 86_400 }), NOW)).toBe(false);
    expect(isClientRequest(sent(body, { pad: 1025 }), NOW)).toBe(false);
    const short = sent(body); short[28] = body.length + 32; // padding left under 12
    expect(isClientRequest(short, NOW)).toBe(false);
    expect(isClientRequest(sent(body).subarray(0, 56), NOW)).toBe(false); // not a multiple of 16
  });

  it('never takes random bytes (what the key exchange and stored-key checks hash)', () => {
    let seed = 12345;
    const rand = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed >>> 24; };
    for (let n = 0; n < 20_000; n++) {
      const len = 48 + 16 * (rand() % 32);
      const bytes = Uint8Array.from({ length: len }, rand);
      expect(isClientRequest(bytes, NOW)).toBe(false);
    }
  });
});
