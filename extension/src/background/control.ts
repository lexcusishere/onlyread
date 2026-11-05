// Dev-only control channel. When the policy has a devSink on localhost, the background polls
// the fixture server for commands (set policy, mode, secrets, cache import, reload, …) so the
// measurement harness can drive the extension in a real Chrome profile without the options
// page. Never active without a localhost devSink; a shipped policy has none.
export type ControlCommand = { type: string; [k: string]: unknown };
type Handler = (cmd: ControlCommand) => Promise<unknown>;

let origin: string | null = null;
let handler: Handler | null = null;
let timer: ReturnType<typeof setInterval> | undefined;
let busy = false;
let instanceId: string | null = null;
let labelFn: (() => Promise<string>) | null = null;

/** A stable id per extension install (i.e. per Chrome profile), so two profiles running the
 *  same unpacked extension can be addressed separately by the harness. */
async function instance(): Promise<string> {
  if (instanceId) return instanceId;
  const { controlInstanceId } = await chrome.storage.local.get('controlInstanceId');
  if (typeof controlInstanceId === 'string' && controlInstanceId) { instanceId = controlInstanceId; return instanceId; }
  instanceId = Math.random().toString(36).slice(2, 8);
  await chrome.storage.local.set({ controlInstanceId: instanceId });
  return instanceId;
}

export function init(h: Handler, label?: () => Promise<string>): void { handler = h; labelFn = label ?? null; }
export const currentInstance = instance;

export function configure(devSink: string | null | undefined): void {
  let next: string | null = null;
  try {
    if (devSink) {
      const u = new URL(devSink);
      if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') next = u.origin;
    }
  } catch { /* not a URL */ }
  origin = next;
  if (timer) { clearInterval(timer); timer = undefined; }
  if (origin) timer = setInterval(() => void poll(), 2000);
}

async function poll(): Promise<void> {
  if (!origin || !handler || busy) return;
  busy = true;
  try {
    const id = await instance();
    const label = labelFn ? await labelFn().catch(() => '') : '';
    const res = await fetch(`${origin}/__control/next?instance=${encodeURIComponent(id)}&label=${encodeURIComponent(label)}`, { cache: 'no-store' });
    if (!res.ok) return;
    const job = (await res.json()) as { id?: number; command?: ControlCommand };
    if (!job.id || !job.command) return;
    let result: unknown;
    try { result = { ok: true, result: await handler(job.command) }; }
    catch (err) { result = { ok: false, error: err instanceof Error ? err.message : String(err) }; }
    await fetch(`${origin}/__control/result`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: job.id, instance: id, ...(result as object) }) });
  } catch { /* fixture down; try again next tick */ } finally { busy = false; }
}
