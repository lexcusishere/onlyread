// The judge stage's decisions.
import { describe, expect, it } from 'vitest';
import { judgeStage, type Answer, type StageInput } from './stage';

const lines = { allow: 0.3, block: 0.75, reviewAllow: 0.3, reviewBlock: 0.75 };
const says = (pWrite: number, model = 'jev'): (() => Promise<Answer>) => async () => ({ pWrite, model, reason: `p=${pWrite}` });
const run = (over: Partial<StageInput>) => judgeStage({ primary: says(0.5), review: says(0.5, 'review'), lines, opaque: false, ...over });

describe('judgeStage', () => {
  it('takes Jev\'s clear answers as they are', async () => {
    expect(await run({ primary: says(0.04) })).toMatchObject({ outcome: 'allow', stage: 'primary', reason: 'p<allow', pWrite: 0.04, model: 'jev' });
    expect(await run({ primary: says(0.97) })).toMatchObject({ outcome: 'block', stage: 'primary', reason: 'p>block' });
  });
  it('sends a read on a body Jev could not read to the review model', async () => {
    expect(await run({ primary: says(0.04), review: says(0.05, 'review'), opaque: true }))
      .toMatchObject({ outcome: 'allow', stage: 'review', reason: 'review-band:opaque-body,llm-allow(p1=0.04)', pWrite: 0.05, model: 'review' });
    expect(await run({ primary: says(0.04), review: says(0.9, 'review'), opaque: true })).toMatchObject({ outcome: 'block', stage: 'review' });
  });
  it('sends a write Jev scored on a binary or compressed body to the review model, which decides it', async () => {
    expect(await run({ primary: says(0.86), review: says(0.1, 'review'), binary: true }))
      .toMatchObject({ outcome: 'allow', stage: 'review', reason: 'review-band:binary-body,llm-allow(p1=0.86)' });
    expect(await run({ primary: says(0.86), review: says(0.9, 'review'), binary: true })).toMatchObject({ outcome: 'block', stage: 'review' });
    // Without a review model, still refused.
    expect(await run({ primary: says(0.86), review: undefined, binary: true })).toMatchObject({ outcome: 'unsure', reason: 'review-band:binary-body,no-review' });
    // A readable body keeps Jev's write as it is.
    expect(await run({ primary: says(0.86), review: says(0.1, 'review') })).toMatchObject({ outcome: 'block', stage: 'primary', reason: 'p>block' });
  });
  it('lets the review model decide the band, and refuses what it is unsure of', async () => {
    expect(await run({ review: says(0.1, 'review') })).toMatchObject({ outcome: 'allow', reason: 'review-band:llm-allow(p1=0.50)' });
    expect(await run({ review: says(0.8, 'review') })).toMatchObject({ outcome: 'block', reason: 'review-band:llm-block(p1=0.50)' });
    expect(await run({ review: says(0.5, 'review') })).toMatchObject({ outcome: 'unsure', reason: 'review-band:llm-unsure(p1=0.50)' });
  });
  it('refuses the band when the review fails or there is no review model, keeping Jev\'s answer', async () => {
    const failing = async (): Promise<Answer> => { throw new Error('rate limited'); };
    expect(await run({ review: failing })).toMatchObject({ outcome: 'unsure', stage: 'primary', reason: 'review-band:llm-error:rate limited', model: 'jev' });
    expect(await run({ review: failing, failure: () => 'timeout' })).toMatchObject({ reason: 'review-band:llm-timeout' });
    expect(await run({ review: undefined })).toMatchObject({ outcome: 'unsure', reason: 'review-band:no-review' });
    expect(await run({ review: undefined, withoutReview: 'block', primary: says(0.1), opaque: true })).toMatchObject({ reason: 'review-band:opaque-body,block' });
  });
  it('throws when Jev fails, so the caller refuses the request', async () => {
    await expect(run({ primary: async () => { throw new Error('jev http 401'); } })).rejects.toThrow('jev http 401');
  });
});
