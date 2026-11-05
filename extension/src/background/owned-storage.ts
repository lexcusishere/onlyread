// The background's own writes to chrome.storage.local, told apart from writes made around it (another extension
// context, or a debugger driving OnlyRead's own pages) by a random nonce written in the same `set` call, never by the
// value's content: plain JSON differs after Chrome's round trip (keys come back sorted), and Chrome fires no change for
// a write equal to what is stored, so a content key for a no-op write would stay pending and an outside write of that same
// value could later pass as the background's own. The nonce always changes, so its event always comes; a stored
// nonce is of no use to an outside writer, since only a pending one counts, and each is consumed by its own event.
// Every own write of a key that holds up protection (the policy, the settings PIN, the judge's keys, the wrong-PIN
// count, the agent-browser mark, the Pro tokens) is stamped here, and index.ts checks an unstamped change against the
// lock (protection.ts storageLowering), so a driven settings page cannot remove the PIN or replace the judge's key
// around the background.

/** The nonce's key. Stored copies carry this name, so it stays although it covers more than the policy. */
const NONCE_KEY = 'policyNonce';
const pending = new Set<string>();

/** Writes `items` as the background's own: one `set` call, with a fresh nonce. */
export async function ownSet(items: Record<string, unknown>): Promise<void> {
  const nonce = crypto.randomUUID();
  pending.add(nonce);
  try {
    await chrome.storage.local.set({ ...items, [NONCE_KEY]: nonce });
  } catch (err) {
    pending.delete(nonce);
    throw err;
  }
}

/** Removals the background asked for, by key, until when they count (a removal fires its change at once). A `remove`
 *  cannot carry the nonce, so each key it removes is marked here instead; a key that is absent is not marked (removing
 *  it fires no change to consume the mark, and a stale mark could later pass an outside removal as the background's). */
const pendingRemovals = new Map<string, number>();
const REMOVAL_MS = 5000;

/** Removes `keys` as the background's own. */
export async function ownRemove(...keys: string[]): Promise<void> {
  const got = await chrome.storage.local.get(keys);
  const present = keys.filter((k) => got[k] !== undefined);
  const until = Date.now() + REMOVAL_MS;
  for (const k of present) pendingRemovals.set(k, until);
  try {
    await chrome.storage.local.remove(keys);
  } catch (err) {
    for (const k of present) pendingRemovals.delete(k);
    throw err;
  }
}

/** Whether a change with no nonce is a removal the background asked for: every key in it removed and marked. */
function ownRemoval(changes: Record<string, chrome.storage.StorageChange>): boolean {
  const now = Date.now();
  const keys = Object.keys(changes);
  if (!keys.length || !keys.every((k) => changes[k]!.newValue === undefined && (pendingRemovals.get(k) ?? 0) > now)) return false;
  for (const k of keys) pendingRemovals.delete(k);
  return true;
}

export type StorageChanges = Record<string, chrome.storage.StorageChange>;
type OwnedChangeHandler = (changes: StorageChanges, own: boolean) => void;

const handlers: OwnedChangeHandler[] = [];
let listening = false;

/** `h` for every change to chrome.storage.local, with whether the background wrote it. One listener serves every
 *  handler, so the nonce is consumed once per event and each handler hears the same answer. Register at the worker's
 *  top level (MV3): a listener added later misses the events that woke the worker. */
export function onOwnedChange(h: OwnedChangeHandler): void {
  handlers.push(h);
  if (listening) return;
  listening = true;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    const nonce = changes[NONCE_KEY]?.newValue;
    const own = typeof nonce === 'string' ? pending.delete(nonce) : ownRemoval(changes);
    for (const handler of handlers) handler(changes, own);
  });
}

/** Checks of outside writes still running (index.ts): every settings message, and the Pro account's list, waits for them
 *  before it reads the lock (messages.ts handle, cloud-sync.ts offer). The lock reads the PIN and the wrong-PIN count from
 *  storage, so otherwise "remove the PIN around the background, then at once switch protection off" could be handled
 *  while the removal was still waiting to be put back, and pass. A check is opened as the change event arrives,
 *  before anything else runs, and closed once the change stands or is put back. */
const openChecks = new Set<Promise<void>>();
export function beginOutsideCheck(): () => void {
  let done = (): void => {};
  const p = new Promise<void>((resolve) => { done = resolve; });
  openChecks.add(p);
  return () => { openChecks.delete(p); done(); };
}
/** Resolves once no check of an outside write is open. */
export async function outsideWritesSettled(): Promise<void> {
  while (openChecks.size) await Promise.all([...openChecks]);
}
