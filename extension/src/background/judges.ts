// Picks the judges from the policy and the stored keys.
import type { Policy, RequestRecord } from '../shared/types';
import type { ByokChoice, Secrets } from '../shared/providers';
import { RulesOnlyJudge } from './judge/rules-only';
import { anthropicReview, buildByokJudges } from './judge/byok';
import { withTimeout } from './judge/types';
import { CloudJudge } from './judge/cloud';
import { cloudClient, onCloudResult } from './cloud-session';
import { S, getSecrets } from './state';
import { CONSENT_PROBLEM, readConsent } from './consent';

/** An incomplete own-key setup means rules-only, loudly. */
export async function selectJudges(p: Policy): Promise<void> {
  S.judgeConsent = await readConsent();
  // Nothing goes to any judge until the person agreed to what it is sent (consent.ts).
  if (!S.judgeConsent) {
    S.judge = new RulesOnlyJudge();
    S.reviewJudge = undefined;
    S.judgeProblem = CONSENT_PROBLEM;
    return;
  }
  if (p.judge.provider === 'cloud') {
    // The server runs both models and returns one answer; no local review judge. No fallback to a
    // stored key: the user chose where request data goes.
    S.judge = new CloudJudge(cloudClient(p), onCloudResult);
    S.reviewJudge = undefined;
    S.judgeProblem = undefined;
    return;
  }
  const built = buildByokJudges(p.judge.byok, await getSecrets(), { jevMs: p.judge.timeoutMs, reviewMs: p.judge.llmTimeoutMs });
  if (!built.ok) {
    S.judge = new RulesOnlyJudge();
    S.reviewJudge = undefined;
    S.judgeProblem = built.problem;
    console.warn(`[onlyread] own-key judge not ready (${built.problem}); running rules-only`);
    return;
  }
  S.judge = built.primary;
  S.reviewJudge = p.reviewBand === 'llm' ? built.review : undefined;
  S.judgeProblem = undefined;
}

/** The canned gray-zone request a judge is tested with (the settings page's and setup window's Save and test). */
export function testRecord(): RequestRecord {
  return {
    ts: Date.now(), tabId: -1, requestId: 'test', method: 'POST', url: 'https://app.example.com/api/search?page=1',
    host: 'app.example.com', path: '/api/search', queryKeys: ['page'], contentType: 'application/json', resourceType: 'Fetch',
    hasBody: true, bodyPreview: '{"q":"quarterly report"}', bodyShape: 'json:q', fingerprint: 'POST app.example.com/api/search json:q',
    lastUiActions: [{ ts: Date.now(), type: 'click', tag: 'button', name: 'Search', url: 'https://app.example.com/' }],
  };
}

export interface AnthropicTestResult { ok: boolean; model?: string; latencyMs: number; error?: string }

/** The review model straight from Anthropic, when the own-key setup has an Anthropic key: a key that fails would only
 *  show as the gateway answering instead. */
export async function testAnthropic(choice: ByokChoice, secrets: Secrets, p: Policy, rec: RequestRecord): Promise<AnthropicTestResult | undefined> {
  const direct = anthropicReview(choice, secrets, { jevMs: p.judge.timeoutMs, reviewMs: p.judge.llmTimeoutMs });
  if (!direct) return undefined;
  const t0 = Date.now();
  try {
    const r = await withTimeout(direct.classify(rec), p.judge.llmTimeoutMs);
    return { ok: true, model: r.model, latencyMs: Date.now() - t0 };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), latencyMs: Date.now() - t0 };
  }
}

export type TryResult =
  | { ok: true; judge: string; model?: string; pWrite?: number; latencyMs: number; anthropic?: AnthropicTestResult }
  | { ok: false; problem: string }
  | { ok: false; judge: string; error: string; latencyMs: number; anthropic?: AnthropicTestResult };

/** An own-key judge as it would be with this provider and these keys, built and asked the test request, apart from the
 *  judge in force, which nothing here changes: a provider or key goes into force only once it has passed (messages.ts
 *  chooseByok). `problem`: it could not be built (no key); `error`: it was built and the test failed. */
export async function tryByokJudge(choice: ByokChoice, secrets: Secrets, p: Policy): Promise<TryResult> {
  const built = buildByokJudges(choice, secrets, { jevMs: p.judge.timeoutMs, reviewMs: p.judge.llmTimeoutMs });
  if (!built.ok) return { ok: false, problem: built.problem };
  const rec = testRecord();
  const t0 = Date.now();
  const anthropic = testAnthropic(choice, secrets, p, rec); // at once, beside the judge
  try {
    const r = await built.primary.classify(rec);
    return { ok: true, judge: built.primary.name, model: r.model, pWrite: r.pWrite, latencyMs: Date.now() - t0, anthropic: await anthropic };
  } catch (err) {
    return { ok: false, judge: built.primary.name, error: err instanceof Error ? err.message : String(err), latencyMs: Date.now() - t0, anthropic: await anthropic };
  }
}
