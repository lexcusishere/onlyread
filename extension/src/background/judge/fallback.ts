// The review model asked of Anthropic first and of the gateway when Anthropic fails (judge/byok.ts). Both run inside
// the one review budget the decision gives the judge (decision.ts withTimeout).
import Anthropic from '@anthropic-ai/sdk';
import type { RequestRecord } from '../../shared/types';
import type { Judge, JudgeAsk, JudgeResult } from './types';

export class FallbackJudge implements Judge {
  readonly name = 'llm' as const;
  constructor(readonly first: Judge, readonly then: Judge, readonly budgetMs?: number) {}

  /** The gateway is asked only when Anthropic answers with an error or cannot be reached. An answer that is no verdict
   *  is the model's, not the provider's, and is not asked again. */
  async classify(rec: RequestRecord, ask?: JudgeAsk): Promise<JudgeResult> {
    try {
      return await this.first.classify(rec, ask);
    } catch (err) {
      if (!providerFailed(err)) throw err;
      console.warn(`[onlyread] Anthropic failed (${String((err as Error).message).slice(0, 160)}); asking the gateway`);
      return this.then.classify(rec, ask);
    }
  }
}

/** An error from the provider or the way to it: any status, or no connection. Not a timeout, nor an abort. */
function providerFailed(err: unknown): boolean {
  return err instanceof Anthropic.APIError && !(err instanceof Anthropic.APIConnectionTimeoutError) && !(err instanceof Anthropic.APIUserAbortError);
}
