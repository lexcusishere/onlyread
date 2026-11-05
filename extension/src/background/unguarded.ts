// Guarded tabs the debugger does not hold. A failed attach (an error, a setup command that
// timed out on a paused tab, a detach) leaves a tab with no interception; its writes are refused by one
// per-tab session rule until the debugger holds it again.
//
// Two states are kept apart: the tabs that should be blocked (desired) and the rule the browser accepted
// (installed). A failed rule update is not success: callers keep the global fallback until `installed`
// is true, and every retry re-sends the rule until the browser takes it, even when the tabs did not change.
// Updates run one at a time, and each one reads the current desired set, so a slow retry cannot put
// back a tab that a detach or a policy change has since removed (or drop one it added).

interface UnguardedDeps {
  /** The rule for these tabs under the current policy (null: nothing to block, e.g. monitor or dormant). */
  ruleFor: (tabIds: number[]) => chrome.declarativeNetRequest.Rule | null;
  /** Installs (or, with null, removes) the rule. Rejects when the browser refuses it. */
  install: (rule: chrome.declarativeNetRequest.Rule | null) => Promise<void>;
  /** Tries to hold the tab again: held, still failing, or gone (closed, or no longer a guarded page). */
  reattach: (tabId: number) => Promise<'held' | 'failed' | 'gone'>;
  /** Turns the global fail-closed rule (every write to the guarded domains refused) on or off. */
  setGlobalBlock: (on: boolean) => Promise<void>;
  log: (msg: string) => void;
}

/** Whether a debugger detach leaves a guarded tab needing cover: not when the tab closed, and not while
 *  protection is dormant (agent-session mode between sessions) or off, where a detach is expected. */
export function detachNeedsCover(reason: string, attachmentActive: boolean): boolean {
  return reason !== 'target_closed' && attachmentActive;
}

export class UnguardedTabs {
  private desired = new Set<number>();
  private installedKey: string | null = null; // unknown until the first update: a session rule can outlive the worker
  private chain: Promise<unknown> = Promise.resolve();
  /** The global block is on and waits for the per-tab rule before it may be lifted. */
  private liftPending = false;

  constructor(private readonly deps: UnguardedDeps) {}

  /** The tabs whose writes should be refused by rule. */
  tabs(): number[] { return [...this.desired]; }
  has(tabId: number): boolean { return this.desired.has(tabId); }
  /** True when the browser holds the rule for the current desired set. */
  get installed(): boolean { return this.installedKey === this.key(); }

  /** Replace the whole set (after attaching to every guarded tab). Resolves to whether the rule is installed. */
  replace(ids: Iterable<number>): Promise<boolean> { return this.run(() => { this.desired = new Set(ids); }, true); }
  /** `quiet`: a routine change not worth a line in the decision log (an agent look's moment of let-go, agent-session.ts);
   *  a rule that fails to install is logged all the same. */
  add(tabId: number, quiet = false): Promise<boolean> { return this.run(() => { this.desired.add(tabId); }, false, quiet); }
  remove(tabIds: Iterable<number>, quiet = false): Promise<boolean> { return this.run(() => { for (const id of tabIds) this.desired.delete(id); }, false, quiet); }

  /** After attaching to every guarded tab: block the ones that failed by rule, then lift the global block
   *  (on when `globalOn`), but only once the browser accepted that rule. Resolves to whether it did. */
  async settle(failed: Iterable<number>, globalOn: boolean): Promise<boolean> {
    if (globalOn) this.liftPending = true; // lifted by run() once the per-tab rule is confirmed
    return this.replace(failed);
  }

  /** A guarded tab lost its interception (a detach, or a new page the debugger could not attach to). */
  lost(tabId: number): Promise<boolean> { return this.add(tabId); }

  /** Dormant: nothing is guarded, so nothing is blocked. */
  async clear(): Promise<void> {
    this.liftPending = false;
    await this.replace([]);
  }

  /** Tries each tab again and re-sends the rule if the browser has not accepted it (run() then lifts a
   *  waiting global block). Resolves to `installed`. */
  async retry(): Promise<boolean> {
    if (!this.desired.size && this.installed && !this.liftPending) return true;
    const held: number[] = [];
    for (const tabId of [...this.desired]) {
      if ((await this.deps.reattach(tabId)) !== 'failed') held.push(tabId);
    }
    return this.remove(held);
  }

  private rule(): chrome.declarativeNetRequest.Rule | null {
    return this.deps.ruleFor([...this.desired].sort((a, b) => a - b));
  }
  private key(rule = this.rule()): string {
    return rule ? JSON.stringify(rule) : 'none';
  }

  /** Every change goes through here, whichever path asked for it (startup, a detach, a new tab, a retry):
   *  - the browser refuses a rule that some tab needs → the global block goes on (and stays on) until a
   *    later update is confirmed, so an unheld tab is never left without a block;
   *  - the browser confirms the rule → a global block this class turned on (or was asked to lift) is lifted,
   *    after the per-tab rule is in place. */
  private run(mutate: () => void, force = false, quiet = false): Promise<boolean> {
    const next = this.chain.then(async () => {
      mutate();
      const rule = this.rule();
      const key = this.key(rule);
      if (!force && key === this.installedKey) { await this.liftIfPending(); return true; }
      try {
        await this.deps.install(rule);
        this.installedKey = key;
        if (!quiet) this.deps.log(`unguarded-tabs:${[...this.desired].join(',') || 'none'}`);
        await this.liftIfPending();
        return true;
      } catch (err) {
        this.installedKey = null; // unknown: the next update or retry sends it again
        this.deps.log(`unguarded-tabs:install-failed:${err instanceof Error ? err.message : String(err)}`);
        if (rule) {
          // Some tab needs the rule and does not have it: block every write to the guarded sites instead.
          this.liftPending = true;
          this.deps.log('fail-closed:on (unguarded-tab rule not installed)');
          await this.deps.setGlobalBlock(true);
        }
        return false;
      }
    });
    this.chain = next.catch(() => undefined);
    return next;
  }

  private async liftIfPending(): Promise<void> {
    if (!this.liftPending) return;
    this.liftPending = false;
    await this.deps.setGlobalBlock(false);
  }
}
