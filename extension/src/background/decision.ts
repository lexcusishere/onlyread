import { gqlReadTrackingHolds, readTrackingRequest } from './read-tracking';
import { repeatKey, type Repeats } from './repeats';
import type { EffectivePolicy, Policy, RequestRecord, Source, Verdict } from '../shared/types';
import type { Judge } from './judge/types';
import { JudgeTimeout, withTimeout } from './judge/types';
import { judgeStage, type Lines, type StageOutcome } from './judge/stage';
import { hasUnknownPart } from './fingerprint';
import { TELEMETRY_PATH_END, urlFilterHit } from './rules';

export interface Decision {
  verdict: Verdict;
  /** What the interception layer does in enforce mode. */
  action: 'continue' | 'fail';
  source: Source;
  reason: string;
  pWrite?: number;
  latencyMs?: number;
  judgeModel?: string;
  judgeReason?: string;
}

export interface CacheLike {
  get(fp: string): Promise<{ verdict: 'allow' | 'block'; pWrite: number; source: Source } | undefined>;
  touch(fp: string): Promise<void>;
}

interface DecisionDeps {
  policy: Policy;
  judge: Judge;
  cache: CacheLike;
  /** Consulted only when the primary lands in the review band and policy.reviewBand = 'llm'. */
  reviewJudge?: Judge;
  /** Answers to exact repeats of a request (repeats.ts); without it every request is judged. */
  repeats?: Repeats;
}

/** CDP Network.ResourceType values that never carry a write on a GET. */
const STATIC_TYPES = new Set(['Stylesheet', 'Image', 'Media', 'Font', 'Script', 'TextTrack', 'Manifest']);
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const MUTATING_METHODS = new Set(['PUT', 'PATCH', 'DELETE']);

/** Whether OnlyRead guards this host: a guarded site's, or, when everything is guarded, any host but an allowed or
 *  exempt one (sites.ts resolveEffective). The one question every layer asks. */
export function guardsHost(eff: Pick<EffectivePolicy, 'targetDomains' | 'guardAll' | 'excludeDomains' | 'exemptDomains'>, host: string): boolean {
  if (!host) return false;
  if (isTargetHost(host, eff.targetDomains ?? [])) return true;
  return eff.guardAll === true && !isTargetHost(host, eff.excludeDomains ?? []) && !isTargetHost(host, eff.exemptDomains ?? []);
}

export function isTargetHost(host: string, targetDomains: string[]): boolean {
  const h = host.toLowerCase();
  return targetDomains.some((d) => {
    const t = d.toLowerCase();
    return h === t || h.endsWith('.' + t);
  });
}

const BEFORE = new Set(['/', '.', ':', '-', '_']);
const AFTER = new Set(['/', '.', '?', '#', ':', '-', '_', '=', '&']);

const RE_CACHE = new Map<string, RegExp | null>();
/** "re:<source>" patterns compile once; an invalid one never matches (an exclude-list must not open on a typo). */
function compiledRe(src: string): RegExp | null {
  if (!src) return null; // new RegExp('') matches everything
  let re = RE_CACHE.get(src);
  if (re === undefined) {
    try { re = new RegExp(src); } catch { re = null; }
    RE_CACHE.set(src, re);
  }
  return re;
}

/**
 * The telemetryAllow matcher: a substring match constrained to URL token boundaries. Case-insensitive.
 *
 * A pattern with a path in it ("/collect", "/svc/shreddit/events", "play.google.com/log") names an endpoint: it must end the
 * path, so "/logout" matches "/logout", "/logout?next=1", "/api/logout/" and "/x/logout.php" (a known file extension), but never
 * "/assets/LogoutHelper.js", "/logout-all", "/logout/everywhere" or "/api/logout.all". Without that, a global "/analytics" let
 * "/api/analytics/dashboards/42/delete" and "/collect-payment" through on every guarded host, unjudged. A pattern
 * that ends in "/" or "*" is a prefix instead. A pattern with no "/" (a vendor or host word: "sentry",
 * "google.internal.waa.v1.Waa") may sit anywhere on token boundaries.
 *
 * A pattern starting with "re:" is a JavaScript regex tested, case-sensitively, against the
 * haystack as given (for telemetryAllow that is host + path, no scheme or query). Anchor it to the
 * host: "re:^www\\.linkedin\\.com/[A-Za-z0-9_-]{10,20}$" fences LinkedIn's random-path beacons
 * without touching any other site. Case-sensitive so a pattern can demand mixed case, which
 * separates those beacons from real lowercase paths like "/notifications".
 */
