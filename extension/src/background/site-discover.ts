// Name and icon for a site added by host name (the settings page has no open tab to read them from).
// Fetches the site's home page without cookies and reads what it declares: the icon links and the site
// name. The pure parser is separate so it can be tested.
import { resolveSiteName } from '../shared/names';

interface Discovered { name?: string; iconUrl?: string }

const attr = (tag: string, name: string): string | undefined => {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return m ? (m[2] ?? m[3] ?? m[4]) : undefined;
};

/** An icon link's score: a touch icon first, then a vector icon, then by declared size (16 when none). */
function iconScore(rel: string, tag: string, href: string): number {
  if (rel.includes('apple-touch-icon')) return 180;
  if (/\.svg(\?|$)/i.test(href) || /svg/i.test(attr(tag, 'type') ?? '')) return 170;
  return Math.max(0, ...((attr(tag, 'sizes') ?? '').match(/\d+/g) ?? []).map(Number)) || 16;
}

/** The icon links a page declares (not Safari's mask icon), as absolute URLs, best first. */
function iconLinks(head: string, pageUrl: string): string[] {
  const icons: { href: string; score: number }[] = [];
  for (const m of head.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    const rel = (attr(tag, 'rel') ?? '').toLowerCase();
    const href = attr(tag, 'href');
    if (!href || !/\bicon\b|apple-touch-icon/.test(rel) || /mask-icon/.test(rel)) continue;
    // Not an icon a page declares for dark mode only (media="(prefers-color-scheme: dark)", GitHub's white mark) disappears on the white tile the UI draws icons on.
    if (/prefers-color-scheme:\s*dark/i.test(attr(tag, 'media') ?? '')) continue;
    try { icons.push({ href: new URL(href, pageUrl).toString(), score: iconScore(rel, tag, href) }); } catch { /* bad href */ }
  }
  return icons.sort((a, b) => b.score - a.score).map((i) => i.href);
}

/** The content of the first <meta> whose property or name is `key`. */
function metaContent(head: string, key: string): string | undefined {
  for (const m of head.matchAll(/<meta\b[^>]*>/gi)) {
    const k = (attr(m[0], 'property') ?? attr(m[0], 'name') ?? '').toLowerCase();
    if (k === key) return attr(m[0], 'content');
  }
  return undefined;
}

/** The best icon a page declares (a large touch icon, then the largest or vector icon), and its name. */
export function parseHead(html: string, pageUrl: string): { iconUrl?: string; siteName?: string; title?: string } {
  const head = html.slice(0, 200_000);
  const title = /<title[^>]*>([^<]*)<\/title>/i.exec(head)?.[1]?.trim();
  return { iconUrl: iconLinks(head, pageUrl)[0], siteName: metaContent(head, 'og:site_name') ?? metaContent(head, 'application-name'), title };
}

async function fetchWithin(url: string, ms: number, init: RequestInit = {}): Promise<Response | undefined> {
  try { return await fetch(url, { ...init, credentials: 'omit', redirect: 'follow', signal: AbortSignal.timeout(ms) }); } catch { return undefined; }
}

/** Looks the site up; anything it cannot find is left undefined (the page falls back to the host). */
export async function discoverSite(host: string): Promise<Discovered> {
  const page = `https://${host}/`;
  const res = await fetchWithin(page, 5000);
  const html = res?.ok && /html/i.test(res.headers.get('content-type') ?? '') ? await res.text().catch(() => '') : '';
  const found = html ? parseHead(html, res?.url || page) : {};
  let iconUrl = found.iconUrl;
  if (!iconUrl) {
    const ico = await fetchWithin(new URL('/favicon.ico', res?.url || page).toString(), 4000);
    if (ico?.ok && /image/i.test(ico.headers.get('content-type') ?? 'image')) iconUrl = ico.url;
  }
  const name = found.siteName || found.title ? resolveSiteName(host, { siteName: found.siteName, title: found.title }) : undefined;
  return { name, iconUrl };
}
