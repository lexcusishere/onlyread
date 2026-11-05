import { describe, expect, it } from 'vitest';
import { nameFromHost, resolveSiteName, siteNameFromTitle } from './names';

describe('site naming from page metadata', () => {
  it('prefers og:site_name / application-name / manifest name', () => {
    expect(resolveSiteName('docs.google.com', { siteName: 'Google Docs', title: 'Plan - Google Docs' })).toBe('Google Docs');
  });
  it('takes the brand segment of the title, from either end', () => {
    expect(siteNameFromTitle('Inbox (3) - test.user@example.com - Gmail')).toBe('Gmail');
    expect(siteNameFromTitle('Google Calendar - Week of September 27, 2026')).toBe('Google Calendar');
    expect(siteNameFromTitle('Quarterly plan - Google Docs')).toBe('Google Docs');
    expect(siteNameFromTitle('Some video title - YouTube')).toBe('YouTube');
    expect(siteNameFromTitle('GitHub · Build and ship software on a single, collaborative platform')).toBe('GitHub');
    expect(siteNameFromTitle('YouTube')).toBe('YouTube');
  });
  it('rejects segments that are not brands', () => {
    expect(siteNameFromTitle('me@example.com - 2026-09-27 - 14:00')).toBeUndefined();
  });
  it('falls back to the host label, honouring two-level endings', () => {
    expect(nameFromHost('app.example.com')).toBe('Example');
    expect(nameFromHost('portal.somecorp.co.uk')).toBe('Somecorp');
    expect(resolveSiteName('localhost')).toBe('Localhost');
  });
});
