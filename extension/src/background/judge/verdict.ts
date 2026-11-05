// The review model's prompt and answer parsing. Same input contract as Jev: structured state only,
// never page content.

export { BINARY_BODY_NOTE, JUDGE_SYSTEM } from './questions';

/** Reads {"pWrite": n, "reason": "…"} out of a model's reply. A model that reasons aloud may wrap it
 *  in prose, fences or <think> blocks: the last object that carries pWrite is the verdict. When that one is not
 *  usable (not JSON, or a pWrite that is not a probability: null, "", "cannot tell"), the reply throws; an earlier
 *  object is never taken instead, since a model that writes an example or a first guess and then a verdict it cannot
 *  give must not be read as the example. A throw makes the caller refuse the request. */
export function parseVerdict(text: string, quoted?: string): { pWrite: number; reason?: string } {
  // A <think> block cut off by the token limit runs to the end of the reply: a draft in it is no verdict either.
  const visible = text.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '').replace(/```(?:json)?/gi, '');
  const last = [...visible.matchAll(/\{[^{}]*"pWrite"[^{}]*\}/g)].map((m) => m[0]).at(-1);
  // An object the model only quoted from the request (`quoted`: the body preview it was shown) is not its verdict:
  // the agent being guarded writes that body. When the last object is one, there is no verdict (an earlier object is
  // not taken instead, as above).
  const own = last !== undefined && !quoted?.includes(last) ? last : undefined;
  let parsed: { pWrite?: unknown; reason?: unknown } | undefined;
  try { parsed = own === undefined ? undefined : (JSON.parse(own) as typeof parsed); } catch { /* not JSON: no verdict */ }
  const p = probability(parsed?.pWrite);
  if (p === undefined) throw new Error(`judge returned no usable answer: ${visible.trim().slice(0, 120)}`);
  return { pWrite: p, reason: typeof parsed?.reason === 'string' ? parsed.reason : undefined };
}

/** A probability: a finite number in 0..1, or a string that is one written as a plain decimal ("0.3", " 1 "). Nothing
 *  is coerced: null, "", booleans, arrays and objects are not numbers (Number() reads null, "", false and [] as 0, a
 *  read), and neither are "1e-1", "0x1", "Infinity" or "true". */
function probability(v: unknown): number | undefined {
  const s = typeof v === 'string' ? v.trim() : undefined;
  const n = typeof v === 'number' ? v : s !== undefined && /^(?:\d+(?:\.\d+)?|\.\d+)$/.test(s) ? Number(s) : Number.NaN;
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : undefined;
}