export function matchesAny(haystack: string, needles: string[]): boolean {
  const h = haystack.toLowerCase();
  return needles.some((raw) => matchesPattern(haystack, h, String(raw ?? '').trim()));
}

/** One pattern of matchesAny: `re:` source, `prefix*`, or a plain substring on token boundaries. */
function matchesPattern(haystack: string, lowered: string, t: string): boolean {
  if (t.startsWith('re:')) {
    const re = compiledRe(t.slice(3));
    return re ? re.test(haystack) : false;
  }
  let n = t.toLowerCase();
  // A trailing '*' makes the pattern a prefix with no after-boundary: "/to11y*" matches
  // "/to11y4RusOFiHW6hy" (LinkedIn's obfuscated telemetry beacons share a stem and end in a
  // random suffix). The before-boundary still applies, so "/to11y*" never matches "/xto11y…".
  const prefix = n.endsWith('*');
  if (prefix) n = n.slice(0, -1);
  return n !== '' && occursOnBoundaries(lowered, n, prefix);
}

/** What may follow a path pattern (rules.ts TELEMETRY_PATH_END): nothing, a trailing slash, or a known file extension
 *  ("/TealeafTarget" for "/TealeafTarget.jsp"), then the end, a query or a fragment. */
const PATH_END = new RegExp('^' + TELEMETRY_PATH_END);

/** Whether `n` occurs in `h` with a token boundary before it, and after it unless it is a prefix. A pattern with a
 *  path in it must end the path (PATH_END), not merely a segment: "/analytics" is not "/analytics/dashboards/42/delete". */
function occursOnBoundaries(h: string, n: string, prefix: boolean): boolean {
  // A pattern that ends in '/' is an explicit prefix ("…/Waa/" matches "…/Waa/Create").
  const open = prefix || n.endsWith('/');
  const endpoint = !open && n.includes('/');
  for (let i = h.indexOf(n); i !== -1; i = h.indexOf(n, i + 1)) {
    const before = i === 0 ? '' : h[i - 1]!;
    const end = i + n.length;
    const after = end >= h.length ? '' : h[end]!;
    const beforeOk = before === '' || BEFORE.has(before) || n.startsWith('/');
    const afterOk = open || (endpoint ? PATH_END.test(h.slice(end)) : after === '' || AFTER.has(after));
    if (beforeOk && afterOk) return true;
  }
  return false;
}

/** Telemetry allowances match the request's host and path, never its query string, so a query value
 *  (`?next=/telemetry`) cannot turn a write into telemetry. A pattern with `?` means "this endpoint,
 *  with parameters": the part before `?` must end exactly at the path's end, and the part after it must
 *  appear in the query. `re:` patterns also see host and path only. `global` is the list that holds on every guarded
 *  host (its path patterns start the path, startsPath); `own` the lists of the sites that cover the host. */
function telemetryAllowed(host: string, path: string, query: string, global: string[], own: string[]): boolean {
  const hostPath = host + path;
  const matches = (raw: string, anchored: boolean): boolean => {
    const t = String(raw ?? '').trim();
    if (!t) return false;
    if (anchored && t.startsWith('/')) return startsPath(path, query, t);
    const q = t.startsWith('re:') ? -1 : t.indexOf('?');
    return q === -1 ? matchesAny(hostPath, [t]) : endpointWithQuery(hostPath, query, t.slice(0, q).toLowerCase(), t.slice(q + 1).toLowerCase());
  };
  return global.some((t) => matches(t, true)) || own.some((t) => matches(t, false));
}

/** A global path pattern (the list that holds on every guarded host) names an endpoint from the start of the path, as
 *  its beacon rule does (rules.ts beaconTelemetryRegex): matched further in, `/collect` would allow a site's own
 *  `/api/payments/collect`. Then the path ends as for any pattern (PATH_END), unless the pattern is a prefix (`/b/ss/`,
 *  `/x*`); `endpoint?wanted` is that endpoint as the whole path, with a query that contains `wanted`. A site's own list,
 *  backed by its labels, may still match deeper in its paths. */
function startsPath(path: string, query: string, t: string): boolean {
  const lowered = path.toLowerCase();
  const q = t.indexOf('?');
  if (q !== -1) return lowered === t.slice(0, q).toLowerCase() && query !== '' && query.toLowerCase().includes(t.slice(q + 1).toLowerCase());
  let n = t.toLowerCase();
  const prefix = n.endsWith('*');
  if (prefix) n = n.slice(0, -1);
  if (!n || !lowered.startsWith(n)) return false;
  return prefix || n.endsWith('/') || PATH_END.test(lowered.slice(n.length));
}

