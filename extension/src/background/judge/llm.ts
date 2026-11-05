// Review-band judge: a chat model over the Anthropic Messages format the gateway exposes (OpenRouter,
// Vercel AI Gateway). Slower than Jev, but returns a reason, which is what you want when a request
// lands between the thresholds. Same input contract as Jev: structured state only, never page content.
import Anthropic from '@anthropic-ai/sdk';
import type { RequestRecord } from '../../shared/types';
import type { Judge, JudgeAsk, JudgeResult } from './types';
import { WRITE_QUESTION, buildJudgeState } from './state';
import { BINARY_BODY_NOTE, JUDGE_SYSTEM, parseVerdict } from './verdict';

interface LlmOptions {
  apiKey: string;
  baseUrl?: string;
  /** Gateway model slug. Inline latency budget favours Haiku 4.5; Sonnet 5 is the more careful choice. */
  model?: string;
  budgetMs?: number;
  /** Extra instructions appended to the system prompt (benchmarks of review-model guidance). */
  instructions?: string;
  /** Answer budget. Models that think by default (Haiku 5.5, Sonnet 5.5) spend it on thinking first. */
  maxTokens?: number;
  /** 'disabled' turns thinking off where the model allows it (Haiku 5.5 does; Sonnet 5.5 does not). */
  thinking?: 'disabled';
  fetchImpl?: typeof fetch;
}

export class LlmJudge implements Judge {
  readonly name = 'llm' as const;
  readonly budgetMs?: number;
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly system: string;
  private readonly maxTokens: number;
  private readonly thinking?: 'disabled';

  constructor(opts: LlmOptions) {
    this.model = opts.model ?? 'anthropic/claude-haiku-4.5';
    this.budgetMs = opts.budgetMs;
    this.system = opts.instructions ? `${JUDGE_SYSTEM} ${opts.instructions}` : JUDGE_SYSTEM;
    this.maxTokens = opts.maxTokens ?? 200;
    this.thinking = opts.thinking;
    this.client = new Anthropic({
      apiKey: opts.apiKey,
      baseURL: opts.baseUrl ?? 'https://ai-gateway.vercel.sh',
      dangerouslyAllowBrowser: true, // MV3 service worker; the key is this profile's own
      maxRetries: 0,
      ...(opts.fetchImpl ? { fetch: opts.fetchImpl } : {}),
    });
  }

  async classify(rec: RequestRecord, ask?: JudgeAsk): Promise<JudgeResult> {
    const t0 = Date.now();
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: this.maxTokens,
      ...(this.thinking ? { thinking: { type: this.thinking } } : {}),
      system: ask?.binary ? `${this.system} ${BINARY_BODY_NOTE}` : this.system,
      messages: [{ role: 'user', content: `${WRITE_QUESTION}\n\nRequest:\n${JSON.stringify(buildJudgeState(rec))}` }],
    });
    const latencyMs = Date.now() - t0;
    const text = response.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    const v = parseVerdict(text, rec.bodyPreview);
    return { pWrite: v.pWrite, latencyMs, model: response.model ?? this.model, reason: v.reason };
  }
}

/** Gateway/OpenRouter slugs (anthropic/claude-haiku-4.5) → Anthropic API ids (claude-haiku-4-5)
 *  when the base URL is api.anthropic.com; other providers take the slug as is. */
export function llmModelFor(baseUrl: string, model: string): string {
  if (!/api\.anthropic\.com/.test(baseUrl)) return model;
  return model.replace(/^anthropic\//, '').replace(/(\d)\.(\d)/g, '$1-$2');
}
