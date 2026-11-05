// A judge's answer reused for an exact repeat of the same request: same method and full URL, same fingerprint,
// a byte-identical body and the same triggering actions, within two minutes. A different body, address or click
// is judged afresh, so a judge's verdict is never reused for a different request (ARCHITECTURE.md, the verdict
// cache). Concurrent repeats share the one pending answer. In memory only. Answers that came from a failure
// (a timeout, an error) are not kept: the next repeat asks again.
import type { RequestRecord } from '../shared/types';
import type { Decision } from './decision';

export const REPEAT_MS = 2 * 60_000;
const MAX = 500;

/** FNV-1a over the body, twice with different seeds: a cheap 64-bit identity for "byte-identical". */
export function bodyHash(body: string): string {
  let a = 0x811c9dc5, b = 0x01000193 ^ body.length;
  for (let i = 0; i < body.length; i++) {
    const c = body.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x5bd1e995) >>> 0;
  }
  return `${a.toString(16)}${b.toString(16)}:${body.length}`;
}

/** The identity of this exact request, or undefined when its body could not be read (nothing to compare). */
export function repeatKey(rec: RequestRecord): string | undefined {
  if (rec.hasBody && rec.bodyHash === undefined) return undefined;
  const trigger = rec.lastUiActions.map((a) => [a.type, a.tag, a.name ?? ''].join('|')).join(';');
  return [rec.method, rec.url, rec.fingerprint, rec.bodyHash ?? '-', trigger].join('\n');
}

/** A decision that came from a failure, not an answer, so a repeat asks again. Exactly the forms the decision code
 *  produces: Jev's own timeout or error (decision.ts `judged`), and the review model's inside the band
 *  (judge/stage.ts). Anchored, so a reason that merely mentions an error elsewhere is kept. */
const failed = (d: Pick<Decision, 'reason'>): boolean => /^(judge-(timeout|error:)|review-band:(opaque-body,)?llm-(timeout|error:))/.test(d.reason);

export class Repeats {
  private seen = new Map<string, { answer: Promise<Decision>; until: number }>();
  constructor(private readonly ttlMs = REPEAT_MS) {}

  /** The earlier answer to this exact request, marked as a repeat, or a new one from `ask`. */
  async answer(key: string | undefined, ask: () => Promise<Decision>, now = Date.now()): Promise<Decision> {
    if (key === undefined) return ask();
    const hit = this.seen.get(key);
    if (hit && hit.until > now) {
      const d = await hit.answer;
      return { ...d, reason: `repeat:${d.reason}`, latencyMs: 0 };
    }
    const answer = ask();
    this.prune(now);
    this.seen.set(key, { answer, until: now + this.ttlMs });
    const d = await answer.catch((err: unknown) => { this.seen.delete(key); throw err; });
    if (failed(d)) this.seen.delete(key);
    return d;
  }

  clear(): void { this.seen.clear(); }

  private prune(now: number): void {
    for (const [k, v] of this.seen) if (v.until <= now) this.seen.delete(k);
    while (this.seen.size >= MAX) this.seen.delete(this.seen.keys().next().value!);
  }
}
