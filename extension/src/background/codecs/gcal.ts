import type { Codec } from './types';

// ---- Google Calendar web client: POST /calendar/u/{id}/sync.sync, form field f.req = JSON.
// f.req = [[header, s, null, null, ops, null, null, subscriptions, null, ranges, …], 20000]
// ops (inner[4]) is null on plain polls, else a list of entries
//   [seq, settingsMutation | null, syncSpec | null, syncTokens | null, null, latency]
//   settingsMutation = [[["key", "value"]]]                     → write  (set:key)
//   syncSpec         = [[null×7, [n]], calendarId]              → read   (fetch spec)
//   syncSpec         = [[null, [eventId, …] | null, [eventId, …]?], calendarId] → write (event)
//   syncTokens       = ["opaque token", …]                       → read
function gcalSync(body: string): string {
  const inner = parseInner(body);
  if (!inner) return 'gcal:sync:w[unparseable]';
  const ops = inner[4];
  if (ops == null || (Array.isArray(ops) && ops.length === 0)) return 'gcal:sync:r';
  if (!Array.isArray(ops)) return 'gcal:sync:w[unknown]';
  const kinds = new Set<string>();
  for (const ent of ops) {
    const kind = entryKind(ent);
    if (kind) kinds.add(kind);
  }
  return kinds.size ? `gcal:sync:w[${[...kinds].sort().join(',')}]` : 'gcal:sync:r';
}

/** f.req's inner array, or undefined when the body is not the shape above. */
function parseInner(body: string): unknown[] | undefined {
  const raw = new URLSearchParams(body).get('f.req');
  if (!raw) return undefined;
  try {
    const j: unknown = JSON.parse(raw);
    const inner = Array.isArray(j) ? j[0] : undefined;
    return Array.isArray(inner) ? inner : undefined;
  } catch {
    return undefined;
  }
}

/** The write one ops entry makes (`set:key`, `set`, `event`, `unknown`), or undefined for a read. */
function entryKind(ent: unknown): string | undefined {
  if (!Array.isArray(ent)) return 'unknown';
  const settings = ent[1], spec = ent[2];
  if (Array.isArray(settings) && settings.length) {
    const key = (settings as unknown[][][])[0]?.[0]?.[0];
    return typeof key === 'string' && /^[\w.]{1,64}$/.test(key) ? `set:${key}` : 'set';
  }
  const kind = Array.isArray(spec) ? specKind(spec[0]) : undefined;
  if (kind) return kind;
  return isRead(ent) ? undefined : 'unknown';
}

/** A read sets nothing but a fetch spec or sync tokens (or neither). JSON+protobuf writes a sparse or high-numbered
 *  field as an object in a slot, or after the ones above, so a settings or spec slot that is not null or the forms
 *  above, or anything in slot 4 or past the latency (slot 5), is not a read. */
function isRead(ent: unknown[]): boolean {
  const settings = ent[1], spec = ent[2], tokens = ent[3];
  if (settings != null || ent[4] != null || (ent[5] != null && typeof ent[5] !== 'number') || ent.slice(6).some((x) => x != null)) return false;
  if (Array.isArray(spec)) return tokens == null && spec.length === 2 && typeof spec[1] === 'string';
  if (spec != null) return false;
  return tokens == null || (Array.isArray(tokens) && tokens.length > 0 && tokens.every((t) => typeof t === 'string'));
}

/** A sync spec: an event mutation (write), a fetch spec (read), or anything else (unknown, a write). */
function specKind(s: unknown): string | undefined {
  if (!Array.isArray(s)) return 'unknown';
  if (isEventMutation(s)) return 'event';
  return isFetchSpec(s) ? undefined : 'unknown';
}

function isEventMutation(s: unknown[]): boolean {
  // create: [null, null, [eventId, …]]; update/delete: [null, [eventId, …, flags]]
  return [1, 2].some((i) => Array.isArray(s[i]) && typeof (s[i] as unknown[])[0] === 'string');
}

function isFetchSpec(s: unknown[]): boolean {
  return s.length >= 8 && s.slice(0, 7).every((x) => x == null) && Array.isArray(s[7]);
}

export const gcal: Codec = {
  id: 'gcal-sync',
  writePrefixes: ['gcal:sync:w'],
  matches: (host, template) => host === 'calendar.google.com' && template.endsWith('/sync.sync'),
  decode: gcalSync,
};
