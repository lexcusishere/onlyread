// Layer 1: chrome.debugger + Fetch domain. Pauses every request in attached
// tabs (and their workers/iframes via auto-attach), hands a RequestRecord to
// the decision handler, then continues or fails the request.
import type { RequestRecord, UiAction } from '../shared/types';
import { fingerprint, previewBody } from './fingerprint';
import * as typedSecrets from './typed-secrets';
import { bodyHash } from './repeats';

export type Disposition = 'continue' | 'fail' | 'reject';
type PausedHandler = (rec: RequestRecord) => Promise<Disposition>;
type DetachHandler = (tabId: number, reason: string) => void;
/** What a paused request gets when building its record or deciding it threw (see interception.ts). */
type DecisionErrorHandler = (tabId: number, p: PausedParams, err: unknown) => Disposition;

interface RejectResponse { status: number; headers: { name: string; value: string }[]; body: string; }

/**
 * A synthetic refusal that makes a local-first client roll back its optimistic change instead of
 * queuing it offline. GraphQL clients treat an `errors` array as a rejection (HTTP 200); other
 * requests get a 403. Cross-origin API calls (e.g. linear.app -> client-api.linear.app) are
 * credentialed, so the response must echo CORS headers or the browser discards it and the app sees a
 * network error again, defeating the purpose.
 */
export function buildRejectResponse(graphql: boolean, origin: string | undefined): RejectResponse {
  const headers = [{ name: 'content-type', value: 'application/json; charset=utf-8' }];
  if (origin) {
    headers.push({ name: 'access-control-allow-origin', value: origin });
    headers.push({ name: 'access-control-allow-credentials', value: 'true' });
  }
  const body = graphql
    ? JSON.stringify({ errors: [{ message: 'onlyread: read-only mode - this change was not saved', extensions: { code: 'FORBIDDEN', onlyread: true } }] })
    : JSON.stringify({ error: 'onlyread: read-only mode', onlyread: true });
  return { status: graphql ? 200 : 403, headers, body };
}

function toBase64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

interface TabState { sessions: Set<string> }

/** A child session the debugger holds through a tab's auto-attach: an iframe, a dedicated worker, or a
 *  service or shared worker. Workers that have their own network stack (service, shared) are `intercepting`
 *  once Fetch is enabled on them: their requests, which carry no tab, are then paused and judged here. */
interface ChildSession { tabId: number; targetId: string; type: string; host: string; intercepting: boolean }

const tabs = new Map<number, TabState>();
const children = new Map<string, ChildSession>(); // by sessionId
let onWorkersChanged: () => void = () => {};
const OWN_NETWORK_WORKERS = new Set(['service_worker', 'shared_worker']);

async function targetsNow(): Promise<chrome.debugger.TargetInfo[]> {
  try { return await chrome.debugger.getTargets(); } catch { return []; }
}

const hostOfUrl = (url: string): string => { try { return new URL(url).hostname; } catch { return ''; } };

/** Hosts with a service or shared worker whose requests the debugger intercepts now. */
export function interceptedWorkerHosts(): string[] {
  return [...new Set([...children.values()].filter((c) => c.intercepting).map((c) => c.host).filter(Boolean))];
}

/** Child sessions whose worker has reported a running context (after Runtime.enable), and the calls waiting for one. */
const withContext = new Set<string>();
const contextWaiters = new Map<string, (ready: boolean) => void>();

/** Resolves true once the child session's worker has a context to run code in; false when the session goes first
 *  (a worker of a document being torn down never gets one) or after `ms`. A command sent to a worker with no context
 *  waits, and one left waiting while the document is torn down takes the tab's renderer down with it. */
export function contextReady(sessionId: string, ms = 10_000): Promise<boolean> {
  if (withContext.has(sessionId)) return Promise.resolve(true);
  if (!children.has(sessionId)) return Promise.resolve(false);
  return new Promise((resolve) => {
    const t = setTimeout(() => settle(false), ms);
    const settle = (ready: boolean) => { clearTimeout(t); contextWaiters.delete(sessionId); resolve(ready); };
    contextWaiters.get(sessionId)?.(false);
    contextWaiters.set(sessionId, settle);
  });
}

/** Every target id the debugger holds a child session for. */
export function heldTargetIds(): Set<string> {
  return new Set([...children.values()].map((c) => c.targetId));
}

