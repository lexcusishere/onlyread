import type { Message, SiteMeta } from '../shared/types';
import { resolveSiteName } from '../shared/names';

export { lockedBy, send } from '../shared/messaging';
export const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** Offline fallback marks; the real product icons come from `iconUrl` or the site favicon. */
const ICONS: Record<string, string> = {
  gmail: `<svg viewBox="0 0 48 36" aria-hidden="true"><path fill="#4285F4" d="M3.6 36h7.6V17.5L0 9.3v23.4C0 34.5 1.6 36 3.6 36z"/><path fill="#34A853" d="M36.8 36h7.6c2 0 3.6-1.5 3.6-3.3V9.3l-11.2 8.2z"/><path fill="#FBBC04" d="M36.8 3.3v14.2L48 9.3V5c0-4.1-4.9-6.4-8.3-3.9z"/><path fill="#EA4335" d="M11.2 17.5V3.3L24 12.9 36.8 3.3v14.2L24 27.1z"/><path fill="#C5221F" d="M0 5v4.3l11.2 8.2V3.3L8.3 1.1C4.9-1.4 0 .9 0 5z"/></svg>`,
  calendar: `<svg viewBox="0 0 48 48" aria-hidden="true"><rect x="4" y="4" width="40" height="40" rx="6" fill="#fff" stroke="#E0E3E7"/><path d="M4 10a6 6 0 0 1 6-6h28a6 6 0 0 1 6 6v6H4z" fill="#4285F4"/><path d="M38 44h-2v-8h8v2a6 6 0 0 1-6 6z" fill="#EA4335"/><path d="M4 36h8v8h-2a6 6 0 0 1-6-6z" fill="#188038"/><path d="M12 36h24v8H12z" fill="#34A853"/><path d="M36 16h8v20h-8z" fill="#FBBC04"/><text x="23" y="33" text-anchor="middle" font-family="-apple-system, Inter, Arial, sans-serif" font-size="14" font-weight="600" fill="#1967D2">31</text></svg>`,
  linear: `<svg viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="50" r="48" fill="#5E6AD2"/><g stroke="#fff" stroke-width="8" stroke-linecap="round"><path d="M22 78 78 22"/><path d="M14 58 58 14"/><path d="M42 86 86 42"/><path d="M12 42 42 12"/></g></svg>`,
  /** A site with no icon of its own: drawn sharp at any size, where Chrome's and Google's stand-ins are 16 px. */
  globe: `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="#8b90a0" stroke-width="1.6" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.6 2.7 3.9 5.7 3.9 9s-1.3 6.3-3.9 9M12 3C9.4 5.7 8.1 8.7 8.1 12s1.3 6.3 3.9 9"/></svg>`,
};

/** Chrome's own favicon cache for a host: the icon the tab strip shows, for any site the user visited. */
function chromeFavicon(host: string, size = 64): string {
  return chrome.runtime.getURL(`/_favicon/?pageUrl=${encodeURIComponent(`https://${host}/`)}&size=${size}`);
}

/** Icon chain: the site's declared/stored icon → Chrome's favicon cache → public favicon service → inline mark.
 *  Built as a node, not markup: the first URL can come from the page's own `<link rel=icon>`. */
export function iconImg(site: { id: string; builtin: boolean; domains: string[]; iconUrl?: string }): HTMLImageElement {
  const host = site.domains[0] ?? '';
  const chain = [site.iconUrl, chromeFavicon(host), `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`].filter(Boolean) as string[];
  const img = document.createElement('img');
  img.alt = '';
  img.dataset.fallback = site.builtin && ICONS[site.id] ? site.id : 'globe';
  img.dataset.next = encodeURIComponent(JSON.stringify(chain.slice(1)));
  img.src = chain[0]!;
  return img;
}

export function faviconImg(host: string, preferred?: string): HTMLImageElement {
  return iconImg({ id: host, builtin: false, domains: [host], iconUrl: preferred });
}

/** Ask the page what it is called and which icon it declares; undefined when no content script answers. */
async function pageMeta(tabId: number | undefined): Promise<SiteMeta | undefined> {
  if (tabId === undefined) return undefined;
  try { return (await chrome.tabs.sendMessage(tabId, { type: 'site:meta' } satisfies Message)) as SiteMeta; } catch { return undefined; }
}

export interface SiteIdentity { host: string; name: string; iconUrl?: string }

/** Name and icon for the page in a tab, from the page's own metadata, the tab, and the host. */
export async function identify(tab: { id?: number; title?: string; favIconUrl?: string }, host: string): Promise<SiteIdentity> {
  const meta = await pageMeta(tab.id);
  return {
    host,
    name: resolveSiteName(host, { siteName: meta?.siteName, title: meta?.title ?? tab.title }),
    iconUrl: tab.favIconUrl || meta?.iconUrl || undefined,
  };
}

/** The pixels of a loaded image, drawn at its natural size; undefined when it can't be read. */
function pixels(img: HTMLImageElement): Uint8ClampedArray | undefined {
  const w = img.naturalWidth, h = img.naturalHeight;
  if (!w || !h) return undefined;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx) return undefined;
  try { ctx.drawImage(img, 0, 0); return ctx.getImageData(0, 0, w, h).data; } catch { return undefined; }
}

