// SharedWorkers on guarded sites. A SharedWorker belongs to no tab: the debugger's per-tab auto-attach never holds it,
// and Chrome's network rules do not refuse the sockets it opens (a page's and a dedicated worker's are refused; a
// SharedWorker's opens, e2e/shared-worker.spec.ts). Telegram Web runs its whole connection in one, so on a guarded site
// writes would leave unseen. Two layers keep them out:
// - every guarded page loses `SharedWorker` before its first line runs (the debugger registers that for each document
//   of a held tab; a page of a site not guarded keeps it),
//   so a site falls back to dedicated workers, which the tab's session holds and the rules cover;
// - while enforcing, a SharedWorker of a guarded site that runs anyway (started before protection, or before the page
//   could be prepared) is closed, and that site's held tabs are reloaded so their new documents start without it.
import { guardsHost } from './decision';
import type { EffectivePolicy } from '../shared/types';

type Session = chrome.debugger.DebuggerSession;
type Send = (t: Session, m: string, p?: object) => Promise<unknown>;

type Guarded = Pick<EffectivePolicy, 'targetDomains' | 'guardAll' | 'excludeDomains' | 'exemptDomains'>;

/** Runs first in every document of a held tab: a page of a guarded site (decision.ts guardsHost, with the sites in
 *  force when it was registered) cannot make a SharedWorker; a page of any other site keeps it. */
export function hideSharedWorker(eff: Guarded): string {
  const lists = JSON.stringify({ t: eff.targetDomains ?? [], all: eff.guardAll === true, a: eff.excludeDomains ?? [], x: eff.exemptDomains ?? [] });
  return `(() => { const l = ${lists}; const h = location.hostname.toLowerCase();
  const on = (ds) => ds.some((d) => { d = d.toLowerCase(); return h === d || h.endsWith('.' + d); });
  if (!h || !(on(l.t) || (l.all && !on(l.a) && !on(l.x)))) return;
  try { Object.defineProperty(globalThis, 'SharedWorker', { value: undefined, configurable: false, writable: false }); } catch {} })();`;
}

/** Held tabs with the hide registered, and its id there (to put a new one in when the sites change). */
const prepared = new Map<number, string>();

const hostOf = (url: string): string => {
  try { return new URL(url.replace(/^blob:/, '')).hostname; } catch { return ''; }
};

/** Registers the hide for every document the held tab loads, and runs it in the one there now. */
export async function onTabHeld(tabId: number, eff: Guarded, send: Send, log: (tabId: number, msg: string) => void): Promise<void> {
  if (prepared.has(tabId)) return;
  try {
    await send({ tabId }, 'Page.enable');
    const r = (await send({ tabId }, 'Page.addScriptToEvaluateOnNewDocument', { source: hideSharedWorker(eff), runImmediately: true })) as { identifier?: string } | undefined;
    prepared.set(tabId, r?.identifier ?? '');
  } catch (err) {
    log(tabId, `shared-worker-hide-failed:${err instanceof Error ? err.message : String(err)}`.slice(0, 120));
  }
}

/** Puts the hide in afresh for the held tab's next documents, whatever was registered before: the old one is taken out
 *  if it is still there (a gone one, "Script not found", is no reason to stop), and a tab the new one can't go into is
 *  no longer counted as prepared, so the next hold tries again. Before this, a failed removal left the tab with no hide
 *  while it counted as prepared: its pages kept SharedWorker, and the sweep closed it and reloaded the tab every two
 *  seconds, for good (X, with a tab open from before the demo). */
async function rearm(tabId: number, eff: Guarded, send: Send, log: (tabId: number, msg: string) => void): Promise<void> {
  const old = prepared.get(tabId);
  if (old) await send({ tabId }, 'Page.removeScriptToEvaluateOnNewDocument', { identifier: old }).catch(() => {});
  try {
    const r = (await send({ tabId }, 'Page.addScriptToEvaluateOnNewDocument', { source: hideSharedWorker(eff) })) as { identifier?: string } | undefined;
    prepared.set(tabId, r?.identifier ?? '');
  } catch (err) {
    prepared.delete(tabId);
    log(tabId, `shared-worker-hide-failed:${err instanceof Error ? err.message : String(err)}`.slice(0, 120));
  }
}

/** The guarded sites changed: every held tab's next documents are hidden from by the new list (a site switched off
 *  gets SharedWorker back on its next load; the documents there now stay as they are). */
export async function reconfigure(eff: Guarded, send: Send, log: (tabId: number, msg: string) => void): Promise<void> {
  for (const tabId of [...prepared.keys()]) await rearm(tabId, eff, send, log);
}

export function onTabReleased(tabId: number): void {
  prepared.delete(tabId);
  reloads.delete(tabId);
}