/** `endpoint?wanted`: the path ends exactly at `endpoint` (on a token boundary) and the query contains `wanted`. */
function endpointWithQuery(hostPath: string, query: string, endpoint: string, wanted: string): boolean {
  if (!endpoint || !query || !hostPath.toLowerCase().endsWith(endpoint)) return false;
  const before = hostPath.length === endpoint.length ? '' : hostPath[hostPath.length - endpoint.length - 1]!;
  if (!(before === '' || endpoint.startsWith('/') || BEFORE.has(before))) return false;
  return !wanted || query.toLowerCase().includes(wanted);
}

const allow = (source: Source, reason: string, extra: Partial<Decision> = {}): Decision => ({ verdict: 'allow', action: 'continue', source, reason, ...extra });
const block = (source: Source, reason: string, extra: Partial<Decision> = {}): Decision => ({ verdict: 'block', action: 'fail', source, reason, ...extra });
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** The allow-lists that apply to a request on `host`: the global ones, plus those of every enabled site whose domains
 *  cover the host (a site's allowances are backed by that site's labels and hold on its hosts alone, not pooled
 *  over every guarded host). */
function allowListsFor(eff: EffectivePolicy, host: string): Pick<EffectivePolicy, 'telemetryAllow' | 'allowedShapes' | 'readTrackingShapes'> & { readPutPaths: string[] } {
  const own = (eff.siteRules ?? []).filter((s) => isTargetHost(host, s.domains));
  return {
    telemetryAllow: own.flatMap((s) => s.telemetryAllow),
    allowedShapes: [...eff.allowedShapes, ...own.flatMap((s) => s.allowedShapes)],
    readTrackingShapes: [...eff.readTrackingShapes, ...own.flatMap((s) => s.readTrackingShapes)],
    readPutPaths: own.flatMap((s) => s.readPutPaths ?? []),
  };
}

/** The deterministic rules, in order. Undefined when none settles the request (the judge decides). */
function ruleDecision(rec: RequestRecord, policy: Policy): Decision | undefined {
  const method = rec.method.toUpperCase();
  const eff = policy.effective;
  const lists = allowListsFor(eff, rec.host);
  // A site's live-updates subscription sent as a PUT (SiteProfile.readPutPaths): its exact path on its own hosts only.
  if (method === 'PUT' && lists.readPutPaths.includes(rec.path)) return allow('rule', 'read-put');
  if (MUTATING_METHODS.has(method)) return block('rule', 'mutating-method');
  // Same rule as the DNR layer: a POST page load is a write. Kept here so monitor mode logs it.
  if (method === 'POST' && rec.resourceType === 'Document') return block('rule', 'post-navigation');
  // Telemetry first: some logging endpoints post multipart bodies (Facebook's /ajax/bnzai ships gzip event
  // blobs as form parts). The list is operator-curated per site, so a matching URL outranks the upload rule.
  const query = rec.url.includes('?') ? rec.url.slice(rec.url.indexOf('?') + 1).split('#')[0]! : '';
  if (telemetryAllowed(rec.host, rec.path, query, eff.telemetryAllow, lists.telemetryAllow)) return allow('rule', 'telemetry');
  if (rec.bodyShape === 'multipart' && !policy.uploads) return block('rule', 'upload');
  // Neither allow below holds when part of the operation is unknown (a repeated `?action=`): the shape names one
  // reading of the request, and the server may act on another.
  const known = !hasUnknownPart(rec.fingerprint);
  // Decoded writes: a per-app codec named the operation; no judge needed and no cache entry wanted.
  if (known && lists.allowedShapes.includes(rec.bodyShape)) return allow('rule', 'allowed-shape');
  if (known && policy.allowReadTracking && readTracking(rec, lists.readTrackingShapes)) return allow('rule', 'read-tracking');
  if (eff.blockedShapes.some((prefix) => rec.bodyShape.startsWith(prefix))) return block('rule', 'decoded-write');
  if (SAFE_METHODS.has(method)) return safeMethodDecision(rec, eff.blockedGetPaths);
  return undefined;
}

/** Read-tracking writes (view preferences, filters, UI flags, read receipts), allowed only when the operator opted in.
 *  Exact-match a curated per-site list, so an ambiguous or batched op never slips through; the few a shape cannot name
 *  exactly are recognised by their address or body (read-tracking.ts). A GraphQL shape is named by the body's
 *  operationName only, so its body must hold that operation alone (gqlReadTrackingHolds). */
