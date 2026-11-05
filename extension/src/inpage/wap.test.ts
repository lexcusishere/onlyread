import { describe, expect, it } from 'vitest';
import tokens from './wap-tokens.json';
import { decodeFrame, isRead, pingFrame, shapeOf, type WapNode } from './wap';

const hex = (h: string) => Uint8Array.from(h.match(/../g)!.map((b) => Number.parseInt(b, 16)));

// Frames as WhatsApp Web encrypted them (plaintext at SubtleCrypto.encrypt), recorded on a live session, with the
// account's identifiers (group and user ids, message and session ids) replaced by zeros.
const KEEPALIVE = '00f8091908ff8837986b35343a102f0429165711fa0003';
const ACK = '00f80b1b11faff091203630000000000001c08fb0b3eb0000000000000000000150704ec2505f70100ff0710000000000000';
const IB = '00f802fc026962f801f803fc0f756e69666965645f73657373696f6e08ff0400000000';

/** A minimal encoder for test stanzas: dictionary tokens where the word is one, raw bytes otherwise. */
function encode(n: { tag: string; attrs?: Record<string, string>; kids?: Parameters<typeof encode>[0][] }): number[] {
  const str = (s: string): number[] => {
    const i = tokens.single.indexOf(s);
    if (i >= 0) return [i + 1];
    const b = Array.from(s, (c) => c.charCodeAt(0));
    return [0xfc, b.length, ...b];
  };
  const attrs = Object.entries(n.attrs ?? {});
  const size = 1 + attrs.length * 2 + (n.kids ? 1 : 0);
  const out = [0xf8, size, ...str(n.tag), ...attrs.flatMap(([k, v]) => [...str(k), ...str(v)])];
  if (n.kids) out.push(0xf8, n.kids.length, ...n.kids.flatMap(encode));
  return out;
}
const frame = (n: Parameters<typeof encode>[0]) => Uint8Array.from([0, ...encode(n)]);
const shape = (n: Parameters<typeof encode>[0]) => shapeOf(decodeFrame(frame(n)) as WapNode);

describe('decodeFrame', () => {
  it('reads recorded frames', () => {
    expect(decodeFrame(hex(KEEPALIVE))).toMatchObject({ tag: 'iq', attrs: { type: 'get', xmlns: 'w:p', to: '@s.whatsapp.net' } });
    expect(decodeFrame(hex(ACK))).toMatchObject({ tag: 'ack', attrs: { class: 'receipt', type: 'sender' } });
    expect(decodeFrame(hex(IB))?.tag).toBe('ib');
  });

  it('is not a stanza: compressed, not a list, cut short, or with bytes left over', () => {
    expect(decodeFrame(hex(`02${KEEPALIVE.slice(2)}`))).toBeUndefined();
    expect(decodeFrame(hex('0a1b2c3d'))).toBeUndefined();
    expect(decodeFrame(hex(KEEPALIVE.slice(0, 20)))).toBeUndefined();
    expect(decodeFrame(hex(`${KEEPALIVE}00`))).toBeUndefined();
  });
});

