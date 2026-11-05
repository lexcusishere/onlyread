import { afterEach, describe, expect, it, vi } from 'vitest';
import { discoverSite, parseHead } from './site-discover';

describe('parseHead', () => {
  it('prefers a touch icon, then an SVG, then the largest icon, and resolves relative links', () => {
    const html = `<head><title>Acme Docs</title>
      <link rel="icon" href="/favicon-16.png" sizes="16x16">
      <link rel='icon' type="image/png" href="icons/32.png" sizes="32x32">
      <link rel="apple-touch-icon" href="/apple.png">
      <link rel="mask-icon" href="/mask.svg"></head>`;
    expect(parseHead(html, 'https://docs.acme.io/').iconUrl).toBe('https://docs.acme.io/apple.png');
    expect(parseHead(html.replace(/<link rel="apple[^>]*>/, ''), 'https://docs.acme.io/').iconUrl).toBe('https://docs.acme.io/icons/32.png');
    expect(parseHead('<link rel="icon" href="/i.svg"><link rel="icon" href="/i.png" sizes="64x64">', 'https://a.io/').iconUrl).toBe('https://a.io/i.svg');
  });
  it('reads the site name and title', () => {
    const r = parseHead('<meta property="og:site_name" content="Acme"><title>Home · Acme</title>', 'https://a.io/');
    expect(r).toMatchObject({ siteName: 'Acme', title: 'Home · Acme' });
  });
  it('finds nothing in a page without icons', () => {
    expect(parseHead('<html><body>hi</body></html>', 'https://a.io/').iconUrl).toBeUndefined();
  });
});

describe('discoverSite', () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  /** A fake network: url → response. Records what was requested and with which credentials. */
  const net = (routes: Record<string, () => Response>) => {
    const calls: { url: string; credentials?: RequestCredentials }[] = [];
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      calls.push({ url, credentials: init?.credentials });
      const r = routes[url];
      if (!r) throw new TypeError('fetch failed');
      const res = r();
      Object.defineProperty(res, 'url', { value: url });
      return res;
    });
    return calls;
  };
  const html = (body: string) => () => new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });

  it('reads the icon and name from the home page, without cookies', async () => {
    const calls = net({ 'https://acme.io/': html('<title>Acme</title><link rel="icon" href="/i.svg">') });
    expect(await discoverSite('acme.io')).toEqual({ name: 'Acme', iconUrl: 'https://acme.io/i.svg' });
    expect(calls.every((c) => c.credentials === 'omit')).toBe(true);
  });
  it('falls back to /favicon.ico when the page declares no icon', async () => {
    net({ 'https://acme.io/': html('<title>Acme</title>'), 'https://acme.io/favicon.ico': () => new Response('x', { status: 200, headers: { 'content-type': 'image/x-icon' } }) });
    expect(await discoverSite('acme.io')).toEqual({ name: 'Acme', iconUrl: 'https://acme.io/favicon.ico' });
  });
  it('ignores a favicon.ico that is not an image, and a page that is not HTML', async () => {
    net({ 'https://acme.io/': () => new Response('{}', { headers: { 'content-type': 'application/json' } }), 'https://acme.io/favicon.ico': () => new Response('<html>', { headers: { 'content-type': 'text/html' } }) });
    expect(await discoverSite('acme.io')).toEqual({ name: undefined, iconUrl: undefined });
  });
  it('finds nothing, without throwing, when the site is unreachable', async () => {
    net({});
    expect(await discoverSite('down.example')).toEqual({ name: undefined, iconUrl: undefined });
  });
});
