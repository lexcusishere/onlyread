// Messages from OnlyRead's own pages to the background. A handler that throws answers `{ error }` alone;
// `send` turns that back into a rejection, so a refused settings change cannot pass for a success.
import type { Message } from './types';

/** Prefix of a refusal by the settings lock (background/protection.ts LOCKED_PREFIX), then the reason. */
const LOCKED = /^locked:(agent|pin):/;

export async function send<T>(msg: Message): Promise<T> {
  const r = (await chrome.runtime.sendMessage(msg)) as unknown;
  if (r && typeof r === 'object' && 'error' in r && Object.keys(r).length === 1) throw new Error(String((r as { error: unknown }).error));
  return r as T;
}

interface Locked { reason: 'agent' | 'pin'; text: string }

/** The settings lock's refusal in an error, or undefined for any other failure. */
export function lockedBy(err: unknown): Locked | undefined {
  const m = err instanceof Error ? err.message : String(err);
  const hit = LOCKED.exec(m);
  return hit ? { reason: hit[1] as Locked['reason'], text: m.slice(hit[0].length) } : undefined;
}
