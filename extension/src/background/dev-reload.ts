// Development builds only (index.ts): reloading by itself while `npm run dev` runs (scripts/dev.mjs). Once a second
// the background asks the dev script for the newest build: a new one that changed the background, a content script or
// the manifest reloads the extension and opens again the pages of its own that were open; one that changed only the
// settings page, the popup or the setup window reloads those pages (shared/dev-reload.ts). With no dev script running
// the question fails quietly, and nothing else happens.

const ENDPOINT = 'http://127.0.0.1:4179/dev-reload';
/** The extension's own pages open when it reloaded itself, opened again once it is back. */
const REOPEN_KEY = 'devReopen';
const PAGES_RELOAD = 'dev:reload-pages';

type Stamp = { id: string; kind: 'extension' | 'pages' };

export function startDevReload(): void {
  // A browser driven by automation (the e2e suites, Playwright) is left alone: a reload there removes the extension,
  // and a developer's `npm run dev` beside the tests would otherwise pull it out from under them.
  if ((navigator as Navigator & { webdriver?: boolean }).webdriver) return;
  void reopenPages();
  let last: string | undefined;
  setInterval(async () => {
    let stamp: Stamp;
    try { stamp = (await (await fetch(ENDPOINT, { cache: 'no-store' })).json()) as Stamp; } catch { return; }
    // An extension call keeps this worker awake while the dev script runs; without it, nothing keeps it.
    void chrome.runtime.getPlatformInfo();
    if (last === undefined || stamp.id === last) { last = stamp.id; return; }
    last = stamp.id;
    if (stamp.kind === 'pages') { void chrome.runtime.sendMessage({ type: PAGES_RELOAD }).catch(() => {}); return; }
    await rememberPages();
    chrome.runtime.reload();
  }, 1000);
}

async function rememberPages(): Promise<void> {
  const open = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.TAB] }).catch(() => []);
  const urls = open.map((c) => c.documentUrl).filter((u): u is string => Boolean(u));
  await chrome.storage.local.set({ [REOPEN_KEY]: urls }).catch(() => {});
}

async function reopenPages(): Promise<void> {
  const got = await chrome.storage.local.get(REOPEN_KEY).catch(() => ({}) as Record<string, unknown>);
  const urls = got[REOPEN_KEY];
  if (!Array.isArray(urls)) return;
  await chrome.storage.local.remove(REOPEN_KEY).catch(() => {});
  for (const url of urls) if (typeof url === 'string') void chrome.tabs.create({ url, active: false }).catch(() => {});
}
