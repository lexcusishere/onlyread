// The settings PIN and the wrong-PIN count as the lock reads them. Storage alone cannot be trusted
// for them: a page driven around the background can write either and send a settings message at once, and the message
// can be handled before the write's change event has even reached the worker, let alone been checked and put back. So
// the lock keeps its own copy: read from storage at startup, set by the background's own writes, and set from an outside
// write only once its check lets it stand (messages.ts putBackOutsideWrite). Every read takes the stricter of the copy
// and storage, so a write the copy has not seen can raise protection at once and never lower it: a PIN is set when
// either holds one, and the wrong-PIN count and its wait are the larger of the two. Memory only: a worker woken by the
// outside write itself reads the written value at startup, and the wait for pending checks (owned-storage.ts
// outsideWritesSettled) is what covers that case.
import type { StoredPin } from './protection';

export interface PinFailures { count: number; retryAt: number }

const asPin = (v: unknown): StoredPin | undefined => (v && typeof v === 'object' ? (v as StoredPin) : undefined);
const asFailures = (v: unknown): PinFailures => {
  const o = (v && typeof v === 'object' ? v : {}) as Partial<Record<keyof PinFailures, unknown>>;
  return { count: Number(o.count) || 0, retryAt: Number(o.retryAt) || 0 };
};

let pin: StoredPin | undefined;
let failures: PinFailures = { count: 0, retryAt: 0 };
let loaded: Promise<void> | null = null;

/** Reads both values from storage once (startup); later calls reuse that read. A failed read is tried again next time. */
export function loadLockState(): Promise<void> {
  loaded ??= chrome.storage.local.get(['settingsPin', 'pinFailures']).then((r) => {
    pin = asPin(r.settingsPin);
    failures = asFailures(r.pinFailures);
  }, (err: unknown) => { loaded = null; throw err; });
  return loaded;
}

async function stored(): Promise<{ pin?: StoredPin; failures?: PinFailures }> {
  try {
    const r = await chrome.storage.local.get(['settingsPin', 'pinFailures']);
    return { pin: asPin(r.settingsPin), failures: asFailures(r.pinFailures) };
  } catch { return {}; } // storage failing: the copy alone
}

/** The PIN record the lock checks against: the copy's, else one storage holds that the copy has not seen. */
export async function lockPin(): Promise<StoredPin | undefined> {
  await loadLockState().catch(() => undefined);
  return pin ?? (await stored()).pin;
}

/** The longest wait the background ever sets after wrong PINs (messages.ts checkPin). */
export const MAX_PIN_WAIT_MS = 60 * 60_000;

/** The wrong-PIN count and its wait: the larger of the copy and storage, each field. The wait is capped at the longest
 *  the background sets: raising it is not a lowering, so an outside write of `retryAt: 1e15` is let stand, and without
 *  the cap it would keep the person from ever entering their PIN. */
export async function lockFailures(now = Date.now()): Promise<PinFailures> {
  await loadLockState().catch(() => undefined);
  const s = (await stored()).failures ?? failures;
  return { count: Math.max(failures.count, s.count), retryAt: Math.min(Math.max(failures.retryAt, s.retryAt), now + MAX_PIN_WAIT_MS) };
}

/** The background wrote one of the two (an own write), or an outside write to it was let stand or put back. */
export function noteLockValue(key: 'settingsPin' | 'pinFailures', value: unknown): void {
  if (key === 'settingsPin') pin = asPin(value); else failures = asFailures(value);
}
