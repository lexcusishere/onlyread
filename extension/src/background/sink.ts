// Dev-only: batch decisions/observations to an HTTP endpoint so a real Chrome
// profile can be measured without opening the popup. Fire-and-forget.
let url: string | null = null;
let instanceTag: string | undefined;
export function setInstance(id: string): void { instanceTag = id; }
let queue: unknown[] = [];
let timer: ReturnType<typeof setTimeout> | undefined;

export function configure(sinkUrl: string | null | undefined): void {
  url = sinkUrl && /^https?:\/\//.test(sinkUrl) ? sinkUrl : null;
}

export function ownOrigin(): string {
  return chrome.runtime.getURL('').replace(/\/$/, '');
}

export function send(kind: 'decision' | 'observation' | 'system', payload: unknown): void {
  if (!url) return;
  queue.push({ kind, payload, instance: instanceTag });
  if (!timer) timer = setTimeout(flush, 500);
}

async function flush(): Promise<void> {
  timer = undefined;
  if (!url || queue.length === 0) return;
  const batch = queue; queue = [];
  // No keepalive: Chrome caps keepalive bodies at 64 KB and rejects larger ones, which silently
  // dropped every batch that carried a full request body. Send in chunks of ~256 KB instead.
  const chunks: unknown[][] = [[]];
  let size = 0;
  for (const item of batch) {
    const len = JSON.stringify(item).length;
    if (size + len > 256 * 1024 && chunks[chunks.length - 1]!.length) { chunks.push([]); size = 0; }
    chunks[chunks.length - 1]!.push(item); size += len;
  }
  for (const chunk of chunks) {
    try {
      await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(chunk) });
    } catch {
      /* dev sink unreachable; drop */
    }
  }
}