function dropChildren(tabId: number): void {
  let changed = false;
  for (const [id, c] of children) if (c.tabId === tabId) { children.delete(id); changed ||= c.intercepting; }
  if (changed) onWorkersChanged();
}
const attaching = new Set<number>();
let inFlight = 0;
const inFlightByTab = new Map<number, number>();
let onForeignDebugger: (tabId: number) => void = () => {};
let handler: PausedHandler = async () => 'continue';
let onDetachCb: DetachHandler = () => {};
let onAttachCb: (tabId: number, url: string) => void = () => {};
let shouldAttach: (url: string) => boolean = () => false;
let shouldJudge: (url: string) => boolean = () => true;
let onDecisionError: DecisionErrorHandler = () => 'fail';
let recentActions: (tabId: number) => UiAction[] = () => [];
let onHeld: (tabId: number, url: string) => Promise<void> = async () => {};
let prepareWorker: (tabId: number, sessionId: string, url: string) => Promise<void> = async () => {};
let workerStarting: (tabId: number, sessionId: string, url: string) => Promise<void> = async () => {};
let workerScriptPrefix: (url: string) => Promise<string | undefined> = async () => undefined;
let onWorkerGone: (tabId: number, sessionId: string) => void = () => {};
let onReleased: (tabId: number) => void = () => {};
let onBinding: (tabId: number, name: string, payload: string, sessionId?: string) => void = () => {};

// Requests are judged before they leave; responses of type Other (a dedicated worker's script among them) are paused
// too, so a socket-guarded site's worker script can carry its guard from its first line (onResponse).
const FETCH_PATTERNS = { patterns: [{ urlPattern: '*', requestStage: 'Request' }, { urlPattern: '*', resourceType: 'Other', requestStage: 'Response' }] };

export type PausedParams = {
  requestId: string;
  request: { url: string; method: string; headers: Record<string, string>; postData?: string; hasPostData?: boolean };
  frameId: string;
  resourceType: string;
  networkId?: string;
  /** Set when paused at the response stage. */
  responseStatusCode?: number;
  responseErrorReason?: string;
  responseHeaders?: { name: string; value: string }[];
};

function headerLookup(headers: Record<string, string>, name: string): string | undefined {
  const k = Object.keys(headers).find((h) => h.toLowerCase() === name);
  return k ? headers[k] : undefined;
}

async function send(target: chrome.debugger.DebuggerSession, method: string, params?: Record<string, unknown>): Promise<object | undefined> {
  return chrome.debugger.sendCommand(target, method, params);
}

/** CDP omits `request.postData` on the paused event when the body is large (roughly > 64 KB) or
 *  otherwise not inlined, leaving only `hasPostData: true`. Without the body a codec cannot decode
 *  the operation and the request would look opaque. True here means: ask for the body explicitly. */
export function needsPostDataFetch(hasPostData: boolean | undefined, inlineData: string | undefined): boolean {
  return Boolean(hasPostData) && inlineData === undefined;
}

/** A Network.getRequestPostData result as a decodable string, or undefined when it is binary
 *  (base64) or absent. Undefined keeps the body opaque, which floors the request to the review
 *  band — never a silent allow. */
export function usableBody(fetched: { postData?: string; base64Encoded?: boolean } | undefined): string | undefined {
  if (!fetched || fetched.postData === undefined || fetched.base64Encoded) return undefined;
  return fetched.postData;
}

/** The request body for the decision. The Fetch domain has no body command: the body is read through
 *  the Network domain, by the paused request's Network id, within a bounded wait. Without that id, or
 *  when the read fails or times out, the body stays opaque (a conservative decision, never an allow on
 *  a guessed body). */
export async function resolvePostData(tabId: number, target: chrome.debugger.DebuggerSession, p: PausedParams, ms = 2000): Promise<string | undefined> {
  if (!needsPostDataFetch(p.request.hasPostData, p.request.postData)) return p.request.postData;
  if (!p.networkId) { logCb?.(tabId, 'post-data-unavailable:no-network-id'); return undefined; }
  try {
    const r = (await sendWithin(tabId, target, 'Network.getRequestPostData', { requestId: p.networkId }, ms)) as { postData?: string; base64Encoded?: boolean } | undefined;
    return usableBody(r);
  } catch {
    // Body genuinely unavailable (already consumed, streamed, too large to return): stay opaque.
    logCb?.(tabId, 'post-data-unavailable');
    return undefined;
  }
}

