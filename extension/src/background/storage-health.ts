// Problems the background cannot fix on its own, kept here so `status:get` can show them (popup footer, settings
// page): a storage write that failed (the log or the verdict cache may be behind), a startup step that threw, a
// stored policy that did not validate. No imports, so audit.ts, cache.ts, observer.ts, policy.ts and index.ts
// can all report without a cycle through state.ts.
type Store = 'audit' | 'cache' | 'observations';
const LABEL: Record<Store, string> = { audit: 'the activity log', cache: 'the tested verdicts', observations: 'the request log' };

type Op = 'write' | 'read';
/** One report per store and operation: a read that succeeds says nothing about a write that failed before it
 *  (so the first read at startup does not clear the write report a restart has just restored). */
const failures = new Map<`${Store}:${Op}`, string>();
const SESSION_KEY = 'storageFailures';

/** The reports outlive the worker (storage.session lives for the browser session): a failed write followed by a
 *  worker restart still shows in the popup, although the unwritten entries are gone with the worker. */
function persist(): void {
  try { void chrome.storage.session.set({ [SESSION_KEY]: Object.fromEntries(failures) }).catch(() => {}); } catch { /* no session storage (tests) */ }
}

/** At startup: the reports the previous worker left. */
export async function restoreHealth(): Promise<void> {
  try {
    const r = await chrome.storage.session.get(SESSION_KEY);
    for (const [k, v] of Object.entries((r[SESSION_KEY] ?? {}) as Record<string, string>)) {
      const [store, op] = k.split(':');
      if (store && store in LABEL && (op === 'write' || op === 'read') && typeof v === 'string') failures.set(`${store as Store}:${op}`, v);
    }
  } catch { /* nothing kept */ }
}

export const health = {
  /** Why startup did not finish (verdicts not restored, rules not installed, …); undefined when it did. */
  startup: undefined as string | undefined,
  /** Why the sites' tested verdicts were not restored at startup (the guard is up; their reads are judged
   *  instead); undefined when they were. */
  verdicts: undefined as string | undefined,
  /** What was wrong with the stored settings; undefined when nothing was. */
  policy: undefined as string | undefined,
  /** The one field reset to its default (the rest of the settings are in use); undefined when not repaired. */
  policyRepaired: undefined as string | undefined,
};

const text = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 120);

/** A write to this store failed (the in-memory copy is ahead of storage until a later write succeeds), or a
 *  read did (`op: 'read'`: the store is used as empty until a later read succeeds). */
export function storageFailed(store: Store, err: unknown, op: Op = 'write'): void {
  failures.set(`${store}:${op}`, `${LABEL[store]} could not be ${op === 'read' ? 'read' : 'saved'} (${text(err)})`);
  console.warn(`[onlyread] storage ${op} failed (${store}):`, err);
  persist();
}

/** A read of this store succeeded (clears its read report), or a write did (the store is reachable and holds what
 *  was written: clears both). */
export function storageOk(store: Store, op: Op = 'write'): void {
  const cleared = failures.delete(`${store}:read`) || (op === 'write' && failures.delete(`${store}:write`));
  if (op === 'write') failures.delete(`${store}:write`);
  if (cleared) persist();
}

/** One sentence naming every store whose last read or write failed, or undefined. */
export function storageProblem(): string | undefined {
  return failures.size ? [...failures.values()].join('; ') : undefined;
}
