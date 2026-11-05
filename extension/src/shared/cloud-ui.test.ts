import { describe, it, expect } from 'vitest';
import { accountActive, accountStatusText, cloudProblem, cloudUsage, proManaged, usagePercent } from './cloud-ui';
import type { CloudStatus } from './types';

const base = (over: Partial<CloudStatus> = {}): CloudStatus => ({
  provider: 'cloud', serviceUrl: 'https://api.example.com', signedIn: true,
  account: { email: 'a@example.com', plan: 'cloud', status: 'active', usage: 10, cap: 100, resetsAt: '2026-10-01T00:00:00Z', links: { pricing: 'p', manage: 'm' } },
  ...over,
});

describe('cloudProblem', () => {
  it('is silent for your-own-key mode and for a healthy account', () => {
    expect(cloudProblem({ ...base(), provider: 'byok', signedIn: false })).toBeUndefined();
    expect(cloudProblem(base())).toBeUndefined();
  });
  it('names each failure with the action that fixes it', () => {
    expect(cloudProblem(base({ signedIn: false }))?.action).toBe('signin');
    // Not signed in, whether never or because the service ended the sign-in: no judge for this browser.
    expect(cloudProblem(base({ signedIn: false }))).toEqual({ text: 'No AI Judge configured for this browser', action: 'signin' });
    expect(cloudProblem(base({ signedIn: false, signedOutAt: 1 }))).toEqual({ text: 'No AI Judge configured for this browser', action: 'signin' });
    expect(cloudProblem(base({ account: { ...base().account!, status: 'canceled' } }))?.action).toBe('subscribe');
    expect(cloudProblem(base({ lastError: { code: 'subscription_inactive', at: 0 } }))?.action).toBe('subscribe');
    expect(cloudProblem(base({ account: { ...base().account!, usage: 100 } }))?.action).toBe('wait');
    expect(cloudProblem(base({ lastError: { code: 'unavailable', at: 0 } }))?.action).toBe('retry');
  });
  it('on free credits: what is left, and when none is, a code (not "subscription inactive")', () => {
    const credits = (left: number) => base({ account: { ...base().account!, status: left > 0 ? 'active' : 'credits_exhausted', usage: 1000 - left, cap: 1000, credits: { left, total: 1000 } } });
    expect(cloudProblem(credits(740))).toBeUndefined();
    expect(cloudUsage(credits(740))).toBe('740 of 1,000 free judged requests left');
    expect(cloudProblem(credits(0))).toEqual({ text: 'OnlyRead Pro: your free judged requests are used up, so uncertain requests are refused. Add a code on your Pro account page', action: 'subscribe' });
    expect(cloudProblem(base({ lastError: { code: 'credits_exhausted', at: 0 } }))?.action).toBe('subscribe');
  });
  it('shows usage as a share of the month, never as counts', () => {
    expect(cloudUsage(base())).toMatch(/^10% of this month's usage, resets /);
    expect(cloudUsage(undefined)).toBe('');
  });
  it('rounds usage up so any use is visible, and caps it at 100%', () => {
    expect(usagePercent(0, 5000)).toBe(0);
    expect(usagePercent(1, 5000)).toBe(1);
    expect(usagePercent(1284, 5000)).toBe(26);
    expect(usagePercent(6000, 5000)).toBe(100);
  });
});

// The service's own words and verdict (CloudAccount): shown as given, so a change of plan needs no release; an older
// service sends none and the extension's own wording stays.
describe('the service\'s own words', () => {
  it('takes the service\'s verdict on whether Pro is active over the status', () => {
    expect(accountActive({ ...base().account!, status: 'paused', active: true })).toBe(true);
    expect(accountActive({ ...base().account!, status: 'active', active: false })).toBe(false);
    expect(accountActive({ ...base().account!, status: 'trialing' })).toBe(true);
    expect(cloudProblem(base({ account: { ...base().account!, status: 'paused', active: true } }))).toBeUndefined();
  });
  it('shows its status, usage line and refusal message, and its own wording without them', () => {
    const a = { ...base().account!, active: false, statusText: 'trial ended', usageText: '12 of 50 requests this week' };
    expect(accountStatusText(a)).toBe('trial ended');
    expect(accountStatusText({ ...base().account!, status: 'trialing' })).toBe('trial');
    expect(cloudUsage(base({ account: a }))).toBe('12 of 50 requests this week');
    expect(cloudProblem(base({ account: a }))).toEqual({ text: 'OnlyRead Pro: trial ended, so uncertain requests are refused', action: 'subscribe' });
    expect(cloudProblem(base({ lastError: { code: 'subscription_inactive', at: 0, message: 'Your trial ended. Subscribe to keep using Pro.' } })))
      .toEqual({ text: 'Your trial ended. Subscribe to keep using Pro.', action: 'subscribe' });
    expect(cloudProblem(base({ lastError: { code: 'limit_reached', at: 0, message: 'This week is used up.' } }))?.action).toBe('wait');
  });
});

describe('proManaged: Pro mode with Pro reachable, managed on the account page', () => {
  const base = { provider: 'cloud' as const, serviceUrl: 'https://pro.onlyread.ai', signedIn: true };
  it('is Pro judging, signed in, and no failure to reach Pro in the last five minutes', () => {
    expect(proManaged(base, 1_000_000)).toBe(true);
    expect(proManaged({ ...base, lastError: { code: 'unavailable', at: 1_000_000 - 60_000 } }, 1_000_000)).toBe(false);
    expect(proManaged({ ...base, lastError: { code: 'unavailable', at: 1_000_000 - 6 * 60_000 } }, 1_000_000)).toBe(true);
    // Any other failure (a lapsed plan, credits used up) is the account page's to show.
    expect(proManaged({ ...base, lastError: { code: 'subscription_inactive', at: 1_000_000 } }, 1_000_000)).toBe(true);
  });
  it('is not an own key, nor Pro signed out, nor no status at all', () => {
    expect(proManaged({ ...base, provider: 'byok' })).toBe(false);
    expect(proManaged({ ...base, signedIn: false })).toBe(false);
    expect(proManaged(undefined)).toBe(false);
  });
});
