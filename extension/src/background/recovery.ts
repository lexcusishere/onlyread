// Product recovery: what the extension does to a guarded tab *after* it refuses a request,
// and when the mode changes. Sync-engine apps (Gmail, Calendar, Linear) run a sequential
// mutation queue; a refused write sits at the head and blocks everything behind it, so the
// tab looks wedged ("Oops… Retrying", a stuck spinner, stale optimistic state). The pure
// helpers decide *whether* and *how* to recover; the scheduler debounces and runs it with
// injected chrome calls so it can be unit-tested without a browser.
import type { Policy } from '../shared/types';
import { isTargetHost } from './decision';

export type Recovery = 'none' | 'reload' | 'discard';

/**
 * Recovery to run after a request was actually failed in enforce mode.
 * - notice (default): leave the tab alone; only the in-page notice fires.
 * - reload: reload the tab, abandoning the in-memory pipeline (fixes Calendar's wedge).
 * - discard: clear the origin's IndexedDB / Cache / service workers, then reload, so a sync
 *   engine that persists its queue (Gmail, Linear) does not just retry the refused write.
 * Only an enforced fail triggers recovery; monitor mode and allows never do.
 */
export function recoveryFor(policy: Policy, enforced: boolean): Recovery {
  if (!enforced) return 'none';
  return policy.onRefusedMutation === 'reload' || policy.onRefusedMutation === 'discard'
    ? policy.onRefusedMutation
    : 'none';
}

/**
 * Tabs to reload when the mode changes (monitor↔enforce), which can leave a guarded tab's mutation
 * pipeline half-configured. Only tabs on a guarded target host are reloaded — never the user's other
 * open tabs, even though attachScope='all-tabs' attaches the debugger to all of them. Any non-mode
 * policy change (enabling a site, editing a key, toggling attach timing) reloads nothing.
 */
export function tabsToReloadOnModeChange(
  prev: Policy,
  next: Policy,
  tabs: { id: number; url?: string }[],
  targetDomains: string[],
): number[] {
  if (prev.mode === next.mode) return [];
  return tabs
    .filter((t) => {
      if (!t.url) return false;
      try { return isTargetHost(new URL(t.url).hostname, targetDomains); } catch { return false; }
    })
    .map((t) => t.id);
}

interface RecoveryDeps {
  reload(tabId: number): Promise<void>;
  /** Clear the tab origin's stored data (IndexedDB, Cache Storage, service workers). */
  clearOrigin(tabId: number): Promise<void>;
  log?(tabId: number, msg: string): void;
  /** Debounce window; a burst of refusals on one tab collapses into a single recovery. */
  delayMs?: number;
  /** Minimum gap between two recoveries of the same tab. */
  cooldownMs?: number;
  /** Rolling window and cap: at most `maxPerWindow` recoveries per tab per `windowMs`. */
  windowMs?: number;
  maxPerWindow?: number;
  now?(): number;
}

/**
 * Debounced, rate-limited, per-tab recovery runner. `discard` supersedes `reload` within one burst.
 *
 * A reload can re-trigger the very write that caused it: reloading a Gmail tab that has a message
 * open re-marks it read, which is refused again. So recovery is capped — at most `maxPerWindow`
 * times per `windowMs` per tab, never within `cooldownMs` of the last one — and then suppressed,
 * which breaks the loop and falls back to the in-page notice.
 */
export class RecoveryScheduler {
  private timers = new Map<number, ReturnType<typeof setTimeout>>();
  private pending = new Map<number, Recovery>();
  private history = new Map<number, number[]>();

  constructor(private deps: RecoveryDeps) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  schedule(tabId: number, kind: Recovery): void {
    if (kind === 'none' || tabId < 0) return;
    const prev = this.pending.get(tabId);
    this.pending.set(tabId, prev === 'discard' ? 'discard' : kind);
    const existing = this.timers.get(tabId);
    if (existing) clearTimeout(existing);
    this.timers.set(tabId, setTimeout(() => void this.run(tabId), this.deps.delayMs ?? 1500));
  }

  /** True if a recovery is allowed for this tab now, given the cooldown and the rolling cap. */
  private allowed(tabId: number): { ok: true } | { ok: false; why: string } {
    const cooldown = this.deps.cooldownMs ?? 8000;
    const window = this.deps.windowMs ?? 60000;
    const cap = this.deps.maxPerWindow ?? 3;
    const now = this.now();
    const recent = (this.history.get(tabId) ?? []).filter((t) => now - t < window);
    this.history.set(tabId, recent);
    if (recent.length && now - recent[recent.length - 1]! < cooldown) return { ok: false, why: 'cooldown' };
    if (recent.length >= cap) return { ok: false, why: 'suppressed' };
    return { ok: true };
  }

  async run(tabId: number): Promise<void> {
    this.timers.delete(tabId);
    const kind = this.pending.get(tabId) ?? 'none';
    this.pending.delete(tabId);
    if (kind === 'none') return;
    const gate = this.allowed(tabId);
    if (!gate.ok) {
      this.deps.log?.(tabId, `recover-skip:${gate.why}`);
      return;
    }
    this.history.get(tabId)!.push(this.now());
    try {
      if (kind === 'discard') await this.deps.clearOrigin(tabId);
      await this.deps.reload(tabId);
      this.deps.log?.(tabId, `recover:${kind}`);
    } catch (err) {
      this.deps.log?.(tabId, `recover-failed:${kind}:${err instanceof Error ? err.message : String(err)}`);
    }
  }

  cancel(tabId: number): void {
    const t = this.timers.get(tabId);
    if (t) clearTimeout(t);
    this.timers.delete(tabId);
    this.pending.delete(tabId);
    this.history.delete(tabId);
  }
}
