import { describe, expect, it, vi } from 'vitest';
import type { Policy } from '../shared/types';

// selectJudges picks the judges from the policy and the stored keys; the cloud client and state are stand-ins.
const h = vi.hoisted(() => ({ secrets: {} as { keys?: Record<string, string> } }));
vi.mock('./state', () => ({
  S: { judge: undefined, reviewJudge: undefined, judgeProblem: undefined },
  getSecrets: vi.fn(async () => h.secrets),
}));
vi.mock('./cloud-session', () => ({ cloudClient: vi.fn(() => ({ serviceUrl: 'https://pro.example' })), onCloudResult: vi.fn() }));

const { selectJudges } = await import('./judges');
const { S } = await import('./state');
const { defaultPolicy, normalizePolicy } = await import('./policy');
const policy = (patch: Partial<Policy>): Policy => normalizePolicy({ ...defaultPolicy(), ...patch });

describe('selectJudges', () => {
  it('runs rules-only, and says why, when the own-key judge has no key', async () => {
    h.secrets = {};
    await selectJudges(policy({ judge: { ...defaultPolicy().judge, provider: 'byok' } }));
    expect(S.judge!.name).toBe('rules-only');
    expect(S.reviewJudge).toBeUndefined();
    expect(S.judgeProblem).toEqual(expect.any(String));
  });
  it('runs Jev with the review model on the key, and no review model when the band is refused outright', async () => {
    h.secrets = { keys: { openrouter: 'sk-or-test' } };
    await selectJudges(policy({ judge: { ...defaultPolicy().judge, provider: 'byok' }, reviewBand: 'llm' }));
    expect(S.judge!.name).toBe('jev');
    expect(S.reviewJudge?.name).toBe('llm');
    expect(S.judgeProblem).toBeUndefined();
    await selectJudges(policy({ judge: { ...defaultPolicy().judge, provider: 'byok' }, reviewBand: 'block' }));
    expect(S.judge!.name).toBe('jev');
    expect(S.reviewJudge).toBeUndefined();
  });
  it('runs Pro alone, with no local review judge and no fallback to a stored key', async () => {
    h.secrets = { keys: { openrouter: 'sk-or-test' } };
    await selectJudges(policy({ judge: { ...defaultPolicy().judge, provider: 'cloud' } }));
    expect(S.judge!.name).toBe('cloud');
    expect(S.reviewJudge).toBeUndefined();
    expect(S.judgeProblem).toBeUndefined();
  });
});