function readTracking(rec: RequestRecord, shapes: string[]): boolean {
  const listed = shapes.includes(rec.bodyShape) && (!rec.bodyShape.startsWith('gql') || gqlReadTrackingHolds(rec));
  return listed || readTrackingRequest(rec) !== undefined;
}

/** blockedGetPaths uses the exact matcher the DNR rules compile to (urlFilter "<p>^"), so the CDP layer and
 *  the network layer agree on every pattern, including query fragments like "action=RESPOND". telemetryAllow
 *  keeps matchesAny: it is an exclude-list with no DNR counterpart, and its token-boundary rule stops a short
 *  pattern ("log") from over-allowing ("/api/blog"). */
function safeMethodDecision(rec: RequestRecord, blockedGetPaths: string[]): Decision {
  if (blockedGetPaths.some((p) => p && urlFilterHit(rec.url, p))) return block('rule', 'blocked-get-path');
  return allow('rule', rec.resourceType && STATIC_TYPES.has(rec.resourceType) ? 'static-asset' : 'safe-method');
}

/** Structure the judge cannot read: positional arrays, binary/unknown content types, absent bodies. */
function isOpaque(rec: RequestRecord, policy: Policy): boolean {
  const s = rec.bodyShape;
  return policy.opaqueToReview && (s === 'opaque' || s.startsWith('ct:') || /^json\[\]:[nadsob?+]*$/.test(s) || s === 'json[]');
}

/** A body of bytes the judge sees as text: compressed (gzip and zlib streams start with byte 1f, which no text body
 *  does) or binary (looksBinary). Jev's write is checked by the review model too (judge/stage.ts `binary`). */
export function binaryBody(preview: string | undefined): boolean {
  return (preview ?? '').charCodeAt(0) === 0x1f || looksBinary(preview);
}

/** A body of bytes, not text: more than a tenth of its start is control characters or replacement characters. An
 *  encrypted protocol's payload (Telegram's MTProto over HTTP) reads like this; no judge can tell a read from a write
 *  in it. */
function looksBinary(preview: string | undefined): boolean {
  const t = (preview ?? '').slice(0, 512);
  if (!t) return false;
  let bad = 0;
  for (const ch of t) {
    const c = ch.charCodeAt(0);
    if ((c < 32 && c !== 9 && c !== 10 && c !== 13) || c === 0xfffd) bad++;
  }
  return bad / t.length > 0.1;
}

/** The queryIds X's GraphQL operations with a shipped label allow were recorded with (apps/x). X runs the operation
 *  its queryId names, whatever name the address carries (read-tracking.ts xEducationFlag), and the fingerprint folds
 *  the queryId into {id}; so a label allow holds only for one of these, and a new one X ships is judged until added. */
const X_GRAPHQL_QUERY_IDS = new Map<string, readonly string[]>([
  ['HomeTimeline', ['V0wMxbYBxdrkfmV3kJSyRQ']],
  ['HomeLatestTimeline', ['5URyiXQyz6_8NZnoV37OVQ']],
  ['usePremiumPaywallOnLoadMutation', ['F6gikc1Bwzry7oHMrdrYzg']],
  ['GenerateXChatTokenMutation', ['Qh3fZRjPPtPoHYR_2sCZsA']],
]);

/** False for an X GraphQL request whose queryId is not one recorded for the operation its address names, or whose
 *  body carries another queryId; true for any other request. */
function xQueryIdRecorded(rec: RequestRecord): boolean {
  if (rec.host !== 'x.com' && !rec.host.endsWith('.x.com')) return true;
  const m = /^(?:\/i\/api)?\/graphql\/([^/]+)\/([^/]+)$/.exec(rec.path);
  if (!m) return true;
  if (!X_GRAPHQL_QUERY_IDS.get(m[2]!)?.includes(m[1]!)) return false;
  let body: unknown;
  try { body = JSON.parse(rec.bodyFull ?? rec.bodyPreview ?? 'null'); } catch { return false; }
  return !(body && typeof body === 'object' && 'queryId' in body) || (body as { queryId: unknown }).queryId === m[1];
}

/** Only label verdicts are reused (a verified site's labels from its recorded test sessions, or an operator's
 *  import). A judge's verdict is never reused: a later request with the same fingerprint may do something else
 *  (a selector the fingerprint cannot see), so the judge decides every request it is asked about. When part
 *  of the operation is unknown (an odd query value, a batch longer than we inspect), a label allow is not
 *  reused either; a label block still holds. */
