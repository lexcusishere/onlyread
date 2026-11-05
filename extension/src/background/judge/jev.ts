// Jev (TypeSafe AI System One) through a TypeSafe-compatible gateway.
// One yes/no question, calibrated probability back. No text generation, so the
// judge cannot be talked into anything by strings inside the request body.
import type { RequestRecord } from '../../shared/types';
import type { Judge, JudgeAsk, JudgeResult } from './types';
import { buildJudgeState, questionFor } from './state';

interface JevOptions {
  apiKey: string;
  /** Gateway base, e.g. https://ai-gateway.vercel.sh (TypeSafe-compatible path is appended). */
  baseUrl?: string;
  /** Full System One URL; overrides baseUrl. OpenRouter serves it at https://openrouter.ai/api/v1/systemone. */
  endpoint?: string;
  model?: string;
  budgetMs?: number;
  fetchImpl?: typeof fetch;
}

interface SystemOneResponse {
  model?: string;
  answers?: Record<string, { type: string; noul?: number }>;
  usage?: { input_tokens?: number; output_tokens?: number };
  message?: string;
  error_type?: string;
  error?: { message?: string; type?: string };
}

export class JevJudge implements Judge {
  readonly name = 'jev' as const;
  readonly budgetMs?: number;
  private readonly url: string;
  private readonly model: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: JevOptions) {
    const base = (opts.baseUrl ?? 'https://ai-gateway.vercel.sh').replace(/\/$/, '');
    this.url = opts.endpoint ?? `${base}/typesafe/v1/systemone`;
    this.model = opts.model ?? 'typesafe-ai/jev';
    this.apiKey = opts.apiKey;
    this.budgetMs = opts.budgetMs;
    // Never store the bare global: calling `fetch` detached from its receiver throws
    // "Illegal invocation" in a service worker. Wrap it so `this` stays the global.
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  async classify(rec: RequestRecord, ask?: JudgeAsk): Promise<JudgeResult> {
    const t0 = Date.now();
    const body = JSON.stringify({
      model: this.model,
      state: buildJudgeState(rec),
      questions: { write: { type: 'noul', instructions: questionFor(ask?.readTracking) } },
    });
    const send = () => this.fetchImpl(this.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
      body,
    });
    let res = await send();
    // Rate-limited or upstream hiccup: one short retry. The decision-level timeout still bounds the wait.
    if (res.status === 429 || res.status >= 500) {
      void res.body?.cancel().catch(() => {}); // the first answer is not read; let the connection go
      await new Promise((r) => setTimeout(r, 400));
      res = await send();
    }
    const latencyMs = Date.now() - t0;
    let data: SystemOneResponse | undefined;
    try { data = (await res.json()) as SystemOneResponse; } catch { /* non-JSON error body */ }
    if (!res.ok) {
      const msg = data?.message ?? data?.error?.message ?? res.statusText;
      throw new Error(`jev http ${res.status}: ${msg}`);
    }
    const p = data?.answers?.write?.noul;
    if (typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 1) {
      throw new Error(`jev returned no probability: ${JSON.stringify(data?.answers ?? data).slice(0, 200)}`);
    }
    return { pWrite: p, latencyMs, model: data?.model ?? this.model };
  }
}
