import type { UiAction } from '../shared/types';

const MAX_PER_TAB = 8;
const perTab = new Map<number, UiAction[]>();

/** Stored, audited and shown to the judge: a sensitive field's name is dropped here too, whatever the
 *  page sent, and names are bounded. */
export function sanitize(action: UiAction): UiAction {
  const out: UiAction = { ...action };
  if (out.sensitive) { delete out.name; delete out.fields; }
  if (typeof out.name === 'string') out.name = out.name.slice(0, 80);
  return out;
}

export function push(tabId: number, action: UiAction): void {
  const list = perTab.get(tabId) ?? [];
  list.push(sanitize(action));
  if (list.length > MAX_PER_TAB) list.splice(0, list.length - MAX_PER_TAB);
  perTab.set(tabId, list);
}

/** Actions in the last `withinMs`, newest first. */
export function recent(tabId: number, withinMs = 1500, now = Date.now()): UiAction[] {
  return (perTab.get(tabId) ?? []).filter((a) => now - a.ts <= withinMs).reverse();
}

export function forget(tabId: number): void {
  perTab.delete(tabId);
}
