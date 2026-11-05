// The guard for Telegram Web, put by the debugger (background/socket-guard.ts) into a guarded tab's page and workers.
// It acts in Telegram's MTProto worker: that worker hands every request, still readable, to its crypto worker twice,
// first to make the request's key (`sha256` over part of the auth key and the request), then to encrypt it
// (`aes-encrypt`); the same `sha256` hashes other things too (each message the server sends, the key exchange), and
// only what is surely a request the client is sending (mtproto.ts isClientRequest) is touched at that step, each a task posted on a MessagePort or Worker. The guard holds those tasks until it has named the
// request's calls (mtproto.ts, with Telegram's own schema read from the worker's script). At the key step each message
// that makes a write is turned into a method no server knows, the same length (refuseWrites): the server answers that
// message with an error and the reads sharing its request go on; the encryption then takes the same rewritten bytes.
// A write seen first at encryption, or a request it cannot read, is refused whole: answered with an error, never sent.
// Everything else is posted on as it was. Refusals (or, in monitor mode, writes let through) are reported
// through the debugger's binding.
import { isClientRequest, methodTable, refuseWrites } from './mtproto';

interface GuardConfig { mode: 'monitor' | 'enforce'; allow: string[]; hosts: string[]; binding: string }
interface Guard { configure(c: GuardConfig): void }
interface Task { type?: string; id?: number; payload?: { payload?: { method?: string; args?: unknown[] } } }

declare const orSocketConfig: GuardConfig;

const KEY = Symbol.for('onlyread.socket-guard');
const g = globalThis as unknown as Record<symbol, Guard | undefined> & Record<string, unknown>;

const bytesOf = (v: unknown): Uint8Array | undefined => {
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (Array.isArray(v)) return Uint8Array.from(v as number[]);
  return undefined;
};
const methodOf = (t: Task | undefined): string | undefined => (t?.type === 'invoke' ? t.payload?.payload?.method : undefined);
const isCrypto = (t: Task | undefined): boolean => methodOf(t) === 'aes-encrypt' || methodOf(t) === 'sha256';
/** The message id, sequence number and length of a request: unique to it, so its key step and its encryption meet. */
const keyOf = (plain: Uint8Array) => Array.prototype.join.call(plain.subarray(16, 32), ',');

function install(initial: GuardConfig): Guard {
  let cfg = initial;
  let allow = new Set(cfg.allow);
  const host = (() => { try { return location.hostname; } catch { return ''; } })();
  const active = () => cfg.hosts.some((h) => host === h || host.endsWith(`.${h}`));
  // The schema this worker's own script carries; an empty table names nothing, so every call is refused.
  const inWorker = typeof (globalThis as { WorkerGlobalScope?: unknown }).WorkerGlobalScope !== 'undefined';
  const table = inWorker ? fetch(location.href).then((r) => r.text()).then(methodTable).catch(() => new Map<number, string>()) : Promise.resolve(new Map<number, string>());

  const report = (shape: string, enforced: boolean) => {
    const fn = g[cfg.binding];
    if (typeof fn === 'function') try { (fn as (s: string) => void)(JSON.stringify({ shape, enforced })); } catch { /* binding gone */ }
  };

  /** Requests already rewritten at their key step (`sha256` over 32 bytes of key, then the request), by keyOf: the
   *  encryption that follows must take the same bytes, or the server would refuse the whole request. */
  const rewritten = new Map<string, Uint8Array>();

  /** The encryption of a request rewritten at its key step takes the rewritten bytes. */
  const takeRewritten = (args: unknown[], key: string): boolean => {
    const done = rewritten.get(key);
    if (!done) return false;
    args[0] = Array.from(done);
    rewritten.delete(key);
    return true;
  };

  /** Acts on a request with writes: reports them; in enforce mode, at the key step, keeps the rewritten bytes for the
   *  encryption and hands the key step the rewritten request. False when the task must be refused whole. */
  const onWrites = (r: { plain: Uint8Array; writes: string[]; whole: boolean }, args: unknown[], data: Uint8Array, isKey: boolean, key: string): boolean => {
    const enforced = cfg.mode === 'enforce';
    for (const w of new Set(r.writes)) report(w, enforced);
    if (!enforced) return true;
    // Unreadable, or a write first seen at encryption (its key already made from the original): refused whole.
    if (r.whole || !isKey) return false;
    rewritten.set(key, r.plain);
    if (rewritten.size > 256) rewritten.delete(rewritten.keys().next().value!);
    args[0] = Array.from([...data.subarray(0, 32), ...r.plain]);
    return true;
  };

  const requestIn = async (plain: Uint8Array) => (plain.length >= 36 ? refuseWrites(plain, await table, allow) : undefined);

  /** Rewrites a request's write messages so the server answers each with an error and the rest goes on (mtproto.ts
   *  refuseWrites). `true` when the task may go (rewritten or as it was), `false` to refuse it whole. */
  const vet = async (t: Task): Promise<boolean> => {
    const args = t.payload?.payload?.args ?? [];
    const data = bytesOf(args[0]);
    if (!data) return false;
    const isKey = methodOf(t) === 'sha256';
    const plain = isKey ? data.subarray(32) : data;
    const key = keyOf(plain);
    // The key step also hashes what is not a request (each message the server sends, the key exchange, checks of the
    // stored key): only what is surely one is touched there. A request it passes over is refused at encryption.
    if (isKey ? !isClientRequest(plain, Date.now() / 1000) : takeRewritten(args, key)) return true;
    const r = await requestIn(plain);
    if (!r) return isKey || bytesOf(args[2])?.length === 1; // no request: other hashing, or the key exchange
    return r.writes.length ? onWrites(r, args, data, isKey, key) : true;
  };

  const refuse = (target: EventTarget, t: Task) => {
    target.dispatchEvent(new MessageEvent('message', { data: { type: 'result', payload: { taskId: t.id, error: 'onlyread: refused' } } }));
  };

  /** Holds a message that carries crypto tasks until each is vetted; posts on the rest, answers the refused. */
  const forward = async (target: EventTarget, post: (m: unknown) => void, m: { type?: string; payload?: Task[] } & Task, tasks: Task[]) => {
    const keep: Task[] = [];
    const refused: Task[] = [];
    for (const t of tasks) (isCrypto(t) && !(await vet(t)) ? refused : keep).push(t);
    if (keep.length) post(m.type === 'batch' ? { ...m, payload: keep } : keep[0]);
    for (const t of refused) refuse(target, t);
  };

  for (const C of [globalThis.MessagePort, globalThis.Worker].filter((c): c is typeof MessagePort | typeof Worker => typeof c === 'function')) {
    const original = C.prototype.postMessage as (this: EventTarget, m: unknown, ...rest: unknown[]) => void;
    C.prototype.postMessage = function (this: EventTarget, m: unknown, ...rest: unknown[]) {
      const msg = m as { type?: string; payload?: Task[] } & Task;
      const tasks: Task[] = msg?.type === 'batch' && Array.isArray(msg.payload) ? msg.payload : [msg];
      if (!active() || !tasks.some(isCrypto)) return original.call(this, m, ...rest);
      void forward(this, (x) => original.call(this, x, ...rest), msg, tasks);
    } as typeof C.prototype.postMessage;
  }

  return { configure(c) { cfg = c; allow = new Set(c.allow); } };
}

const existing = g[KEY];
if (existing) existing.configure(orSocketConfig);
else g[KEY] = install(orSocketConfig);
