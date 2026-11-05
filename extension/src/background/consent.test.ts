import { describe, expect, it } from 'vitest';
import { consentFrom } from './consent';
import { overviewAction } from '../shared/status-text';

describe('consentFrom', () => {
  it('asks in a release and counts as given in a development build, until either is said', () => {
    expect(consentFrom(undefined, false)).toBe(false);
    expect(consentFrom(undefined, true)).toBe(true);
    expect(consentFrom({ agreed: true, at: 1 }, false)).toBe(true);
    expect(consentFrom({ agreed: false, at: 1 }, true)).toBe(false);
    expect(consentFrom({ agreed: 'yes' }, false)).toBe(false);
  });
});

describe('the overview while the judge waits for agreement', () => {
  it('says so first and points at the judge section', () => {
    const a = overviewAction({ enabled: true, mode: 'enforce', attachmentActive: true, attachedTabs: 1, judge: 'rules-only', judgeConsent: false, cloud: undefined } as never);
    expect(a?.text).toMatch(/until you agree to what it is sent/);
    expect(a?.button?.action).toBe('set-key');
  });
});
