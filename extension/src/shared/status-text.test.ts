import { describe, expect, it } from 'vitest';
import { exclusionLine, overviewAction, overviewFacts, overviewHeading, popupFooter, problemLine, siteSummary } from './status-text';
import type { CloudStatus, Status } from './types';

const cloudOff: CloudStatus = { provider: 'byok', serviceUrl: 'https://api.example.com', signedIn: false };
const st = (over: Partial<Status> = {}) => ({
  enabled: true, mode: 'enforce' as const, attachmentActive: true, attachedTabs: 2, judge: 'jev', judgeProblem: undefined, cloud: cloudOff, ...over,
});
const pro = (over: Partial<CloudStatus> = {}): CloudStatus => ({
  provider: 'cloud', serviceUrl: 'https://api.example.com', signedIn: true,
  account: { email: 'a@example.com', plan: 'cloud', status: 'active', usage: 1, cap: 100, resetsAt: '2026-10-01T00:00:00Z', links: { pricing: 'p', manage: 'm' } },
  ...over,
});

describe('popupFooter', () => {
  it('walks the states in order, warning only when something needs attention', () => {
    expect(popupFooter(st({ enabled: false }))).toEqual({ text: 'Protection is off', warn: true });
    expect(popupFooter(st({ attachmentActive: false }))).toEqual({ text: 'Standing by for an AI agent', warn: false });
    expect(popupFooter(st({ mode: 'monitor' })).warn).toBe(true);
    expect(popupFooter(st({ attachedTabs: 0 })).text).toBe('Protecting, no guarded site open');
    expect(popupFooter(st())).toEqual({ text: 'Protecting, writes are refused', warn: false });
  });
  it('puts a Pro problem first, even over "off"', () => {
    expect(popupFooter(st({ enabled: false, cloud: pro({ lastError: { code: 'unavailable', at: 0 } }) })).text).toMatch(/unreachable/);
  });
  it('warns about a background problem (startup, settings, storage) before the protecting lines', () => {
    expect(popupFooter(st({ startupProblem: 'x' }))).toEqual({ text: 'Startup did not finish. Reload the extension', warn: true });
    expect(popupFooter(st({ startupProblem: 'x', enabled: false })).text).toMatch(/^Startup did not finish/);
    expect(popupFooter(st({ storageProblem: 'x', enabled: false })).text).toBe('Protection is off');
    expect(popupFooter(st({ policyProblem: 'x' }))).toEqual({ text: 'Stored settings were invalid. Defaults in use', warn: true });
    expect(popupFooter(st({ policyProblem: 'x', policyRepaired: 'uploads' }))).toEqual({ text: 'A stored setting was reset (uploads). Check the settings', warn: true });
    expect(popupFooter(st({ storageProblem: 'x' }))).toEqual({ text: 'Storage problem. The activity log may be behind', warn: true });
    expect(popupFooter(st({ verdictsProblem: 'quota', storageProblem: 'x' }))).toEqual({ text: 'Tested verdicts not restored. Reads are judged', warn: true });
    expect(popupFooter(st({ mode: 'monitor' })).text).toMatch(/^Monitor mode/);
    expect(popupFooter(st()).warn).toBe(false);
  });
  it('says what the Pro account\'s site list is waiting for, after "off"', () => {
    const pending = 'Your Pro account asks to switch gmail off; this applies when the agent session ends';
    expect(popupFooter(st({ managedPending: pending }))).toEqual({ text: pending, warn: true });
    expect(popupFooter(st({ managedPending: pending, policyProblem: 'x' })).text).toBe(pending);
    expect(popupFooter(st({ managedPending: pending, enabled: false })).text).toBe('Protection is off');
  });
});

describe('problemLine', () => {
  it('names the problem for the settings page, startup first, and is empty when there is none', () => {
    expect(problemLine(st())).toBe('');
    expect(problemLine(st({ storageProblem: 'the activity log could not be saved (quota)' }))).toBe('Storage problem: the activity log could not be saved (quota).');
    expect(problemLine(st({ startupProblem: 'site verdicts not restored: quota', storageProblem: 'x' }))).toBe('Startup did not finish (site verdicts not restored: quota). Reload the extension.');
    expect(problemLine(st({ policyProblem: 'The stored settings were invalid (mode must be monitor|enforce, got audit); the defaults are in use' }))).toBe('The stored settings were invalid (mode must be monitor|enforce, got audit); the defaults are in use.');
    expect(problemLine(st({ managedPending: 'Your Pro account asks to switch gmail off; enter your settings PIN to apply it', storageProblem: 'x' }))).toBe('Your Pro account asks to switch gmail off; enter your settings PIN to apply it.');
    expect(problemLine(st({ verdictsProblem: 'quota' }))).toBe("The sites' tested verdicts were not restored (quota); their reads are judged until the next successful start.");
  });
});

describe('site row text', () => {
  it('uses the first sentence of the description', () => {
    expect(siteSummary('Read mail, search and open messages. Refuses star, archive and send.')).toBe('Read mail, search and open messages.');
    expect(siteSummary('One sentence only')).toBe('One sentence only');
    // True whether the row is on or off and in any mode: nothing about writes being refused.
    expect(siteSummary(undefined)).toBe('Requests are checked by the AI judge.');
    expect(siteSummary(undefined)).not.toMatch(/refused/);
  });
  it('turns out-of-scope entries into short "not guarded" lines', () => {
    expect(exclusionLine(['Messenger (chats and sending messages): not guarded, so messages are delivered even in enforce'])).toBe('Messenger is not guarded.');
    expect(exclusionLine(['Chat', 'Calls: voice'])).toBe('Chat is not guarded. Calls is not guarded.');
    expect(exclusionLine(undefined)).toBe('');
  });
});

