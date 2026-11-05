import type { Codec } from './types';

// ---- Gmail web client: POST /sync/u/{id}/i/s, JSON array body.
//   poll          [null, null, [cursor…], [state…], n]
//   session init  [[1, null, null, 0], null, [cursor…], [state…], n]
//   thread op     [null, [[[op, [threadId, threadState]]]], …]          → write (star, read/unread, archive, trash, label, draft save)
//   send          [[null, null, 2], [[[6, [threadId, threadState]]]], …] → write
// Element 1 is null on every read and a list of operations on every write. The leading number of
// an operation is a per-session sequence counter, so the shape names only the Gmail system labels
// present in the write (^i inbox, ^u unread, ^t starred, ^k trash, ^s spam, ^a archived, ^r draft,
// ^f sent): the audit reads "gmail:s:w[^k]" for a trash instead of json[]:naaad.
const GMAIL_LABELS = new Set(['^i', '^u', '^us', '^t', '^k', '^s', '^a', '^r', '^f']); // ^us = unseen-in-list flag, cleared when the inbox renders
function gmailSync(body: string): string {
  let j: unknown;
  try { j = JSON.parse(body); } catch { return 'gmail:s:w[unparseable]'; }
  if (!Array.isArray(j)) return 'gmail:s:w[unparseable]';
  const ops = j[1];
  if (ops == null || (Array.isArray(ops) && ops.length === 0)) return 'gmail:s:r';
  if (!Array.isArray(ops)) return 'gmail:s:w[unknown]';
  const labels = new Set<string>();
  const unknown = ops.map((group) => collectGroup(group, labels)).includes(false);
  const parts = [...labels].sort();
  if (unknown) parts.push('unknown');
  return `gmail:s:w[${parts.length ? parts.join(',') : '-'}]`;
}

/** Adds the system labels one operation group names to `labels`; false when any part of it is not an operation. */
function collectGroup(group: unknown, labels: Set<string>): boolean {
  if (!Array.isArray(group)) return false;
  let known = true;
  for (const op of group) {
    if (!Array.isArray(op) || typeof op[0] !== 'number') { known = false; continue; }
    walkStrings(op, (str) => { if (GMAIL_LABELS.has(str)) labels.add(str); });
  }
  return known;
}

function walkStrings(v: unknown, fn: (s: string) => void, depth = 0): void {
  if (depth > 12) return;
  if (typeof v === 'string') fn(v);
  else if (Array.isArray(v)) for (const x of v) walkStrings(x, fn, depth + 1);
}

export const gmail: Codec = {
  id: 'gmail-sync',
  writePrefixes: ['gmail:s:w'],
  matches: (host, template) => host === 'mail.google.com' && /\/sync\/u\/\{id\}\/i\/s$/.test(template),
  decode: gmailSync,
};
