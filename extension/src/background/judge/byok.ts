// Builds the judges for the user's own-key (BYOK) choice: Jev first, and the review model for the
// uncertain band, both on the chosen gateway with its one key. With an Anthropic key as well, a Claude review model is
// asked of Anthropic first and of the gateway when Anthropic fails (judge/fallback.ts). No gateway key means no judge,
// and the caller runs rules-only: requests nothing can classify are refused.
import { ANTHROPIC, PROVIDERS, choiceProblem, keyFor, onAnthropic, reviewModel, reviewModelSpec, type ByokChoice, type Secrets } from '../../shared/providers';
import { FallbackJudge } from './fallback';
import { JevJudge } from './jev';
import { LlmJudge, llmModelFor } from './llm';
import type { Judge } from './types';

interface Budgets {
  /** Jev, inside a paused request. */
  jevMs: number;
  /** The review model. */
  reviewMs: number;
}

type ByokJudges =
  | { ok: true; primary: Judge; review: Judge }
  | { ok: false; problem: string };

export function buildByokJudges(choice: ByokChoice, secrets: Secrets | undefined | null, budgets: Budgets, fetchImpl?: typeof fetch): ByokJudges {
  const problem = choiceProblem(choice, secrets);
  const apiKey = keyFor(secrets, choice.id);
  if (problem || !apiKey) return { ok: false, problem: problem ?? 'no key' };
  const spec = PROVIDERS[choice.id];
  const model = reviewModel(choice);
  const gateway = new LlmJudge({ apiKey, baseUrl: spec.review.baseUrl, model, thinking: reviewModelSpec(model)?.thinking, budgetMs: budgets.reviewMs, fetchImpl });
  const direct = anthropicReview(choice, secrets, budgets, fetchImpl);
  return {
    ok: true,
    primary: new JevJudge({ apiKey, endpoint: spec.jev.endpoint, model: spec.jev.model, budgetMs: budgets.jevMs, fetchImpl }),
    review: direct ? new FallbackJudge(direct, gateway, budgets.reviewMs) : gateway,
  };
}

/** The review model straight from Anthropic, when there is an Anthropic key and the model is Claude. */
export function anthropicReview(choice: ByokChoice, secrets: Secrets | undefined | null, budgets: Budgets, fetchImpl?: typeof fetch): LlmJudge | undefined {
  const apiKey = keyFor(secrets, 'anthropic');
  const model = reviewModel(choice);
  if (!apiKey || !onAnthropic(model)) return undefined;
  return new LlmJudge({ apiKey, baseUrl: ANTHROPIC.baseUrl, model: llmModelFor(ANTHROPIC.baseUrl, model), thinking: reviewModelSpec(model)?.thinking, budgetMs: budgets.reviewMs, fetchImpl });
}
