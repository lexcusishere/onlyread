import type { CacheEntry, Source } from '../shared/types';
import { storageFailed, storageOk } from './storage-health';

const KEY = 'verdictCache';
const FORMAT_KEY = 'verdictCacheFormat';
/** The fingerprint format the stored verdicts were made under. Bump it whenever fingerprints change what
 *  they tell apart: a verdict saved under an older format may cover operations the new one separates,
 *  and an unchanged key is no proof that it does not. */
export const CACHE_FORMAT = 6;
/** The cache's share of storage.local's 10 MB, with the decision and request logs (docs/ARCHITECTURE.md). */
export const MAX_ENTRIES = 5000;
export const MAX_BYTES = 2 * 1024 * 1024;
let map: Map<string, CacheEntry> | null = null;
let loading: Promise<Map<string, CacheEntry>> | null = null;
let dirty = false;
let writing: Promise<void> | null = null;

/** One shared read. A failed read is reported (storage-health.ts) and forgotten, so the next call reads
 *  again (a rejected promise kept for the worker's life would reject every later get and put). Rejects, so put() cannot write a fresh map over verdicts it could not read. */
function load(): Promise<Map<string, CacheEntry>> {
  if (map) return Promise.resolve(map);
  if (!loading) {
    loading = chrome.storage.local.get(KEY).then((r) => {
      const stored = r[KEY] as Record<string, CacheEntry> | undefined;
      map = new Map(Object.entries(stored ?? {}));
      storageOk('cache', 'read');
      return map;
    }, (err: unknown) => {
      loading = null;
      storageFailed('cache', err, 'read');
      throw err;
    });
  }
  return loading;
}

/** The map, or null while storage cannot be read: readers then answer as for an empty cache. */
const loaded = (): Promise<Map<string, CacheEntry> | null> => load().catch(() => null);

/** Writes the map, then again if it changed meanwhile: a burst of puts (a site's labels being imported) costs
 *  one or two writes, not one per put. Never rejects: a failed write is reported (storage-health.ts) and tried
 *  again with the next change, so one storage error cannot fail every later request. */
function flush(): Promise<void> {
  dirty = true;
  if (!writing) {
    writing = (async () => {
      while (dirty) {
        dirty = false;
        try {
          if (map) await chrome.storage.local.set({ [KEY]: Object.fromEntries(map) });
          storageOk('cache');
        } catch (err) {
          dirty = true; // the next flush writes the whole map again
          storageFailed('cache', err);
          return;
        }
      }
    })().finally(() => { writing = null; });
  }
  return writing;
}

const entryBytes = (fingerprint: string, e: CacheEntry): number => fingerprint.length + JSON.stringify(e).length + 8;
/** Which verdicts go first when the cache is full: the judge's allows, then the judge's blocks (a write the judge
 *  refused is judged again if it comes back), and a site's tested verdicts last (restored on the next start,
 *  index.ts reimportSiteVerdicts). Least recently seen first within each. */
const keepRank = (e: CacheEntry): number => (e.source === 'label' ? 2 : e.verdict === 'allow' ? 0 : 1);

/** Brings the cache within MAX_ENTRIES and MAX_BYTES; the number of verdicts dropped. */
export function prune(m: Map<string, CacheEntry>, maxEntries = MAX_ENTRIES, maxBytes = MAX_BYTES): number {
  let bytes = 0;
  for (const [k, e] of m) bytes += entryBytes(k, e);
  if (m.size <= maxEntries && bytes <= maxBytes) return 0;
  const order = [...m].sort(([, a], [, b]) => keepRank(a) - keepRank(b) || a.lastSeen - b.lastSeen);
  let dropped = 0;
  for (const [k, e] of order) {
    if (m.size <= maxEntries && bytes <= maxBytes) break;
    m.delete(k);
    bytes -= entryBytes(k, e);
    dropped++;
  }
  return dropped;
}

export async function get(fingerprint: string): Promise<CacheEntry | undefined> {
  return (await loaded())?.get(fingerprint);
}

/** Blocks are sticky. An allow never overwrites a block; a block always overwrites. */
export async function put(fingerprint: string, verdict: 'allow' | 'block', pWrite: number, source: Source): Promise<void> {
  const m = await load();
  const now = Date.now();
  const prev = m.get(fingerprint);
  if (prev && prev.verdict === 'block' && verdict === 'allow' && source !== 'label') {
    prev.count++; prev.lastSeen = now;
  } else {
    m.set(fingerprint, { verdict, pWrite, source, count: (prev?.count ?? 0) + 1, firstSeen: prev?.firstSeen ?? now, lastSeen: now });
  }
  if (!prev) prune(m); // only a new verdict can take the cache past its share
  await flush();
}

export async function touch(fingerprint: string): Promise<void> {
  const e = (await loaded())?.get(fingerprint);
  if (e) { e.count++; e.lastSeen = Date.now(); await flush(); }
}

export async function list(): Promise<Record<string, CacheEntry>> {
  return Object.fromEntries((await loaded()) ?? []);
}

export async function size(): Promise<number> {
  return (await loaded())?.size ?? 0;
}

/** Drops every stored verdict made under another fingerprint format. True when it dropped them: the
 *  caller re-imports the enabled sites' verdicts, which ship in the current format. */
export async function ensureFormat(): Promise<boolean> {
  const r = await chrome.storage.local.get(FORMAT_KEY);
  if (r[FORMAT_KEY] === CACHE_FORMAT) return false;
  await clear();
  await chrome.storage.local.set({ [FORMAT_KEY]: CACHE_FORMAT });
  return true;
}

/** Drops every verdict. Rejects when storage does (not through `flush`, which never rejects: a failed clear would
 *  look done, `ensureFormat` would stamp the new format over old-format verdicts, and `cache:clear` would report
 *  success). Storage keeps the old verdicts then, and they are read again. */
export async function clear(): Promise<void> {
  if (writing) await writing; // a flush under way must not write the old map after the clear
  map = new Map(); dirty = false; // a flush from here on writes the empty map
  try {
    await chrome.storage.local.set({ [KEY]: {} });
    storageOk('cache');
  } catch (err) {
    map = null; loading = null; // storage still holds the old verdicts: the next read has them
    storageFailed('cache', err);
    throw err;
  }
}
