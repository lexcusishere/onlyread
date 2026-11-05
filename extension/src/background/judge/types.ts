import type { RequestRecord } from '../../shared/types';
import type { StageOutcome } from './stage';

export interface JudgeResult {
  /** Probability that the request changes server state. */
  pWrite: number;
  latencyMs: number;
  model: string;
  reason?: string;
}

/** What a judge is asked besides the request: read tracking allowed (policy.allowReadTracking) changes Jev's question
 *  (judge/state.ts questionFor); the review model's stays as it is. */
export interface JudgeAsk {
  readTracking?: boolean;
  /** The body is binary or compressed (decision.ts binaryBody): the review model is told how beacons look. */
  binary?: boolean;
}

export interface Judge {
  readonly name: 'rules-only' | 'jev' | 'llm' | 'cloud';
  /** Time allowed for one answer; the decision falls back to the policy's budget when unset. */
  readonly budgetMs?: number;
  classify(record: RequestRecord, ask?: JudgeAsk): Promise<JudgeResult>;
  /** A judge that runs the whole judge stage itself (OnlyRead Pro) and returns its decision. */
  decide?(record: RequestRecord, opaque: boolean, ask?: JudgeAsk): Promise<StageOutcome>;
}

export class JudgeTimeout extends Error {
  constructor(ms: number) { super(`judge timed out after ${ms}ms`); this.name = 'JudgeTimeout'; }
}

export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new JudgeTimeout(ms)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}
