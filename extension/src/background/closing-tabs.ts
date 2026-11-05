// Guarded tabs whose page is closing. A request a page sends while it closes (a `keepalive` fetch or a beacon
// from its pagehide or unload handler) outlives the page: Chrome sends it after the tab's debugger session has
// ended, so it is never paused and never judged. A local-first app flushing its refused changes that way would
// get them through. The content script reports pagehide (it registers first, so it runs before the page's own
// handlers); from then until the tab is gone or a new page commits in it, every write from that tab is refused
// by one session rule. Navigating away refuses the old page's last writes too, which is the safe side.
interface ClosingDeps {
  ruleFor: (tabIds: number[]) => chrome.declarativeNetRequest.Rule | null;
  install: (rule: chrome.declarativeNetRequest.Rule | null) => Promise<void>;
}

/** How long a closed tab stays blocked: requests it started while closing may still be on their way. */
export const CLOSED_GRACE_MS = 5000;

export class ClosingTabs {
  private tabs = new Set<number>();
  private chain: Promise<unknown> = Promise.resolve();
  constructor(private readonly deps: ClosingDeps) {}

  /** The tabs whose writes are refused now. */
  list(): number[] { return [...this.tabs]; }
  add(tabId: number): Promise<void> { return this.update(() => this.tabs.add(tabId)); }
  /** A new page committed in the tab: its own requests are judged again. */
  committed(tabId: number): Promise<void> { return this.tabs.has(tabId) ? this.update(() => this.tabs.delete(tabId)) : Promise.resolve(); }
  /** The tab closed: keep refusing its writes for a moment, then forget it. */
  removed(tabId: number, schedule: (fn: () => void, ms: number) => unknown = setTimeout): void {
    if (this.tabs.has(tabId)) schedule(() => void this.update(() => this.tabs.delete(tabId)), CLOSED_GRACE_MS);
  }

  private update(change: () => void): Promise<void> {
    change();
    const next = this.chain.then(() => this.deps.install(this.deps.ruleFor([...this.tabs].sort((a, b) => a - b))));
    this.chain = next.catch((err: unknown) => console.warn('[onlyread] closing-tab rule failed:', err));
    return next;
  }
}
