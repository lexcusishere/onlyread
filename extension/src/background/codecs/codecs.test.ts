import { describe, it, expect } from 'vitest';
import { CODECS, CODEC_WRITE_PREFIXES, decodeShape } from './index';
import { defaultPolicy, normalizePolicy } from '../policy';

describe('codec registry', () => {
  it('blocks every codec write prefix by default, and a stored policy cannot drop one', () => {
    for (const p of CODEC_WRITE_PREFIXES) expect(defaultPolicy().blockedShapes).toContain(p);
    const stored = { ...defaultPolicy(), blockedShapes: [] };
    for (const p of CODEC_WRITE_PREFIXES) expect(normalizePolicy(stored).blockedShapes).toContain(p);
  });

  it('fails closed: an unreadable body decodes to a write under the codec own prefix', () => {
    for (const c of CODECS) {
      const shape = c.decode('not a body this codec can read {', { template: '/', query: new URLSearchParams() });
      expect(c.writePrefixes.some((p) => shape.startsWith(p)), `${c.id} → ${shape}`).toBe(true);
    }
  });

  it('routes by host and path; requests no codec owns fall through', () => {
    expect(decodeShape('example.com', '/api/graphql/', '{"x":1}')).toBeUndefined();
    expect(decodeShape('www.facebook.com', '/api/graphql/', 'fb_api_req_friendly_name=FeedQuery')).toBe('fb:gql:r');
  });

  it('gives every codec a distinct id and prefixes no other codec uses', () => {
    expect(new Set(CODECS.map((c) => c.id)).size).toBe(CODECS.length);
    expect(new Set(CODEC_WRITE_PREFIXES).size).toBe(CODEC_WRITE_PREFIXES.length);
  });
});

describe('the Google Tasks codec', () => {
  it('reads filters nested far past its depth cap as no read, without walking them (no RangeError)', async () => {
    const { gtasks } = await import('./gtasks');
    const deep = `${'['.repeat(200_000)}${']'.repeat(200_000)}`;
    expect(gtasks.decode(`[[${deep}, []], null, [null, ["1094"]], null, ["cid", [null, 4]]]`, { template: "/$rpc/google.internal.tasks.v1.TasksApiService/Sync", query: new URLSearchParams() })).toBe('gtasks:sync:w[unknown]');
  });
});

describe('the Google Calendar codec', () => {
  const sync = (ops: unknown) => `f.req=${encodeURIComponent(JSON.stringify([[null, 's', null, null, ops], 20000]))}`;
  const decode = async (ops: unknown) => (await import('./gcal')).gcal.decode(sync(ops), { template: '/calendar/u/0/sync.sync', query: new URLSearchParams() });
  it('reads a token or fetch-spec entry that sets nothing else as a read', async () => {
    expect(await decode([[2, null, null, ['tok'], null, 368]])).toBe('gcal:sync:r');
    expect(await decode([[5, null, [[null, null, null, null, null, null, null, [4]], 'a@b.com'], null, null, 21]])).toBe('gcal:sync:r');
  });
  it('calls an entry unknown when a slot holds an object (sparse JSON+protobuf) or anything follows the latency', async () => {
    expect(await decode([[5, { 1: [[['key', 'v']]] }, null, ['tok']]])).toBe('gcal:sync:w[unknown]');
    expect(await decode([[5, null, { 1: [null, ['evt1']] }, ['tok']]])).toBe('gcal:sync:w[unknown]');
    expect(await decode([[5, null, null, ['tok'], null, 5, { 9: ['evt'] }]])).toBe('gcal:sync:w[unknown]');
    expect(await decode([[5, { 1: 'x' }, [[null, null, null, null, null, null, null, [4]], 'a@b.com'], null, null, 21]])).toBe('gcal:sync:w[unknown]');
  });
});
