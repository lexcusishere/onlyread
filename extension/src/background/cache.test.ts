import { describe, it, expect, vi, afterEach } from 'vitest';
import type { CacheEntry } from '../shared/types';
import { prune } from './cache';

// An allow saved under the old fingerprint format may cover operations the new
// format separates, even when the key text did not change. On a format change every stored verdict goes.
describe('verdict cache format', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });
  const storage = (init: Record<string, unknown>) => {
    const data: Record<string, unknown> = { ...init };
    vi.stubGlobal('chrome', { storage: { local: {
      get: async (k: string) => (k in data ? { [k]: data[k] } : {}),
      set: async (o: Record<string, unknown>) => { Object.assign(data, o); },
    } } });
    return data;
  };

  it('drops verdicts saved under an older format, including keys whose text is unchanged', async () => {
    const data = storage({ verdictCache: { 'POST example.com/batch json[]:action,id': { verdict: 'allow', pWrite: 0.01, source: 'jev', count: 3, firstSeen: 1, lastSeen: 2 } } });
    const cache = await import('./cache');
    expect(await cache.ensureFormat()).toBe(true);
    expect(await cache.get('POST example.com/batch json[]:action,id')).toBeUndefined();
    expect(data.verdictCacheFormat).toBe(cache.CACHE_FORMAT);
  });
  it('keeps verdicts saved under the current format', async () => {
    storage({ verdictCacheFormat: 6, verdictCache: { 'GET a.com/x none': { verdict: 'allow', pWrite: 0, source: 'label', count: 1, firstSeen: 1, lastSeen: 1 } } });
    const cache = await import('./cache');
    expect(cache.CACHE_FORMAT).toBe(6);
    expect(await cache.ensureFormat()).toBe(false);
    expect((await cache.get('GET a.com/x none'))?.verdict).toBe('allow');
  });
});

// One rejected write must not poison the chain (every later put and touch rejecting would fail every request a
// label answered): a failure is reported and the next write goes through.
describe('verdict cache writes', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });
  const storage = () => {
    const s = { data: {} as Record<string, unknown>, failNext: false, sets: 0 };
    vi.stubGlobal('chrome', { storage: { local: {
      get: async (k: string) => (k in s.data ? { [k]: s.data[k] } : {}),
      set: async (o: Record<string, unknown>) => { s.sets++; if (s.failNext) { s.failNext = false; throw new Error('QUOTA_BYTES quota exceeded'); } Object.assign(s.data, structuredClone(o)); },
    } } });
    return s;
  };

  it('keeps writing after a failed write, says so until one succeeds, and never rejects a put or a touch', async () => {
    const s = storage();
    const cache = await import('./cache');
    const { storageProblem } = await import('./storage-health');
    await cache.put('fp1', 'allow', 0, 'label');
    s.failNext = true;
    await cache.put('fp2', 'allow', 0, 'label');
    expect(storageProblem()).toMatch(/tested verdicts could not be saved \(QUOTA_BYTES/);
    await cache.put('fp3', 'allow', 0, 'label');
    await cache.touch('fp1');
    expect(storageProblem()).toBeUndefined();
    const stored = s.data.verdictCache as Record<string, { count: number }>;
    expect(Object.keys(stored).sort()).toEqual(['fp1', 'fp2', 'fp3']);
    expect(stored.fp1!.count).toBe(2);
  });

  it('writes a burst of puts (a site\'s labels) once or twice, not once per label', async () => {
    const s = storage();
    const cache = await import('./cache');
    await Promise.all(Array.from({ length: 50 }, (_, i) => cache.put(`fp${i}`, 'allow', 0, 'label')));
    expect(s.sets).toBeLessThanOrEqual(2);
    expect(Object.keys(s.data.verdictCache as object)).toHaveLength(50);
  });
});

// A rejected first read is not kept for the worker's life (every later get and put would reject with it): the
// failure is reported, readers answer as for an empty cache, and the next call reads again.
describe('verdict cache reads', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });
  it('answers "no verdict" while storage cannot be read, reports it, and reads again on the next call', async () => {
    const s = { failing: true, gets: 0 };
    vi.stubGlobal('chrome', { storage: { local: {
      get: async (k: string) => { s.gets++; if (s.failing) throw new Error('IO error'); return { [k]: { 'GET a.com/x none': { verdict: 'allow', pWrite: 0, source: 'label', count: 1, firstSeen: 1, lastSeen: 1 } } }; },
      set: async () => {},
    } } });
    const cache = await import('./cache');
    const { storageProblem } = await import('./storage-health');
    expect(await cache.get('GET a.com/x none')).toBeUndefined();
    expect(await cache.size()).toBe(0);
    expect(storageProblem()).toMatch(/tested verdicts could not be read \(IO error\)/);
    await expect(cache.put('GET a.com/y none', 'allow', 0, 'label')).rejects.toThrow('IO error'); // never a fresh map over unread verdicts
    s.failing = false;
    expect((await cache.get('GET a.com/x none'))?.verdict).toBe('allow');
    expect(storageProblem()).toBeUndefined();
    expect(s.gets).toBe(4); // one read per call while failing, one that succeeded, none after
  });
});

