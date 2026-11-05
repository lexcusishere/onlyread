import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Web Push from OnlyRead Pro (cloud-push.ts) with the service worker's push manager, the Pro client and storage
// replaced: subscribed only while signed in and while the service has a key, registered on the account, made again
// when the key changed, and dropped at sign-out; a push asks for the lists.
const h = vi.hoisted(() => ({
  signedIn: true,
  key: 'BKey' as string | undefined,
  registered: [] as unknown[],
  sync: vi.fn(async (_why: string) => {}),
  signedOutHooks: [] as (() => void)[],
  system: vi.fn(),
}));
vi.mock('./cloud-session', () => ({
  cloudClient: () => ({ signedIn: async () => h.signedIn, pushKey: async () => h.key, registerPush: async (s: unknown) => { h.registered.push(s); } }),
  whenSignedOut: (fn: () => void) => { h.signedOutHooks.push(fn); },
}));
vi.mock('./cloud-sync', () => ({ syncManagedSites: h.sync }));
vi.mock('./state', () => ({ system: h.system }));

const store: Record<string, unknown> = {};
const b64 = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0)).buffer;
class Sub {
  unsubscribed = false;
  constructor(public endpoint: string, public options: { applicationServerKey: ArrayBuffer | null }) {}
  toJSON() { return { endpoint: this.endpoint, keys: { p256dh: 'p'.repeat(87), auth: 'a'.repeat(22) } }; }
  async unsubscribe() { this.unsubscribed = true; push.current = null; return true; }
}
const push = { current: null as Sub | null, subscribes: 0, active: true as boolean };
const pushManager = {
  getSubscription: async () => push.current,
  subscribe: async (o: { applicationServerKey: Uint8Array }) => { push.subscribes++; push.current = new Sub(`https://fcm.googleapis.com/fcm/send/${push.subscribes}`, { applicationServerKey: o.applicationServerKey.buffer as ArrayBuffer }); return push.current; },
};

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
  Object.assign(h, { signedIn: true, key: 'BKey', registered: [] });
  Object.assign(push, { current: null, subscribes: 0, active: true });
  vi.stubGlobal('registration', { get active() { return push.active ? {} : null; }, pushManager });
  vi.stubGlobal('chrome', { storage: { local: {
    get: async (k: string) => (k in store ? { [k]: store[k] } : {}),
    set: async (o: Record<string, unknown>) => { Object.assign(store, o); },
    remove: async (k: string) => { delete store[k]; },
  } } });
});
afterEach(() => vi.unstubAllGlobals());

const { ensurePush, onPush, pushActive } = await import('./cloud-push');

describe('Web Push from OnlyRead Pro', () => {
  it('counts as reaching this browser only while its subscription is the one registered on the account', async () => {
    expect(await pushActive()).toBe(false); // none yet
    await ensurePush('signed-in');
    expect(await pushActive()).toBe(true);
    push.current = new Sub('https://fcm.googleapis.com/fcm/send/other', { applicationServerKey: null }); // replaced, not registered yet
    expect(await pushActive()).toBe(false);
    await ensurePush('subscription-changed', true);
    expect(await pushActive()).toBe(true);
    for (const fn of h.signedOutHooks) fn();
    await vi.waitFor(async () => expect(await pushActive()).toBe(false));
  });

  it('subscribes with the service\'s key and keeps the subscription on the account; once done, a start asks nothing', async () => {
    await ensurePush('signed-in');
    expect(push.subscribes).toBe(1);
    expect(new Uint8Array(push.current!.options.applicationServerKey!)).toEqual(new Uint8Array(b64('BKey')));
    expect(h.registered).toEqual([{ endpoint: 'https://fcm.googleapis.com/fcm/send/1', keys: { p256dh: 'p'.repeat(87), auth: 'a'.repeat(22) } }]);
    await ensurePush('startup');
    expect(h.registered).toHaveLength(1);
    expect(push.subscribes).toBe(1);
  });

  it('does nothing signed out, before the worker is active, or while the service has no key (and drops a subscription then)', async () => {
    h.signedIn = false;
    await ensurePush('startup');
    push.active = false; h.signedIn = true;
    await ensurePush('startup');
    expect(push.subscribes).toBe(0);
    push.active = true;
    await ensurePush('startup');
    expect(push.subscribes).toBe(1);
    h.key = undefined;
    await ensurePush('subscription-changed', true);
    expect(push.current).toBeNull();
    expect(store.pushRegistered).toBeUndefined();
  });

  it('subscribes again when the service\'s key changed', async () => {
    await ensurePush('signed-in');
    h.key = 'BNew';
    await ensurePush('subscription-changed', true);
    expect(push.subscribes).toBe(2);
    expect(h.registered).toHaveLength(2);
  });

  it('a sign-out unsubscribes; a push asks for the lists', async () => {
    await ensurePush('signed-in');
    const sub = push.current!;
    for (const fn of h.signedOutHooks) fn();
    await vi.waitFor(() => expect(sub.unsubscribed).toBe(true));
    await vi.waitFor(() => expect(store.pushRegistered).toBeUndefined());
    await onPush();
    expect(h.sync).toHaveBeenCalledWith('push');
  });
});