/** A setup command that must not hang the caller: when another debugger (an agent) holds the tab, a
 *  command can wait indefinitely. Past the limit it rejects, and the caller treats the tab as not held. */
function sendWithin(tabId: number, target: chrome.debugger.DebuggerSession, method: string, params: Record<string, unknown> | undefined, ms = 5000): Promise<object | undefined> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { logCb?.(tabId, `cdp-timeout:${method}`); reject(new Error(`${method} timed out`)); }, ms);
    send(target, method, params).then((v) => { clearTimeout(t); resolve(v); }, (e: unknown) => { clearTimeout(t); reject(e); });
  });
}

async function enableOnSession(tabId: number, sessionId?: string): Promise<void> {
  const target = sessionId ? { tabId, sessionId } : { tabId };
  await sendWithin(tabId, target, 'Fetch.enable', FETCH_PATTERNS);
  // Network events are evidence only: websocket / WebTransport creation and gateway requests, which Fetch never pauses.
  // Optional, and a background tab Chrome has paused can hold it indefinitely: a short limit.
  try { await sendWithin(tabId, target, 'Network.enable', {}, 2000); } catch { /* not on every target type */ }
  // Workers and OOPIFs get their own sessions; enable Fetch there too before they run.
  await sendWithin(tabId, target, 'Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
}

/** A failed attach: report it (unless the page simply refuses debuggers) and never leave a half-configured
 *  session behind (attach() succeeded but Fetch.enable/setAutoAttach did not). */
async function abandonAttach(tabId: number, err: unknown): Promise<void> {
  const msg = err instanceof Error ? err.message : String(err);
  // chrome://, extension pages, and the Web Store refuse attachment. Not an error.
  if (!/Cannot access|not allowed/i.test(msg)) console.warn(`[onlyread] attach tab ${tabId} failed:`, msg);
  if (!tabs.has(tabId)) return;
  tabs.delete(tabId);
  dropChildren(tabId);
  onReleased(tabId);
  try { await chrome.debugger.detach({ tabId }); } catch { /* ignore */ }
}

export async function attach(tabId: number, url?: string): Promise<boolean> {
  if (tabs.has(tabId) || attaching.has(tabId)) return tabs.has(tabId);
  if (url !== undefined && !shouldAttach(url)) return false;
  attaching.add(tabId);
  try {
    // Another debugger already on the tab is an agent (agent-detect.ts): once OnlyRead attaches too, the
    // targets list can no longer tell, so say so now.
    if ((await targetsNow()).some((t) => t.tabId === tabId && t.attached)) onForeignDebugger(tabId);
    await chrome.debugger.attach({ tabId }, '1.3');
    if (!quiet(tabId)) onAttachCb(tabId, url ?? '');
    tabs.set(tabId, { sessions: new Set() });
    await enableOnSession(tabId);
    await onHeld(tabId, url ?? (await chrome.tabs.get(tabId).catch(() => undefined))?.url ?? '');
    return true;
  } catch (err) {
    await abandonAttach(tabId, err);
    return false;
  } finally {
    attaching.delete(tabId);
  }
}

export async function detach(tabId: number): Promise<void> {
  tabs.delete(tabId);
  dropChildren(tabId);
  onReleased(tabId);
  try { await chrome.debugger.detach({ tabId }); } catch { /* already gone */ }
}

/** Detach every attached tab. Used when an agent session ends (attachWhen='agent-session'):
 *  the debugger banner clears and normal browsing is no longer intercepted. */
export async function detachAll(): Promise<void> {
  await Promise.all([...tabs.keys()].map((tabId) => detach(tabId)));
}

/**
 * Whether the debugger should be attached now. Off (enabled=false) is never attached. Otherwise it
 * is attached always, or only while an agent session is active when attachWhen='agent-session'.
 */
export function attachmentActive(attachWhen: 'always' | 'agent-session', agentSession: boolean, enabled = true): boolean {
  if (!enabled) return false;
  return attachWhen !== 'agent-session' || agentSession;
}

/** A worker serving several guarded tabs is held once per tab, so its request pauses in each session in turn:
 *  once let through, the next pauses of the same request continue at once, without a second decision. */
const continued = new Map<string, number>(); // network request id → until
const CONTINUED_MS = 30_000;
function alreadyContinued(networkId: string | undefined, now = Date.now()): boolean {
  if (!networkId) return false;
  const until = continued.get(networkId);
  if (until !== undefined && until > now) return true;
  continued.delete(networkId);
  return false;
}
function rememberContinued(networkId: string | undefined, now = Date.now()): void {
  if (!networkId) return;
  if (continued.size > 500) for (const [k, until] of continued) if (until <= now) continued.delete(k);
  continued.set(networkId, now + CONTINUED_MS);
}

/** The paused request as the decision sees it: fingerprint, redacted preview, and the agent's last actions. */
async function recordOf(source: chrome.debugger.DebuggerSession, target: chrome.debugger.DebuggerSession, tabId: number, p: PausedParams): Promise<RequestRecord> {
  const contentType = headerLookup(p.request.headers, 'content-type');
  const hasBody = Boolean(p.request.hasPostData || p.request.postData !== undefined);
  // Large bodies arrive as hasPostData with no inline data; fetch them so codecs see the full payload.
  const body = await resolvePostData(tabId, target, p);
  const fp = fingerprint(p.request.method, p.request.url, contentType, body, hasBody);
  const { preview, truncated } = previewBody(contentType, body, typedSecrets.known());
  return {
    ts: Date.now(), tabId, requestId: p.requestId, sessionId: source.sessionId,
    method: p.request.method, url: p.request.url, host: fp.host, path: fp.path, queryKeys: fp.queryKeys,
    contentType, resourceType: p.resourceType, initiator: headerLookup(p.request.headers, 'origin') ?? headerLookup(p.request.headers, 'referer'),
    hasBody, bodyPreview: preview, bodyTruncated: truncated, bodyShape: fp.shape, fingerprint: fp.fingerprint,
    bodyFull: truncated && body ? body.slice(0, 65536) : undefined,
    bodyHash: body === undefined ? undefined : bodyHash(body),
    lastUiActions: recentActions(tabId),
  };
}

/** Carry out the decision on the paused request. A refusal a client would queue offline is answered instead. */
async function answer(target: chrome.debugger.DebuggerSession, p: PausedParams, disp: Disposition, graphql: boolean): Promise<void> {
  if (disp === 'reject') {
    // Answer with a rollback-triggering refusal instead of dropping the request (see buildRejectResponse).
    const r = buildRejectResponse(graphql, headerLookup(p.request.headers, 'origin'));
    await send(target, 'Fetch.fulfillRequest', { requestId: p.requestId, responseCode: r.status, responseHeaders: r.headers, body: toBase64(r.body) });
  } else if (disp === 'fail') {
    await send(target, 'Fetch.failRequest', { requestId: p.requestId, errorReason: 'BlockedByClient' });
  } else {
    await send(target, 'Fetch.continueRequest', { requestId: p.requestId });
  }
}

function countInFlight(tabId: number, delta: 1 | -1): void {
  inFlight += delta;
  const left = (inFlightByTab.get(tabId) ?? 0) + delta;
  if (left > 0) inFlightByTab.set(tabId, left); else inFlightByTab.delete(tabId);
}

/** A response paused before the page reads it (an `Other` resource): a dedicated worker's script on a socket-guarded
 *  site gets the site's guard put before its first line (socket-guard.ts workerScriptPrefix), so the guard is in the
 *  worker without any command sent into it. Only on the page's own session, whose responses go to the page and the
 *  browser's HTTP cache (which keeps no `no-store` response): a service worker may store what it fetches with the Cache
 *  API, which ignores `no-store`, and a stored guard would outlive its configuration and OnlyRead itself (Telegram's
 *  keeps every script it fetches). Every other response goes on untouched; the guard then reaches the worker the other
 *  way (socket-guard.ts onWorker). */
async function onResponse(target: chrome.debugger.DebuggerSession, p: PausedParams): Promise<void> {
  const headers = p.responseHeaders ?? [];
  const header = (n: string) => headers.find((h) => h.name.toLowerCase() === n)?.value ?? '';
  const script = !target.sessionId && p.responseStatusCode === 200 && /javascript/i.test(header('content-type')) && !headerLookup(p.request.headers, 'service-worker');
  const prefix = script ? await workerScriptPrefix(p.request.url).catch(() => undefined) : undefined;
  try {
    if (!prefix) { await send(target, 'Fetch.continueRequest', { requestId: p.requestId }); return; }
    const r = (await send(target, 'Fetch.getResponseBody', { requestId: p.requestId })) as { body: string; base64Encoded: boolean };
    const original = r.base64Encoded ? new TextDecoder().decode(Uint8Array.from(atob(r.body), (c) => c.charCodeAt(0))) : r.body;
    // The body handed back is decoded and new: its old length, encoding and caching no longer apply. Never stored: the
    // guard carries the configuration of the moment, and must not outlive it in a cache.
    const kept = headers.filter((h) => !/^(content-length|content-encoding|transfer-encoding|cache-control|etag|last-modified|expires)$/i.test(h.name));
    kept.push({ name: 'Cache-Control', value: 'no-store' });
    await send(target, 'Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 200, responseHeaders: kept, body: toBase64(`${prefix}\n${original}`) });
  } catch {
    // Unchanged, the worker starts without the guard: it then does not report in, and gets it the other way.
    try { await send(target, 'Fetch.continueRequest', { requestId: p.requestId }); } catch { /* session gone */ }
  }
}

/** A paused response (onResponse) is not a request to judge. True when handled. */
async function pausedAside(target: chrome.debugger.DebuggerSession, p: PausedParams): Promise<boolean> {
  if (p.responseStatusCode === undefined && p.responseErrorReason === undefined) return false;
  await onResponse(target, p);
  return true;
}

async function handlePaused(source: chrome.debugger.DebuggerSession, p: PausedParams): Promise<void> {
  const tabId = source.tabId ?? -1;
  const target: chrome.debugger.DebuggerSession = source.sessionId ? { tabId, sessionId: source.sessionId } : { tabId };
  if (await pausedAside(target, p)) return;
  const worker = source.sessionId ? children.get(source.sessionId) : undefined;
  // A request nobody will judge (a host outside the guarded sites: with attachScope all-tabs every tab is held)
  // continues before its body is read, fingerprinted or redacted, and uncounted: foreignDebuggerOn
  // waits for the counted ones only, since a request that is not judged may as well go out on a detach.
  if ((worker?.intercepting && alreadyContinued(p.networkId)) || !shouldJudge(p.request.url)) {
    try { await send(target, 'Fetch.continueRequest', { requestId: p.requestId }); } catch { /* session gone */ }
    return;
  }
  countInFlight(tabId, 1);
  let disp: Disposition = 'continue';
  let graphql = false;
  try {
    const rec = await recordOf(source, target, tabId, p);
    graphql = rec.bodyShape.startsWith('gql');
    disp = await handler(rec);
  } catch (err) {
    // The caller knows the mode: enforce fails closed, monitor continues and logs.
    disp = onDecisionError(tabId, p, err);
  }
  try {
    if (disp === 'continue' && worker?.intercepting) rememberContinued(p.networkId);
    await answer(target, p, disp, graphql);
  } catch {
    /* session gone (tab closed / navigated); nothing to continue */
  } finally {
    countInFlight(tabId, -1);
  }
}

type ChildAttached = { sessionId: string; targetInfo: { type: string; url: string; targetId: string } };

/** A tab's auto-attach handed over a child target (iframe, worker): hold it, intercept it when it has its own
 *  network stack, then let it run. */
function onChildAttached(tabId: number, { sessionId, targetInfo }: ChildAttached): void {
  tabs.get(tabId)?.sessions.add(sessionId);
  const child: ChildSession = { tabId, targetId: targetInfo.targetId, type: targetInfo.type, host: hostOfUrl(targetInfo.url), intercepting: false };
  children.set(sessionId, child);
  if (!quiet(tabId)) logCb?.(tabId, `target-attached:${targetInfo.type}:${(targetInfo.url.split('?')[0] ?? targetInfo.url).slice(0, 100)}`);
  void (async () => {
    try {
      // Dedicated workers and worklets have no network stack of their own: their
      // requests surface on the page session, which already intercepts. Service
      // and shared workers and out-of-process iframes need Fetch enabled directly.
      if (targetInfo.type !== 'worker' && !targetInfo.type.endsWith('worklet')) {
        await enableOnSession(tabId, sessionId);
        if (OWN_NETWORK_WORKERS.has(targetInfo.type) && children.get(sessionId) === child) { child.intercepting = true; onWorkersChanged(); }
      }
    } catch (err) {
      console.warn(`[onlyread] Fetch.enable on ${targetInfo.type} session failed:`, err);
    } finally {
      await runChild(tabId, sessionId, targetInfo);
    }
  })();
}

/** Lets a held child run. A worker of a socket-guarded site (socket-guard.ts): the tab's sockets to the site wait until
 *  it reports its guard in (the guard arrives with its script), and anything sent into it waits until it runs: a
 *  worker held paused has no context to run code in, and the command would wait. */
async function runChild(tabId: number, sessionId: string, targetInfo: { type: string; url: string }): Promise<void> {
  const worker = targetInfo.type.endsWith('worker');
  if (worker) await workerStarting(tabId, sessionId, targetInfo.url).catch(() => {});
  try { await send({ tabId, sessionId }, 'Runtime.runIfWaitingForDebugger'); } catch { /* not waiting */ }
  if (worker) await prepareWorker(tabId, sessionId, targetInfo.url);
}

function onChildDetached(tabId: number, sessionId: string): void {
  tabs.get(tabId)?.sessions.delete(sessionId);
  withContext.delete(sessionId);
  contextWaiters.get(sessionId)?.(false);
  onWorkerGone(tabId, sessionId);
  const gone = children.get(sessionId);
  children.delete(sessionId);
  if (gone?.intercepting) onWorkersChanged();
}

function onEvent(source: chrome.debugger.DebuggerSession, method: string, params?: object): void {
  const tabId = source.tabId;
  if (tabId === undefined) return;
  switch (method) {
    case 'Fetch.requestPaused':
      void handlePaused(source, params as PausedParams);
      break;
    case 'Network.webTransportCreated': {
      // Rare and decisive: WebTransport is invisible to webRequest, so its creation is always worth a line.
      const { url } = params as { url: string };
      logCb?.(tabId, `net:webtransport:${(url.split('?')[0] ?? url).slice(0, 120)}`);
      break;
    }
    case 'Network.webSocketHandshakeResponseReceived': {
      // A handshake response means the socket actually opened despite the rules.
      const { requestId } = params as { requestId: string };
      logCb?.(tabId, `net:wsopen:${requestId}`);
      break;
    }
    case 'Network.webSocketFrameSent': {
      // A frame on an open socket while websockets are blocked means a channel predates the rules. Log once per socket.
      const { requestId, response } = params as { requestId: string; response: { payloadData?: string } };
      if (!loggedFrames.has(requestId)) { loggedFrames.add(requestId); logCb?.(tabId, `net:wsframe:${requestId}:${(response.payloadData ?? '').length}b`); }
      break;
    }
    case 'Network.webTransportConnectionEstablished': {
      const { transportId } = params as { transportId: string };
      logCb?.(tabId, `net:wtopen:${transportId}`);
      break;
    }
    case 'Runtime.executionContextCreated':
      if (source.sessionId && children.has(source.sessionId)) { withContext.add(source.sessionId); contextWaiters.get(source.sessionId)?.(true); }
      break;
    case 'Runtime.bindingCalled': {
      const { name, payload } = params as { name: string; payload: string };
      onBinding(tabId, name, payload, source.sessionId);
      break;
    }
    case 'Target.attachedToTarget':
      onChildAttached(tabId, params as ChildAttached);
      break;
    case 'Target.detachedFromTarget':
      onChildDetached(tabId, (params as { sessionId: string }).sessionId);
      break;
  }
}

function onDetach(source: chrome.debugger.Debuggee, reason: string): void {
  if (source.tabId === undefined) return;
  tabs.delete(source.tabId);
  dropChildren(source.tabId);
  onReleased(source.tabId);
  onDetachCb(source.tabId, reason);
}

let logCb: ((tabId: number, msg: string) => void) | undefined;
const loggedFrames = new Set<string>();

interface DebuggerOptions {
  onPaused: PausedHandler;
  onDetach: DetachHandler;
  /** Evidence log (system events): channel creation, gateway requests, target attachments. */
  log?: (tabId: number, msg: string) => void;
  onAttach?: (tabId: number, url: string) => void;
  /** A guarded page committed in a tab the debugger could not attach to: it has no interception. */
  onAttachFailed?: (tabId: number) => void;
  shouldAttach: (url: string) => boolean;
  /** Whether a paused request's URL is one the handler would judge; the rest continue untouched. Default: all. */
  shouldJudge?: (url: string) => boolean;
  /** The disposition when the decision path throws. Default: fail (closed). */
  onDecisionError?: DecisionErrorHandler;
  recentActions: (tabId: number) => UiAction[];
  /** The set of intercepted service and shared workers changed (see interceptedWorkerHosts). */
  onWorkersChanged?: () => void;
  /** A tab had another debugger attached when OnlyRead attached to it. */
  onForeignDebugger?: (tabId: number) => void;
  /** A tab is held now (Fetch enabled): the stanza guard goes in here (socket-guard.ts). */
  onHeld?: (tabId: number, url: string) => Promise<void>;
  /** A held tab's worker, as it starts. */
  prepareWorker?: (tabId: number, sessionId: string, url: string) => Promise<void>;
  /** A held tab's worker, before it runs. */
  workerStarting?: (tabId: number, sessionId: string, url: string) => Promise<void>;
  /** What goes before the first line of a worker script at this address, if anything. */
  workerScriptPrefix?: (url: string) => Promise<string | undefined>;
  onWorkerGone?: (tabId: number, sessionId: string) => void;
  /** A tab is no longer held: detached, its attach abandoned, or closed. */
  onReleased?: (tabId: number) => void;
  /** A page or worker called a binding the background added (Runtime.addBinding). */
  onBinding?: (tabId: number, name: string, payload: string, sessionId?: string) => void;
}

export function init(opts: DebuggerOptions): void {
  handler = opts.onPaused;
  onDetachCb = opts.onDetach;
  if (opts.onAttach) onAttachCb = opts.onAttach;
  logCb = opts.log;
  shouldAttach = opts.shouldAttach;
  shouldJudge = opts.shouldJudge ?? (() => true);
  onDecisionError = opts.onDecisionError ?? (() => 'fail');
  recentActions = opts.recentActions;
  if (opts.onWorkersChanged) onWorkersChanged = opts.onWorkersChanged;
  if (opts.onForeignDebugger) onForeignDebugger = opts.onForeignDebugger;
  if (opts.onHeld) onHeld = opts.onHeld;
  if (opts.prepareWorker) prepareWorker = opts.prepareWorker;
  if (opts.workerStarting) workerStarting = opts.workerStarting;
  if (opts.workerScriptPrefix) workerScriptPrefix = opts.workerScriptPrefix;
  if (opts.onWorkerGone) onWorkerGone = opts.onWorkerGone;
  if (opts.onReleased) onReleased = opts.onReleased;
  if (opts.onBinding) onBinding = opts.onBinding;

  chrome.debugger.onEvent.addListener(onEvent);
  chrome.debugger.onDetach.addListener(onDetach);
  // Chrome 86+: attach after the navigation commits, using the committed URL.
  chrome.webNavigation.onCommitted.addListener((d) => { if (d.frameId === 0) void attachCommitted(d.tabId, d.url, opts.onAttachFailed); });
  chrome.tabs.onRemoved.addListener((tabId) => { tabs.delete(tabId); dropChildren(tabId); onReleased(tabId); });
}

/** Attach after a navigation commits. A failed attach to a guarded page is reported: with no
 *  session there is no detach event to report it later. An attach already in progress is not a failure. */
export async function attachCommitted(tabId: number, url: string, onFailed?: (tabId: number) => void): Promise<void> {
  if (tabs.has(tabId) || attaching.has(tabId) || !shouldAttach(url)) return;
  if (!(await attach(tabId, url))) onFailed?.(tabId);
}

async function openGuardedTabs(): Promise<(chrome.tabs.Tab & { id: number })[]> {
  const open = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  return open.filter((t): t is chrome.tabs.Tab & { id: number } => t.id !== undefined && Boolean(t.url) && shouldAttach(t.url!));
}

/** The open guarded tabs not held yet: the ones attachExisting is about to attach to. */
export async function unheldGuardedTabs(): Promise<number[]> {
  return (await openGuardedTabs()).map((t) => t.id).filter((id) => !tabs.has(id));
}

/** Attaches to every open guarded tab. Reports the guarded tabs it could not hold, so the caller keeps
 *  them blocked instead of assuming every tab is intercepted. Tabs outside the scope are neither. */
export async function attachExisting(): Promise<{ attached: number[]; failed: number[] }> {
  const guarded = await openGuardedTabs();
  const results = await Promise.all(guarded.map(async (t) => ({ id: t.id, ok: await attach(t.id, t.url) })));
  return { attached: results.filter((r) => r.ok).map((r) => r.id), failed: results.filter((r) => !r.ok).map((r) => r.id) };
}

export function attachedTabs(): number[] {
  return [...tabs.keys()];
}

/** Tabs OnlyRead holds or is attaching right now: their debugger attachment is ours, not an agent's. */
export function ownedTabs(): Set<number> {
  return new Set([...tabs.keys(), ...attaching]);
}

/**
 * Whether another debugger is attached to a tab OnlyRead holds. The targets list reports a tab as attached
 * whoever holds it, so the only way to tell is to let go for a moment and look. `cover` refuses the tab's
 * POSTs and other non-GET requests by rule while it is not held (reads sent as POSTs fail for that moment too); since the rules apply before the debugger pauses a request, a request
 * already paused would go out unjudged on detach, so this waits until none is (and answers true, keeping the
 * session, when that takes too long or the tab cannot be held again).
 */
export async function foreignDebuggerOn(tabId: number, url: string, cover: (on: boolean) => Promise<void>, waitMs = 5000): Promise<boolean> {
  looking.add(tabId);
  try { return await lookOnce(tabId, url, cover, waitMs); } finally { looking.delete(tabId); }
}

/** Tabs a look is letting go of and taking back now: the unguarded-tab retry leaves them to it (guard.ts reattach), or
 *  it would attach in the middle of the look, and the look would take OnlyRead's own debugger for an agent's. */
const looking = new Set<number>();
export function lookingAt(tabId: number): boolean { return looking.has(tabId); }

async function lookOnce(tabId: number, url: string, cover: (on: boolean) => Promise<void>, waitMs: number): Promise<boolean> {
  await cover(true);
  const until = Date.now() + waitMs;
  while ((inFlightByTab.get(tabId) ?? 0) > 0) {
    if (Date.now() > until) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  // The let-go and the taking back are routine: not logged (see quietUntil). A failure to take it back still is.
  quietUntil.set(tabId, Date.now() + 60_000);
  await detach(tabId);
  const foreign = (await targetsNow()).some((t) => t.tabId === tabId && t.attached);
  if (!(await attach(tabId, url))) { quietUntil.delete(tabId); return true; } // left blocked by `cover`; the unguarded-tab retry takes over
  quietUntil.set(tabId, Date.now() + QUIET_AFTER_MS); // the page's workers are handed over again just after
  await cover(false);
  return foreign;
}

/** Tabs a look (foreignDebuggerOn) is letting go of and taking back, until when. Every few seconds while an agent
 *  works, OnlyRead's own detach, attach and the page's workers attached again would each go to the decision log, which
 *  keeps a fixed number of entries: an hour of an agent's work pushed every refusal out of it. Only what changes is
 *  logged: an attach that failed, an agent found gone (agent-session.ts). */
const quietUntil = new Map<number, number>();
const QUIET_AFTER_MS = 1000;
const quiet = (tabId: number): boolean => (quietUntil.get(tabId) ?? 0) > Date.now();

/** A command on a held tab or one of its sessions, bounded like the setup commands (socket-guard.ts). */
export function command(target: chrome.debugger.DebuggerSession, method: string, params?: object): Promise<object | undefined> {
  return sendWithin(target.tabId ?? -1, target, method, params as Record<string, unknown> | undefined);
}

/** Whether a request of this tab is being decided now (paused, waiting for its answer). */
export function busy(tabId: number): boolean {
  return (inFlightByTab.get(tabId) ?? 0) > 0;
}

/** Whether OnlyRead holds this tab now. */
export function holds(tabId: number): boolean {
  return tabs.has(tabId);
}

export function pending(): number {
  return inFlight;
}