// A failed clear() must not look done (ensureFormat would stamp the new format over old-format verdicts): it
// rejects, the stamp waits, and the old verdicts are read again.
describe('verdict cache clear', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });
  const storage = (init: Record<string, unknown>) => {
    const s = { data: { ...init }, failNext: false };
    vi.stubGlobal('chrome', { storage: { local: {
      get: async (k: string) => (k in s.data ? { [k]: structuredClone(s.data[k]) } : {}),
      set: async (o: Record<string, unknown>) => { if (s.failNext) { s.failNext = false; throw new Error('IO error'); } Object.assign(s.data, structuredClone(o)); },
    } } });
    return s;
  };
  const old = { 'POST a.com/x json:a': { verdict: 'allow', pWrite: 0, source: 'label', count: 1, firstSeen: 1, lastSeen: 1 } };

  it('rejects when storage does, keeps the stored verdicts readable, and reports it', async () => {
    const s = storage({ verdictCache: old });
    const cache = await import('./cache');
    const { storageProblem } = await import('./storage-health');
    expect((await cache.get('POST a.com/x json:a'))?.verdict).toBe('allow');
    s.failNext = true;
    await expect(cache.clear()).rejects.toThrow('IO error');
    expect(storageProblem()).toMatch(/tested verdicts could not be saved/);
    expect((await cache.get('POST a.com/x json:a'))?.verdict).toBe('allow');
    expect(s.data.verdictCache).toEqual(old);
    await cache.clear();
    expect(s.data.verdictCache).toEqual({});
    expect(storageProblem()).toBeUndefined();
  });
  it('does not stamp a new format while the old verdicts could not be dropped', async () => {
    const s = storage({ verdictCacheFormat: 1, verdictCache: old });
    const cache = await import('./cache');
    s.failNext = true;
    await expect(cache.ensureFormat()).rejects.toThrow('IO error');
    expect(s.data.verdictCacheFormat).toBe(1);
    expect(s.data.verdictCache).toEqual(old);
    expect(await cache.ensureFormat()).toBe(true);
    expect(s.data.verdictCacheFormat).toBe(cache.CACHE_FORMAT);
    expect(s.data.verdictCache).toEqual({});
  });
});

describe('prune', () => {
  const e = (verdict: 'allow' | 'block', source: CacheEntry['source'], lastSeen: number): CacheEntry => ({ verdict, pWrite: 0.5, source, count: 1, firstSeen: 0, lastSeen });

  it('leaves a cache within its share alone', () => {
    const m = new Map([['a', e('allow', 'jev', 1)]]);
    expect(prune(m, 10, 10_000)).toBe(0);
    expect(m.size).toBe(1);
  });

  it('drops the judge’s allows first, then its blocks, and a site’s tested verdicts last, oldest first in each', () => {
    const m = new Map<string, CacheEntry>([
      ['label-old', e('block', 'label', 1)],
      ['block-old', e('block', 'jev', 2)],
      ['allow-new', e('allow', 'jev', 9)],
      ['allow-old', e('allow', 'cloud', 3)],
      ['block-new', e('block', 'cloud', 8)],
    ]);
    expect(prune(m, 3, 1_000_000)).toBe(2);
    expect([...m.keys()].sort()).toEqual(['block-new', 'block-old', 'label-old']);
    expect(prune(m, 2, 1_000_000)).toBe(1);
    expect([...m.keys()].sort()).toEqual(['block-new', 'label-old']);
  });

  it('keeps the bytes within the share too', () => {
    const m = new Map<string, CacheEntry>();
    for (let i = 0; i < 100; i++) m.set(`POST host/${'p'.repeat(200)}/${i}`, e('allow', 'jev', i));
    prune(m, 1000, 5_000);
    let bytes = 0;
    for (const [k, v] of m) bytes += k.length + JSON.stringify(v).length + 8;
    expect(bytes).toBeLessThanOrEqual(5_000);
    expect(m.has(`POST host/${'p'.repeat(200)}/99`)).toBe(true); // the newest stay
  });
});
