import type { Judge, JudgeResult } from './types';

/** Baseline judge: knows nothing, so everything in the gray zone lands in the review band. */
export class RulesOnlyJudge implements Judge {
  readonly name = 'rules-only' as const;
  async classify(): Promise<JudgeResult> {
    return { pWrite: 0.5, latencyMs: 0, model: 'rules-only' };
  }
}
