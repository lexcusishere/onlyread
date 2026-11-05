import { describe, expect, it } from 'vitest';
import { checkFailure, checkFailureAction, checkFailureLine, noticeTitle, operationName, relativeTime, stoppedBy, stoppedLine } from './refusals';

describe('operationName', () => {
  it('names a decoded operation in sentence case, without the codes around it', () => {
    expect(operationName('fb:gql:w[useCometUFICreateCommentMutation]')).toBe('Create comment');
    expect(operationName('li:rsc:w[sharing.CreatePost]')).toBe('Create post');
    expect(operationName('li:rsc:w[update.deletePost]')).toBe('Delete post');
    expect(operationName('gql:mutation:UserSettingsUpdate')).toBe('User settings update');
    expect(operationName('gcal:sync:w[event,set:defaultCalMode]')).toBe('Event');
  });
  it('gives nothing for a shape that names no operation a person would know', () => {
    for (const s of ['json:title', 'fb:gql:w[unknown]', 'li:rsc:w[unparseable]', 'gmail:s:w[^i,^u]', 'gtasks:sync:w[3]', 'gql:mutation:-', '', undefined]) {
      expect(operationName(s)).toBeUndefined();
    }
  });
});

describe('check failures', () => {
  it('tells a check that could not run from a refusal', () => {
    expect(checkFailure('judge-error:cloud:not_signed_in')).toBe('pro-signed-out');
    expect(checkFailure('judge-error:cloud:subscription_inactive (x)')).toBe('pro-inactive');
    expect(checkFailure('judge-error:cloud:limit_reached')).toBe('pro-limit');
    // Free credits used up is its own cause, not an outage.
    expect(checkFailure('judge-error:cloud:credits_exhausted')).toBe('pro-credits');
    expect(checkFailure('judge-error:cloud:unavailable (http 503)')).toBe('pro-unreachable');
    expect(checkFailure('judge-error:cloud:something_new')).toBe('pro-unreachable');
    expect(checkFailure('judge-timeout')).toBe('judge-timeout');
    expect(checkFailure('review-band:llm-timeout')).toBe('judge-timeout');
    expect(checkFailure('judge-error:gateway said no')).toBe('judge-error');
    expect(checkFailure('decision-error:boom')).toBe('judge-error');
    for (const r of ['p>block', 'cached:label', 'decoded-write', 'mutating-method', 'review-band:block', '']) expect(checkFailure(r)).toBeUndefined();
  });
  it('says how many requests were stopped and why, and offers a fix only for a Pro sign-in', () => {
    expect(checkFailureLine('pro-signed-out', 1)).toBe("1 request was stopped because OnlyRead Pro is signed out and couldn't check it. Some of the page may not load.");
    expect(checkFailureLine('pro-credits', 1)).toBe("1 request was stopped because your free OnlyRead Pro requests are used up, so it couldn't be checked. Some of the page may not load.");
    // OnlyRead Pro's own words for refusing to check it say why in place of ours; never for a judge that is not Pro.
    expect(checkFailureLine('pro-inactive', 2, 'Your trial ended.')).toBe('2 requests were stopped: Your trial ended. Some of the page may not load.');
    expect(checkFailureLine('judge-timeout', 1, 'ignored')).toBe("1 request was stopped because the AI judge didn't answer in time. Some of the page may not load.");
    expect(checkFailureLine('judge-timeout', 3)).toBe("3 requests were stopped because the AI judge didn't answer in time. Some of the page may not load.");
    expect(checkFailureAction('pro-signed-out')).toBe('signin');
    expect(checkFailureAction('pro-unreachable')).toBeUndefined();
    expect(checkFailureAction(undefined)).toBeUndefined();
  });
});

describe('the notice text', () => {
  it('says what was kept read-only, and one plain line per change', () => {
    expect(noticeTitle('Linear')).toBe('OnlyRead kept Linear read-only');
    expect(stoppedLine('fb:gql:w[useCometUFICreateCommentMutation]', 'Facebook')).toBe('Stopped a change: Create comment.');
    expect(stoppedLine('json:title', 'Linear')).toBe('Stopped a change on Linear.');
  });
});

describe('stoppedBy', () => {
  it('names what stopped a refusal in words', () => {
    expect(stoppedBy({ source: 'rule', reason: 'mutating-method' })).toEqual({ text: 'Stopped by rule', judge: false });
    expect(stoppedBy({ source: 'dnr', reason: 'blocked-get-path' })).toEqual({ text: 'Stopped by rule', judge: false });
    expect(stoppedBy({ source: 'cache', reason: 'cached:label' })).toEqual({ text: 'Tested list', judge: false });
    expect(stoppedBy({ source: 'rule', reason: 'decoded-write' })).toEqual({ text: 'Decoded as a write', judge: false });
    expect(stoppedBy({ source: 'jev', reason: 'p>block', pWrite: 0.9412 })).toEqual({ text: 'AI judge', judge: true });
    expect(stoppedBy({ source: 'llm', reason: 'review-band:llm-block(p1=0.50)', pWrite: 0.8 })).toEqual({ text: 'AI judge', judge: true });
    expect(stoppedBy({ source: 'cloud', reason: 'review-band:block' })).toEqual({ text: 'AI judge, unsure', judge: true });
    expect(stoppedBy({ source: 'cloud', reason: 'p>block' })).toEqual({ text: 'AI judge', judge: true });
    expect(stoppedBy({ source: 'rule', reason: 'judge-error:cloud:not_signed_in' })).toEqual({ text: "Pro couldn't check it", judge: false });
    expect(stoppedBy({ source: 'rule', reason: 'judge-timeout' })).toEqual({ text: "The AI judge couldn't check it", judge: false });
    expect(stoppedBy({ source: 'rules-only', reason: 'review-band:block' })).toEqual({ text: 'No AI judge set up', judge: false });
    expect(stoppedBy({ source: 'system', reason: 'other' })).toEqual({ text: 'Stopped', judge: false });
  });
});

describe('relativeTime', () => {
  const now = new Date(2026, 9, 17, 15, 0, 0).getTime();
  it('counts minutes and hours today, then says yesterday, then a date', () => {
    expect(relativeTime(now - 10_000, now)).toBe('Just now');
    expect(relativeTime(now - 2 * 60_000, now)).toBe('2 min ago');
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe('3 h ago');
    expect(relativeTime(new Date(2026, 9, 16, 22, 0).getTime(), now)).toBe('Yesterday');
    expect(relativeTime(new Date(2026, 9, 12, 9, 0).getTime(), now)).toMatch(/12/);
    expect(relativeTime(now + 5000, now)).toBe('Just now');
  });
});

describe('operationName for WhatsApp', () => {
  it('names what a person did', () => {
    expect(operationName('whatsapp:message:w[text]')).toBe('Send message');
    expect(operationName('whatsapp:message:w[media]')).toBe('Send media');
    expect(operationName('whatsapp:message:w[text:edit1]')).toBe('Edit message');
    expect(operationName('whatsapp:message:w[text:edit7]')).toBe('Delete for everyone');
    expect(operationName('whatsapp:message:w[reaction]')).toBe('Reaction');
    expect(operationName('whatsapp:iq:w[w:g2]')).toBe('Group change');
    expect(operationName('whatsapp:receipt:w[read]')).toBe('Read receipt');
    expect(operationName('whatsapp:iq:w[newthing]')).toBeUndefined();
  });
});