async function cachedDecision(rec: RequestRecord, cache: CacheLike): Promise<Decision | undefined> {
  const cached = await cache.get(rec.fingerprint);
  if (cached?.source !== 'label') return undefined;
  if (cached.verdict === 'allow' && (hasUnknownPart(rec.fingerprint) || !xQueryIdRecorded(rec))) return undefined;
  // Bookkeeping only (hit counts): neither awaited nor allowed to fail the request: a
  // rejected storage write here must not fail every later request a label answered.
  Promise.resolve().then(() => cache.touch(rec.fingerprint)).catch(() => undefined);
  return (cached.verdict === 'allow' ? allow : block)('cache', `cached:${cached.source}`, { pWrite: cached.pWrite });
}

/** The primary judge within its budget (Pro runs both models server-side, so it gets its own, longer one). */
function budgetOf(judge: Judge, policy: Policy): number {
  return judge.budgetMs ?? (judge.name === 'cloud' ? policy.cloud.timeoutMs : policy.judge.timeoutMs);
}

const linesOf = (t: Policy['thresholds']): Lines => ({ allow: t.allow, block: t.block, reviewAllow: t.reviewAllow ?? t.allow, reviewBlock: t.reviewBlock ?? t.block });

/** The judge stage (judge/stage.ts) with the own-key judges here; Pro runs the same stage on its side. */
function runStage(rec: RequestRecord, deps: DecisionDeps, opaque: boolean): Promise<StageOutcome> {
  const { policy, judge, reviewJudge } = deps;
  // Read tracking allowed: the judges are asked the question that lets it through (judge/state.ts questionFor).
  const binary = binaryBody(rec.bodyPreview);
  const ask = { readTracking: Boolean(policy.allowReadTracking), binary };
  if (judge.decide) return withTimeout(judge.decide(rec, opaque, ask), budgetOf(judge, policy));
  return judgeStage({
    primary: () => withTimeout(judge.classify(rec, ask), budgetOf(judge, policy)),
    review: policy.reviewBand === 'llm' && reviewJudge ? () => withTimeout(reviewJudge.classify(rec, ask), reviewJudge.budgetMs ?? policy.judge.llmTimeoutMs) : undefined,
    lines: linesOf(policy.thresholds),
    opaque,
    binary,
    failure: (err) => (err instanceof JudgeTimeout ? 'timeout' : `error:${errorText(err).slice(0, 160)}`),
    withoutReview: policy.reviewBand === 'block' ? 'block' : `${policy.reviewBand}-unavailable`,
  });
}

/**
 * Rules → cache → judge. Deterministic parts first; the judge only ever sees the
 * gray zone. Any judge failure fails closed.
 */
export async function decide(rec: RequestRecord, deps: DecisionDeps): Promise<Decision> {
  const { policy, judge, cache } = deps;
  const byRule = ruleDecision(rec, policy);
  if (byRule) return byRule;
  const opaque = isOpaque(rec, policy);
  const cached = await cachedDecision(rec, cache);
  if (cached) return cached;
  // Binary a judge cannot read is refused without asking one: an app that retries such a request in a loop would
  // otherwise spend the whole judging allowance in a minute. A site's tested verdicts (above) still answer for it.
  if (rec.bodyShape === 'opaque' && looksBinary(rec.bodyPreview)) return block('rule', 'opaque-binary');
  if (!deps.repeats || judge.name === 'rules-only') return judged(rec, deps, opaque);
  return deps.repeats.answer(repeatKey(rec), () => judged(rec, deps, opaque));
}

/** The judges' answer for a request no rule or label settled. A decision from the review band (or one the band
 *  left unsure) is logged as `review`; Jev's own clear answer as allow or block. */
async function judged(rec: RequestRecord, deps: DecisionDeps, opaque: boolean): Promise<Decision> {
  const { judge, reviewJudge } = deps;
  const t0 = Date.now();
  let o: StageOutcome;
  try {
    o = await runStage(rec, deps, opaque);
  } catch (err) {
    // Cut like runStage's `failure`: a gateway's message is third-party text headed for the audit log.
    return block('rule', err instanceof JudgeTimeout ? 'judge-timeout' : `judge-error:${errorText(err).slice(0, 160)}`, { latencyMs: Date.now() - t0 });
  }
  const source = judge.name !== 'cloud' && o.stage === 'review' && reviewJudge ? reviewJudge.name : judge.name;
  const verdict: Verdict = o.stage === 'primary' && o.outcome !== 'unsure' ? o.outcome : 'review';
  return {
    verdict, action: o.outcome === 'allow' ? 'continue' : 'fail', source, reason: o.reason,
    pWrite: o.pWrite, latencyMs: Date.now() - t0, judgeModel: o.model, judgeReason: o.judgeReason,
  };
}
