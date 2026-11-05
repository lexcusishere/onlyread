// The judge stage: Jev first, the review model for what Jev cannot settle, and the decision from both.
// OnlyRead Pro decides by this same stage, so a request gets the same decision whichever judges it. No imports, so
// the file stands alone.
//
// Jev's answer below `allow` is a read, above `block` a write. Everything between is the review band, and so is
// a read Jev scored on a body it could not read (`opaque`: binary, positional arrays, unknown content types),
// where a low score is not trusted, and so is a write Jev scored on a binary or compressed body (`binary`): it cannot
// see inside one, and pages send their analytics beacons that way right after a click. The review model then decides by its own lines; anything it is unsure of,
// any review failure, and a band with no review model are refused (`unsure`). A failure of Jev itself throws:
// the caller refuses the request.

export interface Answer { pWrite: number; model: string; reason?: string }

export interface Lines {
  /** Jev below this: a read. */
  allow: number;
  /** Jev above this: a write. */
  block: number;
  /** The review model below this: a read. */
  reviewAllow: number;
  /** The review model above this: a write. */
  reviewBlock: number;
}

export interface StageInput {
  primary: () => Promise<Answer>;
  /** The review model; absent when there is none (no key for it, or the band is refused outright). */
  review?: () => Promise<Answer>;
  lines: Lines;
  opaque: boolean;
  /** The body is binary or compressed (a gzip beacon): Jev's write is checked by the review model too. */
  binary?: boolean;
  /** Names a review failure: a timeout, or an error with its message. */
  failure?: (err: unknown) => string;
  /** The log's word for a band with no review model (`block`: refused by setting; default `no-review`). */
  withoutReview?: string;
}

export interface StageOutcome {
  outcome: 'allow' | 'block' | 'unsure';
  /** Which model's answer decided: Jev's, or the review model's. */
  stage: 'primary' | 'review';
  /** Why, in the decision log's words (`p<allow`, `review-band:opaque-body,llm-allow(p1=0.04)`, …). */
  reason: string;
  pWrite: number;
  model: string;
  /** The deciding model's own explanation, when it gave one. */
  judgeReason?: string;
}

const describe = (err: unknown): string => `error:${(err instanceof Error ? err.message : String(err)).slice(0, 160)}`;

/** Why a score outside the band still went to the review model, for the log: a binary body Jev called a write, or an
 *  unreadable one it called a read. */
function noteFor(input: StageInput, p: number): string {
  if (input.binary && p > input.lines.block) return 'binary-body,';
  return input.opaque && p < input.lines.allow ? 'opaque-body,' : '';
}

export async function judgeStage(input: StageInput): Promise<StageOutcome> {
  const { lines, opaque } = input;
  const first = await input.primary();
  const fromFirst = { stage: 'primary' as const, pWrite: first.pWrite, model: first.model, judgeReason: first.reason };
  if (first.pWrite < lines.allow && !opaque) return { outcome: 'allow', reason: 'p<allow', ...fromFirst };
  if (first.pWrite > lines.block && !input.binary) return { outcome: 'block', reason: 'p>block', ...fromFirst };

  const bandNote = noteFor(input, first.pWrite);
  if (!input.review) return { outcome: 'unsure', reason: `review-band:${bandNote}${input.withoutReview ?? 'no-review'}`, ...fromFirst };
  let second: Answer;
  try {
    second = await input.review();
  } catch (err) {
    return { outcome: 'unsure', reason: `review-band:${bandNote}llm-${(input.failure ?? describe)(err)}`, ...fromFirst };
  }
  const outcome = second.pWrite < lines.reviewAllow ? 'allow' : second.pWrite > lines.reviewBlock ? 'block' : 'unsure';
  return {
    outcome, stage: 'review', reason: `review-band:${bandNote}llm-${outcome}(p1=${first.pWrite.toFixed(2)})`,
    pWrite: second.pWrite, model: second.model, judgeReason: second.reason,
  };
}