describe('the settings page\'s status card', () => {
  const ov = (over: Partial<Status> = {}) => ({ ...st(over), attachWhen: 'agent-session' as const, agentSession: false, byokLabel: 'OpenRouter', ...over });
  const values = (o: Partial<Status>) => overviewFacts(ov(o)).map((f) => (f.warn ? `!${f.value}` : f.value));

  it('heads it with the state, never a subtitle', () => {
    expect(overviewHeading(ov())).toBe('Your agents are read-only');
    expect(overviewHeading(ov({ enabled: false }))).toBe('Protection is off');
    expect(overviewHeading(ov({ mode: 'monitor' }))).toMatch(/^Monitor mode/);
  });

  it('gives Protection, Agent and AI judge, with colour only on the one that needs attention', () => {
    expect(overviewFacts(ov()).map((f) => f.label)).toEqual(['Protection', 'Agent', 'AI judge']);
    expect(values({})).toEqual(['On, during agent sessions', 'None working now', 'Your OpenRouter key']);
    expect(values({ attachWhen: 'always', agentSession: true })).toEqual(['On, always', 'Working now', 'Your OpenRouter key']);
    expect(values({ agentSession: true, agentWhere: 'bing.com' })[1]).toBe('Working now, on bing.com');
    expect(values({ enabled: false })[0]).toBe('!Off');
    expect(values({ mode: 'monitor' })[0]).toBe('!Monitor mode');
    expect(values({ judge: 'rules-only' })[2]).toBe('!Not set up');
    expect(values({ cloud: pro() })[2]).toBe('Pro');
    expect(values({ cloud: pro({ signedIn: false, account: undefined }) })[2]).toBe('!Pro, not signed in');
    expect(values({ cloud: pro({ signedIn: false, account: undefined, signedOutAt: 1 }) })[2]).toBe('!Pro, signed out');
    expect(values({ cloud: pro({ lastError: { code: 'not_signed_in', at: 1 } }) })[2]).toBe('!Pro, signed out');
    expect(values({ cloud: pro({ lastError: { code: 'subscription_inactive', at: 1 } }) })[2]).toBe('!Pro, subscription inactive');
    expect(values({ cloud: pro({ lastError: { code: 'limit_reached', at: 1 } }) })[2]).toBe('!Pro, usage used up');
    expect(values({ cloud: pro({ lastError: { code: 'unavailable', at: 1 } }) })[2]).toBe('!Pro, unreachable');
    expect(values({ byokLabel: undefined })[2]).toBe('Your own key');
    expect(values({ byokLabel: 'OpenRouter' })[2]).toBe('Your OpenRouter key');
  });

  it('has no action row when all is well', () => {
    expect(overviewAction(ov())).toBeUndefined();
    expect(overviewAction(ov({ cloud: pro() }))).toBeUndefined();
  });

  it('shows the most important problem with one button', () => {
    const a = (o: Partial<Status>) => { const r = overviewAction(ov(o)); return [r?.text, r?.button?.action, r?.button?.label]; };
    expect(a({ startupProblem: 'x', enabled: false })).toEqual(['Startup did not finish (x).', 'reload', 'Reload OnlyRead']);
    expect(a({ enabled: false, judge: 'rules-only' })).toEqual(['Nothing is guarded while protection is off.', 'enable', 'Turn on']);
    expect(a({ cloud: pro({ signedIn: false, account: undefined, signedOutAt: 1 }) })[1]).toBe('signin');
    expect(a({ cloud: pro({ signedIn: false, account: undefined, signedOutAt: 1 }) })[2]).toBe('Sign in again');
    expect(a({ cloud: pro({ signedIn: false, account: undefined }) })[2]).toBe('Sign in');
    expect(a({ cloud: pro({ lastError: { code: 'subscription_inactive', at: 1 } }) })[1]).toBe('subscribe');
    expect(a({ cloud: pro({ lastError: { code: 'limit_reached', at: 1 } }) })[1]).toBe('manage');
    expect(a({ cloud: pro({ lastError: { code: 'unavailable', at: 1 } }) })[1]).toBe('retry');
    expect(a({ judge: 'rules-only', judgeProblem: 'add your OpenRouter API key' })).toEqual(['The AI judge needs your OpenRouter API key, so requests no rule covers are refused.', 'set-key', 'Set up a key']);
    expect(a({ mode: 'monitor' })[1]).toBe('enforce');
    expect(a({ storageProblem: 'quota' })).toEqual(['Storage problem: quota.', undefined, undefined]);
  });

  it('offers Unlock for a change from the account that waits for the PIN, and nothing while an agent works', () => {
    const pending = { managedPending: 'Your Pro account asks to remove x; this applies when you enter your settings PIN' };
    expect(overviewAction({ ...ov(pending), lock: { agent: false, pinSet: true, pinUnlocked: false } })?.button?.action).toBe('unlock');
    expect(overviewAction({ ...ov(pending), lock: { agent: true, pinSet: true, pinUnlocked: false } })?.button).toBeUndefined();
    expect(overviewAction(ov(pending))?.text).toBe(`${pending.managedPending}.`);
  });
});
