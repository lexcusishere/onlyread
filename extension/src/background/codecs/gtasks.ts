import type { Codec } from './types';

// ---- Google Tasks (inside Calendar): POST tasks-pa …/TasksApiService/Sync, JSON array body.
// body = [request, null, [null, [userId]], null, [clientId, meta]]
// request = [filters, []]                              → read (initial sync)
// request = [null, [[ts, ns]]]                         → read (poll)
// request = [null, [[ts, ns], null, [[[task, …]]]]]    → write (task mutations at request[1][2])
// Only those two request shapes are reads, exactly as recorded (Calendar's test sessions); any other request, a field in
// a place they leave empty, an object (JSON+protobuf's sparse fields) where they have an array, is w[unknown]. The rest
// of the body (user and client info, anything after them) is deliberately not checked: only the request is read.

type Json = unknown;
const isArr = Array.isArray;

/** The array without its trailing nulls (JSON+protobuf may write or drop them). */
function trimmed(a: Json[]): Json[] {
  let n = a.length;
  while (n > 0 && a[n - 1] === null) n--;
  return a.slice(0, n);
}

/** Nothing but nulls, numbers and arrays of them: a filter's option flags. No string (a task id or title), no object.
 *  At most FLAG_DEPTH arrays deep (the recorded filters are 4): deeper is no filter, and is not walked. */
const FLAG_DEPTH = 8;
function flagsOnly(v: Json, depth = 1): boolean {
  if (v === null || typeof v === 'number') return true;
  return isArr(v) && depth <= FLAG_DEPTH && v.every((x) => flagsOnly(x, depth + 1));
}

/** A sync time: [seconds, nanoseconds], whole and not negative. */
const isTime = (v: Json): boolean => isArr(v) && v.length === 2 && v.every((n) => Number.isInteger(n) && (n as number) >= 0);

/** request = [filters, []]: the initial sync. */
const initialSync = (r: Json[]): boolean => r.length === 2 && isArr(r[0]) && flagsOnly(r[0]) && isArr(r[1]) && r[1].length === 0;
/** request = [null, [[ts, ns]]]: a poll for changes since then. */
const poll = (r: Json[]): boolean => r.length === 2 && r[0] === null && isArr(r[1]) && trimmed(r[1]).length === 1 && isTime(r[1][0]);

function gtasksSync(body: string): string {
  let j: unknown;
  try { j = JSON.parse(body); } catch { return 'gtasks:sync:w[unparseable]'; }
  if (!isArr(j) || !isArr(j[0])) return 'gtasks:sync:w[unknown]';
  const req = trimmed(j[0]);
  const x = req[1];
  if (isArr(x)) {
    const muts = x[2];
    if (isArr(muts) && muts.length) {
      const n = (muts as unknown[]).flat(2).filter(Array.isArray).length;
      return `gtasks:sync:w[${n || muts.length}]`;
    }
  }
  return initialSync(req) || poll(req) ? 'gtasks:sync:r' : 'gtasks:sync:w[unknown]';
}

export const gtasks: Codec = {
  id: 'gtasks-sync',
  writePrefixes: ['gtasks:sync:w'],
  matches: (host, template) => host === 'tasks-pa.clients6.google.com' && template.endsWith('TasksApiService/Sync'),
  decode: gtasksSync,
};