describe('shapeOf', () => {
  it('names the recorded reads', () => {
    expect(shapeOf(decodeFrame(hex(KEEPALIVE))!)).toBe('whatsapp:iq:r[w:p]');
    expect(shapeOf(decodeFrame(hex(ACK))!)).toBe('whatsapp:ack:r[receipt]');
    expect(shapeOf(decodeFrame(hex(IB))!)).toBe('whatsapp:ib:r');
  });

  it('refuses every kind of message', () => {
    expect(shape({ tag: 'message', attrs: { type: 'text' } })).toBe('whatsapp:message:w[text]');
    expect(shape({ tag: 'message', attrs: { type: 'reaction' } })).toBe('whatsapp:message:w[reaction]');
    expect(shape({ tag: 'message', attrs: { type: 'text', edit: '7' } })).toBe('whatsapp:message:w[text:edit7]');
    expect(shape({ tag: 'message', attrs: { type: 'media' } })).toBe('whatsapp:message:w[media]');
    // To the person's own devices only (key shares, history-sync requests).
    expect(shape({ tag: 'message', attrs: { type: 'text', category: 'peer' } })).toBe('whatsapp:message:r[peer]');
  });

  it('tells an app-state change from a fetch, and group changes from queries', () => {
    const sync = (patch: boolean) => ({ tag: 'iq', attrs: { type: 'set', xmlns: 'w:sync:app:state' }, kids: [{ tag: 'sync', kids: [{ tag: 'collection', attrs: { name: 'regular_high' }, ...(patch ? { kids: [{ tag: 'patch' }] } : {}) }] }] });
    expect(shape(sync(true))).toBe('whatsapp:iq:w[app-state]');
    expect(shape(sync(false))).toBe('whatsapp:iq:r[app-state]');
    expect(shape({ tag: 'iq', attrs: { type: 'set', xmlns: 'w:g2' }, kids: [{ tag: 'description' }] })).toBe('whatsapp:iq:w[w:g2]');
    expect(shape({ tag: 'iq', attrs: { type: 'get', xmlns: 'w:g2' } })).toBe('whatsapp:iq:r[w:g2]');
    expect(shape({ tag: 'iq', attrs: { type: 'set', xmlns: 'w:m' }, kids: [{ tag: 'media_conn' }] })).toBe('whatsapp:iq:r[w:m]');
    expect(shape({ tag: 'iq', attrs: { type: 'set', xmlns: 'privacy' } })).toBe('whatsapp:iq:w[privacy]');
  });

  it('puts read receipts and typing with the writes, delivery receipts with the reads', () => {
    expect(shape({ tag: 'receipt', attrs: { type: 'read' } })).toBe('whatsapp:receipt:w[read]');
    expect(shape({ tag: 'receipt' })).toBe('whatsapp:receipt:r[delivery]');
    expect(shape({ tag: 'chatstate', kids: [{ tag: 'composing' }] })).toBe('whatsapp:chatstate:w[composing]');
  });

  it('fails closed on what it does not know', () => {
    expect(shape({ tag: 'call' })).toBe('whatsapp:call:w[call]');
    expect(shape({ tag: 'newthing' })).toBe('whatsapp:newthing:w[unknown]');
    expect(isRead('whatsapp:newthing:w[unknown]')).toBe(false);
    expect(isRead('whatsapp:iq:r[usync]')).toBe(true);
  });

  // Logging out: `<iq type=set xmlns=md to=@s.whatsapp.net><remove-companion-device jid=<device jid> reason=user_initiated/>`,
  // as Baileys sends it (its own device's jid, an AD jid on the wire). Inferred from Baileys, not recorded.
  it('reads logging this browser out; every other md change is a write', () => {
    const raw = (s: string) => { const i = tokens.single.indexOf(s); return i >= 0 ? [i + 1] : [0xfc, s.length, ...Array.from(s, (c) => c.charCodeAt(0))]; };
    const adJid = [247, 0, 12, ...raw('15550000000')]; // agent 0, device 12
    const pairTo = [250, 0, ...raw('s.whatsapp.net')]; // the server: a jid pair with no user
    /** An iq set in `xmlns`, with one child: its tag and attributes (a value of `null` is the device jid). */
    const iq = (xmlns: string, child: [string, Record<string, string | null>][], to = pairTo) => {
      const head = [...raw('iq'), ...raw('id'), ...raw('1'), ...raw('type'), ...raw('set'), ...raw('xmlns'), ...raw(xmlns), ...raw('to'), ...to];
      const kids = child.flatMap(([tag, attrs]) => {
        const a = Object.entries(attrs);
        return [0xf8, 1 + a.length * 2, ...raw(tag), ...a.flatMap(([k, v]) => [...raw(k), ...(v === null ? adJid : raw(v))])];
      });
      return shapeOf(decodeFrame(Uint8Array.from([0, 0xf8, 10, ...head, 0xf8, child.length, ...kids])) as WapNode);
    };
    expect(iq('md', [['remove-companion-device', { jid: null, reason: 'user_initiated' }]])).toBe('whatsapp:iq:r[md:signout]');
    expect(iq('md', [['remove-companion-device', { jid: null }]])).toBe('whatsapp:iq:r[md:signout]');
    // Stays a write: another md child (pairing by code), a second child, more attributes, a jid that names no device,
    // another server, or the same child in another namespace.
    expect(iq('md', [['link_code_companion_reg', { jid: null, stage: 'companion_hello' }]])).toBe('whatsapp:iq:w[md]');
    expect(iq('md', [['remove-companion-device', { jid: null, reason: 'user_initiated' }], ['remove-companion-device', { jid: null }]])).toBe('whatsapp:iq:w[md]');
    expect(iq('md', [['remove-companion-device', { jid: null, reason: 'user_initiated', all: 'true' }]])).toBe('whatsapp:iq:w[md]');
    expect(iq('md', [['remove-companion-device', { jid: 'someone', reason: 'user_initiated' }]])).toBe('whatsapp:iq:w[md]');
    expect(iq('md', [['remove-companion-device', { jid: null }]], [250, ...raw('1555'), ...raw('s.whatsapp.net')])).toBe('whatsapp:iq:w[md]');
    expect(iq('w:g2', [['remove-companion-device', { jid: null }]])).toBe('whatsapp:iq:w[w:g2]');
  });
});

describe('pingFrame', () => {
  it('is a keepalive the decoder reads back, with a fresh id each time', () => {
    const a = decodeFrame(pingFrame(0, 1));
    const b = decodeFrame(pingFrame(1, 1));
    expect(a).toMatchObject({ tag: 'iq', attrs: { type: 'get', xmlns: 'w:p', to: '@s.whatsapp.net' } });
    expect(shapeOf(a!)).toBe('whatsapp:iq:r[w:p]');
    expect(a!.attrs.id).not.toBe(b!.attrs.id);
    expect(a!.attrs.id).toMatch(/^or[0-9a-z]+$/);
  });
});
