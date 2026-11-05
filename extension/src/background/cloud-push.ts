// Web Push from OnlyRead Pro: what this browser guards on the account changes, and the account says so in seconds
// instead of at the next poll (cloud-sync.ts, which stays, every half hour while pushes reach this browser). The push carries nothing: it only makes the
// extension ask GET /v1/config now, through the same lock as every list, so a push can never change what is guarded.
// The subscription is made only once the service worker is active (made earlier it fails), kept on the account
// (POST /v1/push), and dropped at sign-out. A service with no push key, or one from before push, leaves the poll alone,
// every five minutes.
import { cloudClient, whenSignedOut } from './cloud-session';
import { syncManagedSites } from './cloud-sync';
import { system } from './state';

/** What this browser last registered on the account: the endpoint, the key it was made with, and when. */
const KEPT = 'pushRegistered';
/** Registered again at most this often, so a subscription the service forgot comes back without a check on every start. */
const RENEW_MS = 24 * 3600_000;

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const registration = (): ServiceWorkerRegistration | undefined => (globalThis as unknown as { registration?: ServiceWorkerRegistration }).registration;

function fromBase64Url(s: string): Uint8Array<ArrayBuffer> {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(new ArrayBuffer(b.length));
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
}
function toBase64Url(buf: ArrayBuffer | null): string {
  if (!buf) return '';
  return btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Subscribes this browser to the account's pushes when signed in, and keeps the subscription on the account.
 *  `force`: the push service replaced the subscription (pushsubscriptionchange), register again now. Never throws. */
export async function ensurePush(why: string, force = false): Promise<void> {
  try {
    const reg = registration();
    if (!reg?.pushManager || !reg.active) return;
    const c = cloudClient();
    if (!(await c.signedIn())) return;
    const kept = (await chrome.storage.local.get(KEPT))[KEPT] as { endpoint?: string; key?: string; at?: number } | undefined;
    let sub = await reg.pushManager.getSubscription();
    if (!force && sub && kept?.endpoint === sub.endpoint && (kept.at ?? 0) > Date.now() - RENEW_MS) return;
    const key = await c.pushKey();
    if (!key) { if (sub) await sub.unsubscribe().catch(() => false); await chrome.storage.local.remove(KEPT); return; }
    // A subscription made with another key cannot receive this service's pushes.
    if (sub && toBase64Url(sub.options.applicationServerKey) !== key) { await sub.unsubscribe().catch(() => false); sub = null; }
    sub ??= await reg.pushManager.subscribe({ userVisibleOnly: false, applicationServerKey: fromBase64Url(key) });
    const j = sub.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
    if (!j.endpoint || !j.keys?.p256dh || !j.keys.auth) return;
    await c.registerPush({ endpoint: j.endpoint, keys: { p256dh: j.keys.p256dh, auth: j.keys.auth } });
    await chrome.storage.local.set({ [KEPT]: { endpoint: j.endpoint, key, at: Date.now() } });
    system(`push:registered (${why})`);
  } catch (err) {
    system(`push:not-registered (${why}) ${errorText(err)}`.slice(0, 200));
  }
}

/** Whether pushes reach this browser: it has a subscription, and that subscription is the one registered on the account.
 *  The minute check asks only every half hour then (cloud-sync.ts managedPollDue). Never throws. */
export async function pushActive(): Promise<boolean> {
  try {
    const sub = await registration()?.pushManager?.getSubscription();
    if (!sub) return false;
    const kept = (await chrome.storage.local.get(KEPT))[KEPT] as { endpoint?: string } | undefined;
    return kept?.endpoint === sub.endpoint;
  } catch { return false; }
}

/** Signed out: no more pushes to this browser (the service drops its copy with the sign-in). */
async function dropPush(): Promise<void> {
  try {
    const sub = await registration()?.pushManager?.getSubscription();
    if (sub) await sub.unsubscribe();
  } catch { /* gone already */ }
  await chrome.storage.local.remove(KEPT).catch(() => {});
}

/** A push from the account: ask for the lists now. */
export async function onPush(): Promise<void> {
  system('push:received');
  await syncManagedSites('push');
}

whenSignedOut(() => { void dropPush(); });