export function samePixels(a: Uint8ClampedArray | undefined, b: Uint8ClampedArray | undefined): boolean {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Chrome's favicon cache answers a site it has no icon for with its default globe, as an ordinary image, not an
 *  error. Its pixels, per size, from a host that can't exist; compared with every icon the cache answers. */
const globes = new Map<string, Promise<Uint8ClampedArray | undefined>>();
function defaultGlobe(size: string): Promise<Uint8ClampedArray | undefined> {
  let g = globes.get(size);
  if (!g) {
    g = new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(pixels(img));
      img.onerror = () => resolve(undefined);
      img.src = chromeFavicon('onlyread-no-icon.invalid', Number(size));
    });
    globes.set(size, g);
  }
  return g;
}

/** Moves an icon to the next source in its chain, or to the inline mark (or hidden) when none is left. */
function nextIcon(img: HTMLImageElement): void {
  const next: string[] = img.dataset.next ? (JSON.parse(decodeURIComponent(img.dataset.next)) as string[]) : [];
  if (next.length) { img.dataset.next = encodeURIComponent(JSON.stringify(next.slice(1))); img.src = next[0]!; return; }
  const fb = img.dataset.fallback;
  if (fb && ICONS[fb]) img.outerHTML = ICONS[fb]!; else img.style.display = 'none';
}

/** Image fallback chain: official icon → site favicon → inline mark → hidden. A favicon that is only Chrome's default
 *  globe counts as missing. Registered once per page. */
export function installIconFallbacks(): void {
  document.addEventListener('error', (ev) => {
    const img = ev.target as HTMLImageElement;
    if (img instanceof HTMLImageElement && img.closest('.logo')) nextIcon(img);
  }, true);
  const cache = chrome.runtime.getURL('/_favicon/');
  document.addEventListener('load', (ev) => {
    const img = ev.target as HTMLImageElement;
    if (!(img instanceof HTMLImageElement) || !img.closest('.logo') || !img.src.startsWith(cache)) return;
    const src = img.src;
    const size = new URL(src).searchParams.get('size') ?? '';
    // Chrome has no icon for a site it has visited: the site has none. Straight to the drawn globe, not on to the
    // public favicon service, which would answer with its own blurry one.
    void defaultGlobe(size).then((globe) => { if (img.src === src && samePixels(pixels(img), globe)) { img.dataset.next = ''; nextIcon(img); } });
  }, true);
}

/** Host of the page the user is looking at: the active tab, or the most recent web tab when the
 *  active one is an extension page (e.g. the popup opened as a tab). */
export async function activeWebTab(): Promise<{ tab: chrome.tabs.Tab; host: string } | undefined> {
  try {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    const web = (t: chrome.tabs.Tab) => { try { const u = new URL(t.url ?? ''); return /^https?:$/.test(u.protocol) ? u.hostname : ''; } catch { return ''; } };
    const active = tabs.find((t) => t.active);
    if (active && web(active)) return { tab: active, host: web(active) };
    const recent = tabs.filter((t) => web(t)).sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))[0];
    return recent ? { tab: recent, host: web(recent) } : undefined;
  } catch { return undefined; }
}

