// What the person (or the agent) typed into password, one-time-code and payment-card fields on guarded sites,
// held only so it can be removed from request bodies before a judge or the audit log sees them, whatever the
// body's format (fingerprint.ts scrubKnown). In memory only: never stored, logged or sent anywhere; forgotten
// ten minutes after the last keystroke, when the tab closes, and when the service worker stops.

import { TYPED_SECRET_TTL_MS as TTL_MS } from '../shared/ui-names';

/** At most this many fields are held, and this many per tab (filling many fields in one tab must not push out
 *  a password typed in another); the oldest goes first. */
const MAX_FIELDS = 32;
const MAX_PER_TAB = 6;
/** Longer values are not secrets a person types. */
const MAX_LENGTH = 256;

const fields = new Map<string, { tabId: number; value: string; at: number }>();

/** The latest value of one field (`field` is the content script's id for it); empty forgets it. */
export function remember(tabId: number, field: string, value: string, now = Date.now()): void {
  const key = `${tabId}:${field}`;
  fields.delete(key); // re-inserted last, so the oldest entry is the map's first
  if (!value || value.length > MAX_LENGTH) return;
  fields.set(key, { tabId, value, at: now });
  const ofTab = [...fields].filter(([, v]) => v.tabId === tabId);
  for (const [k] of ofTab.slice(0, Math.max(0, ofTab.length - MAX_PER_TAB))) fields.delete(k);
  while (fields.size > MAX_FIELDS) fields.delete(fields.keys().next().value!);
}

export function forget(tabId: number): void {
  for (const [k, v] of fields) if (v.tabId === tabId) fields.delete(k);
}

/** Every value still held, from every tab: a password typed in one tab can leave from another, or from a
 *  service worker that has no tab. */
export function known(now = Date.now()): string[] {
  for (const [k, v] of fields) if (now - v.at > TTL_MS) fields.delete(k);
  return [...new Set([...fields.values()].map((v) => v.value))];
}