/** The workers that may be strays: running on a guarded host and not held by any tab's session (a tab's own workers
 *  are). Chrome names every kind of worker `worker` here, so the sweep asks each what it is and closes only
 *  SharedWorkers: a service worker is intercepted by a held tab's session or covered by the worker-origin rule, and a
 *  dedicated worker belongs to a page (or a worker) whose tab the rules cover, like the crypto workers Telegram's
 *  protocol worker starts, which no session holds. */
export function candidateWorkers(targets: { id: string; type: string; url: string; attached: boolean }[], held: Set<string>, eff: EffectivePolicy): { id: string; host: string }[] {
  // Attached ones are left alone: a tab's own worker is attached by its session from its first line (a new one shows
  // up just before the session holds it), and a worker someone else is debugging is not ours to close.
  return targets
    .filter((t) => (t.type === 'worker' || t.type === 'shared_worker') && !held.has(t.id) && !t.attached)
    .map((t) => ({ id: t.id, host: hostOf(t.url) }))
    .filter((t) => t.host && guardsHost(eff, t.host));
}

/** Closes the worker when it is a SharedWorker (its own dedicated workers end with it); true when it closed. */
export const CLOSE_IF_SHARED_WORKER = `(() => { if (typeof SharedWorkerGlobalScope === 'undefined' || !(self instanceof SharedWorkerGlobalScope)) return false; self.close(); return true; })()`;

/** A debugger call that gives up after `ms`: a worker held paused at its start would never answer. */
function within<T>(p: Promise<T>, ms = 1500): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timed out')), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e: unknown) => { clearTimeout(t); reject(e); });
  });
}

/** Closes one worker when it is a SharedWorker; true when it closed. */
async function closeWorker(id: string): Promise<boolean> {
  const target = { targetId: id };
  try {
    await within(chrome.debugger.attach(target, '1.3'));
    const r = (await within(chrome.debugger.sendCommand(target, 'Runtime.evaluate', { expression: CLOSE_IF_SHARED_WORKER, returnByValue: true }))) as { result?: { value?: unknown } } | undefined;
    return r?.result?.value === true;
  } finally {
    await chrome.debugger.detach(target).catch(() => {});
  }
}

const sameSite = (a: string, b: string) => a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);

/** How many times a tab may be reloaded for a SharedWorker within RELOAD_WINDOW_MS before the sweep stops reloading it
 *  (it still closes the worker each time). */
export const MAX_RELOADS = 3;
const RELOAD_WINDOW_MS = 30_000;
const reloads = new Map<number, number[]>();

/** Reloads the held tabs on these hosts, so their new documents start without SharedWorker: the hide is put in afresh
 *  first, so the reload ends it rather than starting it again. A tab reloaded MAX_RELOADS times within RELOAD_WINDOW_MS
 *  is reloaded no more (a loop is worse than a page that keeps losing its worker), and the log says so. */
async function reloadTabsOn(hosts: string[], heldTabs: number[], eff: Guarded, send: Send, log: (tabId: number, msg: string) => void, now = Date.now()): Promise<void> {
  for (const tabId of heldTabs) {
    const h = hostOf((await chrome.tabs.get(tabId).catch(() => undefined))?.url ?? '');
    if (!h || !hosts.some((x) => sameSite(h, x))) continue;
    const recent = (reloads.get(tabId) ?? []).filter((t) => now - t < RELOAD_WINDOW_MS);
    if (recent.length >= MAX_RELOADS) {
      if (recent.length === MAX_RELOADS) log(tabId, `shared-worker-reload-loop:${h}: not reloaded again`);
      reloads.set(tabId, [...recent, now]);
      continue;
    }
    reloads.set(tabId, [...recent, now]);
    await rearm(tabId, eff, send, log);
    void chrome.tabs.reload(tabId).catch(() => {});
  }
}

let sweeping = false;
/** Closes every stray worker of a guarded site and reloads the held tabs on its host. Returns the hosts it acted on. */
export async function sweep(eff: EffectivePolicy, held: Set<string>, heldTabs: number[], log: (tabId: number, msg: string) => void, send: Send): Promise<string[]> {
  if (sweeping) return [];
  sweeping = true;
  try {
    const hosts = new Set<string>();
    for (const w of candidateWorkers(await chrome.debugger.getTargets(), held, eff)) {
      try {
        if (await closeWorker(w.id)) { hosts.add(w.host); log(-1, `shared-worker-closed:${w.host}`); }
      } catch (err) {
        log(-1, `shared-worker-close-failed:${w.host}:${err instanceof Error ? err.message : String(err)}`.slice(0, 140));
      }
    }
    if (hosts.size) await reloadTabsOn([...hosts], heldTabs, eff, send, log);
    return [...hosts];
  } finally {
    sweeping = false;
  }
}
