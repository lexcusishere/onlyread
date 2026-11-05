/** Generic site naming. Nothing here knows any particular site: names come from the page's own
 *  metadata first (see SiteMeta), then from the title, then from the host. */

const SEPARATORS = /\s+[-–—|·•:]\s+/;

/** The brand segment of a document title: "Inbox (3) - me@x.com - Gmail" → "Gmail",
 *  "Google Calendar - Week of…" → "Google Calendar", "Quarterly plan - Google Docs" → "Google Docs". */
export function siteNameFromTitle(title: string | undefined): string | undefined {
  if (!title) return undefined;
  const parts = title.split(SEPARATORS).map((x) => x.trim()).filter(Boolean);
  if (parts.length === 0) return undefined;
  if (parts.length === 1) return brandLike(parts[0]!) ? parts[0] : undefined;
  // brands sit at an end of the title; prefer the last segment, then the first
  const candidates = [parts[parts.length - 1]!, parts[0]!].filter(brandLike);
  return candidates[0];
}

function brandLike(s: string): boolean {
  if (s.length < 2 || s.length > 28) return false;
  if (/@|\d{2,}|\(|\)|https?:/.test(s)) return false;  // e-mails, counts, dates, URLs are not brands
  if (s.split(/\s+/).length > 3) return false;
  return /\p{L}/u.test(s);
}

/** Last resort: the registrable label of the host, capitalised ("app.example.com" → "Example"). */
export function nameFromHost(host: string): string {
  const h = host.trim().toLowerCase().replace(/^www\./, '');
  if (!h) return host;
  const parts = h.split('.');
  const twoLevel = parts.length >= 3 && /^(co|com|org|ac|net|gov|edu)$/.test(parts[parts.length - 2]!) && parts[parts.length - 1]!.length === 2;
  const label = parts.length >= 2 ? parts[parts.length - (twoLevel ? 3 : 2)]! : parts[0]!;
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/** Pick the site's display name from what the page says, then its title, then its host. */
export function resolveSiteName(host: string, meta?: { siteName?: string; title?: string }): string {
  const fromMeta = meta?.siteName?.trim();
  if (fromMeta && fromMeta.length <= 40) return fromMeta;
  return siteNameFromTitle(meta?.title) ?? nameFromHost(host);
}
