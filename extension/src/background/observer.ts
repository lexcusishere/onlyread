// Ground truth #1: a passive webRequest observer that sees every request the
// browser attempts to target domains, whether or not a debugger is attached.
import type { Observation, Policy } from '../shared/types';
import { guardsHost } from './decision';
import { SECRET_KEY, strictPreview } from './fingerprint';
import { devBuild } from './policy';
import { normalizeDomains } from './rules';
import { storageFailed, storageOk } from './storage-health';
import * as sink from './sink';

const KEY = 'observations';
const MAX = 5000;
/** The request log's share of storage.local's 10 MB: a release observation is about 300 bytes, so MAX fit; a
 *  development build keeps 2 KB bodies, and then the oldest go first. */
export const MAX_BYTES = 1.5 * 1024 * 1024;
const FLUSH_MS = 500;

let buffer: Observation[] | null = null;
let loading: Promise<Observation[]> | null = null;
const byRequestId = new Map<string, Observation>();
/** Bytes each buffered observation takes, near enough, in the buffer's order. */
let sizes: number[] = [];
let totalBytes = 0;
let flushTimer: ReturnType<typeof setTimeout> | undefined;
let policyRef: Policy | null = null;
let ownOrigin = '';
/** Whether protection is attached right now (off and dormant agent-session mode record nothing). */
let activeRef: () => boolean = () => false;

// The outcome patch (`finish`) adds a few fields later; counted up front so no second pass is needed.
const sizeOf = (o: Observation): number => JSON.stringify(o).length + 48;

// Single shared load so a burst of requests at page load cannot race the first read. A failed read is
// reported and forgotten, so the next call reads again (a kept rejection would make `count()` reject, which
// would blank the popup and the settings page through `status:get`).
function load(): Promise<Observation[]> {
  if (buffer) return Promise.resolve(buffer);
  if (!loading) {
    loading = chrome.storage.local.get(KEY).then((r) => {
      const stored = r[KEY];
      buffer = Array.isArray(stored) ? (stored as Observation[]) : [];
      sizes = buffer.map(sizeOf);
      totalBytes = sizes.reduce((n, s) => n + s, 0);
      storageOk('observations', 'read');
      return buffer;
    }, (err: unknown) => {
      loading = null;
      storageFailed('observations', err, 'read');
      throw err;
    });
  }
  return loading;
}

/** The buffer, or null while storage cannot be read. */
const loaded = (): Promise<Observation[] | null> => load().catch(() => null);

/** A failed write is reported (storage-health.ts), not thrown from a timer, and the next flush tries again. */
async function flushNow(): Promise<void> {
  if (!buffer) return;
  try { await chrome.storage.local.set({ [KEY]: buffer }); storageOk('observations'); }
  catch (err) { storageFailed('observations', err); }
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => { flushTimer = undefined; void flushNow(); }, FLUSH_MS);
}

/** Drop the oldest past the count and byte ceilings. */
function trim(b: Observation[]): void {
  let n = 0;
  while (b.length - n > 0 && (b.length - n > MAX || totalBytes > MAX_BYTES)) { totalBytes -= sizes[n]!; n++; }
  if (!n) return;
  for (const o of b.splice(0, n)) byRequestId.delete(o.requestId);
  sizes.splice(0, n);
}

function hostOf(url: string): string {
  try { return new URL(url).hostname; } catch { return ''; }
}

/** A request body as the observer keeps it: only when `keep` (a development build with the dev sink on,
 *  where the harness uses it), and only when the redactor understands it (JSON or form encoding, secret
 *  values replaced). Raw bytes it cannot parse are dropped, never kept as they are. */
export function observedBody(body: chrome.webRequest.OnBeforeRequestDetails['requestBody'], keep: boolean): string | undefined {
  if (!body || !keep) return undefined;
  if (body.formData) {
    const form = new URLSearchParams();
    for (const [k, vs] of Object.entries(body.formData)) for (const v of vs) form.append(k, String(v));
    return strictPreview('application/x-www-form-urlencoded', form.toString());
  }
  const raw = body.raw?.[0]?.bytes;
  if (!raw) return undefined;
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(raw); } catch { return undefined; }
  return strictPreview(undefined, text);
}

/** Bodies are kept only in a development build (a build-time fact, not configuration: a stored policy can
 *  carry a dev sink into a release build) and only while the dev sink is configured. */
export function keepBodies(policy: Policy | null, isDevBuild = devBuild()): boolean {
  return isDevBuild && Boolean(policy?.devSink);
}

/** The URL with secret-looking query values replaced (access_token=…, code=…, password=…). */
export function observedUrl(url: string): string {
  try {
    const u = new URL(url);
    for (const k of [...new Set(u.searchParams.keys())]) if (SECRET_KEY.test(k)) u.searchParams.set(k, '[redacted]');
    return u.toString();
  } catch { return url; }
}

/** Record a request only while protection is on and attached, and only for a guarded host. */
export function observing(policy: Policy | null, active: boolean, url: string): boolean {
  if (!policy?.enabled || !active) return false;
  return guardsHost(policy.effective, hostOf(url));
}

function shouldObserve(url: string, initiator?: string): boolean {
  if (initiator && ownOrigin && initiator.startsWith(ownOrigin)) return false; // our own dev-sink traffic
  return observing(policyRef, activeRef(), url);
}

async function onBeforeRequest(d: chrome.webRequest.OnBeforeRequestDetails): Promise<void> {
  if (!shouldObserve(d.url, d.initiator)) return;
  const obs: Observation = {
    ts: d.timeStamp, requestId: d.requestId, tabId: d.tabId, method: d.method, url: observedUrl(d.url), type: d.type,
    initiator: d.initiator, bodyPreview: observedBody(d.requestBody, keepBodies(policyRef)),
  };
  const b = await loaded();
  if (!b) return; // not recorded: the log cannot be read, and a fresh one must not overwrite it
  b.push(obs);
  const size = sizeOf(obs);
  sizes.push(size); totalBytes += size;
  byRequestId.set(d.requestId, obs);
  trim(b);
  scheduleFlush();
}

function finish(requestId: string, patch: Partial<Observation>): void {
  const obs = byRequestId.get(requestId);
  if (!obs) return;
  Object.assign(obs, patch, { endTs: Date.now() });
  byRequestId.delete(requestId);
  sink.send('observation', obs);
  scheduleFlush();
}

const onBefore = (d: chrome.webRequest.OnBeforeRequestDetails): undefined => { void onBeforeRequest(d); };
const onDone = (d: chrome.webRequest.OnCompletedDetails): void => finish(d.requestId, { outcome: 'completed', status: d.statusCode });
const onFailed = (d: chrome.webRequest.OnErrorOccurredDetails): void => finish(d.requestId, { outcome: 'error', error: d.error });
let listening: string | null = null;

/** Match patterns for the guarded domains, every scheme webRequest reports (sockets included): what the
 *  observer records is exactly the requests to these hosts, so the browser need not call it for the rest. */
export function urlPatterns(domains: string[]): string[] {
  const out: string[] = [];
  for (const d of normalizeDomains(domains)) {
    for (const scheme of ['*', 'ws', 'wss']) {
      out.push(`${scheme}://${d}/*`);
      if (!/^\d+(\.\d+){3}$/.test(d)) out.push(`${scheme}://*.${d}/*`); // an IP literal has no subdomains
    }
  }
  return out;
}

function stopListening(): void {
  chrome.webRequest.onBeforeRequest.removeListener(onBefore);
  chrome.webRequest.onCompleted.removeListener(onDone);
  chrome.webRequest.onErrorOccurred.removeListener(onFailed);
  listening = null;
}

/** (Re)registers the three listeners for these URL patterns. The request body is asked for only in a
 *  development build, where the harness reads it: with `requestBody` Chrome copies every request's body
 *  into the event, for every tab, and a release never keeps one. */
function listen(urls: string[]): void {
  const key = urls.join(' ');
  if (key === listening) return;
  if (listening !== null) stopListening();
  const spec: 'requestBody'[] = devBuild() ? ['requestBody'] : [];
  try {
    chrome.webRequest.onBeforeRequest.addListener(onBefore, { urls }, spec);
    chrome.webRequest.onCompleted.addListener(onDone, { urls });
    chrome.webRequest.onErrorOccurred.addListener(onFailed, { urls });
    listening = key;
  } catch (err) {
    // A pattern the browser refuses (an odd domain string): observe everything rather than nothing, with no
    // half-registered set left behind (removing a listener that was never added is a no-op).
    console.warn('[onlyread] observer patterns refused, observing all URLs:', err);
    stopListening();
    if (urls.length !== 1 || urls[0] !== '<all_urls>') listen(['<all_urls>']);
  }
}

/** Registered synchronously at the worker's top level (MV3), before the policy is known: every URL, until
 *  updatePolicy narrows the listeners to the guarded domains. */
export function init(policy: Policy, active: () => boolean): void {
  policyRef = policy;
  activeRef = active;
  ownOrigin = sink.ownOrigin();
  listen(['<all_urls>']);
}

/** The policy changed: the listeners follow the guarded domains (every host when everything is guarded; `isTarget`
 *  then leaves out the allowed ones). With none there is nothing to observe, and the listeners come off until a site
 *  is switched on. */
export function updatePolicy(policy: Policy): void {
  policyRef = policy;
  const urls = policy.effective.guardAll ? ['<all_urls>'] : urlPatterns(policy.effective.targetDomains);
  if (urls.length) listen(urls); else stopListening();
}

export async function list(): Promise<Observation[]> {
  return [...((await loaded()) ?? [])].reverse();
}

export async function count(): Promise<number> {
  return (await loaded())?.length ?? 0;
}

export async function clear(): Promise<void> {
  buffer = [];
  loading = null;
  byRequestId.clear();
  sizes = []; totalBytes = 0;
  await chrome.storage.local.set({ [KEY]: [] });
}
