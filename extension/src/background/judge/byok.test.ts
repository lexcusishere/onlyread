import { describe, expect, it } from 'vitest';
import { buildByokJudges } from './byok';
import { PROVIDERS, choiceProblem, hasAnyKey, reviewModel } from '../../shared/providers';
import { parseVerdict } from './verdict';
import type { RequestRecord } from '../../shared/types';

const budgets = { jevMs: 3000, reviewMs: 6000 };
const rec: RequestRecord = {
  ts: 0, tabId: 1, requestId: 'r', method: 'POST', url: 'https://app.example.com/api/items', host: 'app.example.com',
  path: '/api/items', queryKeys: [], contentType: 'application/json', resourceType: 'Fetch', hasBody: true,
  bodyPreview: '{"title":"x"}', bodyShape: 'json:title', fingerprint: 'POST app.example.com/api/items json:title', lastUiActions: [],
};

describe('buildByokJudges', () => {
  it('gives each gateway Jev first and the review model second, both on the one key', async () => {
    for (const id of ['openrouter', 'vercel'] as const) {
      const calls: { url: string; auth: string | null }[] = [];
      const fetchImpl: typeof fetch = async (url, init) => {
        calls.push({ url: String(url), auth: new Headers(init?.headers).get('authorization') ?? new Headers(init?.headers).get('x-api-key') });
        return new Response(JSON.stringify({ answers: { write: { type: 'noul', noul: 0.9 } } }), { status: 200 });
      };
      const r = buildByokJudges({ id }, { keys: { [id]: 'k' } }, budgets, fetchImpl);
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      expect([r.primary.name, r.primary.budgetMs, r.review.name, r.review.budgetMs]).toEqual(['jev', 3000, 'llm', 6000]);
      await r.primary.classify(rec);
      expect(calls[0]?.url).toBe(PROVIDERS[id].jev.endpoint);
      expect(calls[0]?.auth).toBe('Bearer k');
    }
  });
  it('turns thinking off for the default review model (Haiku 5.5) and leaves other models as they are', async () => {
    const reviewBody = async (model?: string) => {
      let body: Record<string, unknown> = {};
      const fetchImpl: typeof fetch = async (_url, init) => {
        body = JSON.parse(String(init?.body));
        return Response.json({ id: 'm', type: 'message', role: 'assistant', model: 'x', content: [{ type: 'text', text: '{"pWrite": 0.1}' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } });
      };
      const r = buildByokJudges({ id: 'openrouter', model }, { keys: { openrouter: 'k' } }, budgets, fetchImpl);
      if (!r.ok) throw new Error('no judges');
      await r.review.classify(rec);
      return body;
    };
    const haiku = await reviewBody();
    expect([haiku.model, haiku.thinking]).toEqual(['anthropic/claude-haiku-5.5', { type: 'disabled' }]);
    expect(String(haiku.system)).toMatch(/answer above 0\.75/);
    const sonnet = await reviewBody('anthropic/claude-sonnet-5');
    expect([sonnet.model, sonnet.thinking]).toEqual(['anthropic/claude-sonnet-5', undefined]);
  });
  it('refuses a provider without its key, naming what is missing', () => {
    expect(buildByokJudges({ id: 'vercel' }, {}, budgets)).toEqual({ ok: false, problem: 'add your Vercel AI Gateway API key' });
    expect(buildByokJudges({ id: 'vercel' }, { keys: { openrouter: 'k' } }, budgets).ok).toBe(false);
  });
  it('keeps a key per provider', () => {
    const secrets = { keys: { openrouter: 'a', vercel: 'b' } };
    expect(choiceProblem({ id: 'openrouter' }, secrets)).toBeUndefined();
    expect(choiceProblem({ id: 'vercel' }, secrets)).toBeUndefined();
  });
  it('uses the chosen review model, or the default', () => {
    expect(reviewModel({ id: 'openrouter' })).toBe('anthropic/claude-haiku-5.5');
    expect(reviewModel({ id: 'vercel', model: 'anthropic/claude-haiku-4.5' })).toBe('anthropic/claude-haiku-4.5');
  });
});

describe('the review model with an Anthropic key', () => {
  const answer = (model: string, text = '{"pWrite": 0.1, "reason": "a search"}') => Response.json({ id: 'm', type: 'message', role: 'assistant', model, content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } });
  /** Judges whose Anthropic calls answer `anthropic` (a verdict's text, a status, or no connection); the gateway always answers. */
  const setup = (anthropic: string | number | 'offline', model?: string) => {
    const calls: { host: string; model: string; key: string | null }[] = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      const host = new URL(String(url)).host, body = JSON.parse(String(init?.body));
      const h = new Headers(init?.headers);
      // The key, however the SDK sends it: `x-api-key` (0.x) or `Authorization: Bearer` (1.x).
      calls.push({ host, model: body.model, key: h.get('x-api-key') ?? h.get('authorization')?.replace(/^Bearer /, '') ?? null });
      if (host !== 'api.anthropic.com') return answer(body.model);
      if (anthropic === 'offline') throw new TypeError('fetch failed');
      if (typeof anthropic === 'number') return new Response(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'busy' } }), { status: anthropic });
      return answer('claude-haiku-5-5', anthropic);
    };
    const r = buildByokJudges({ id: 'openrouter', model }, { keys: { openrouter: 'or', anthropic: 'ant' } }, budgets, fetchImpl);
    if (!r.ok) throw new Error('no judges');
    return { review: r.review, calls };
  };

  it('asks Anthropic, under its own key and model id, and only Anthropic when it answers', async () => {
    const { review, calls } = setup('{"pWrite": 0.1, "reason": "a search"}');
    expect([review.name, review.budgetMs]).toEqual(['llm', 6000]);
    expect((await review.classify(rec)).model).toBe('claude-haiku-5-5');
    expect(calls).toEqual([{ host: 'api.anthropic.com', model: 'claude-haiku-5-5', key: 'ant' }]);
  });
  it('asks the gateway when Anthropic answers with an error or cannot be reached', async () => {
    for (const failure of [529, 401, 'offline'] as const) {
      const { review, calls } = setup(failure);
      expect((await review.classify(rec)).model).toBe('anthropic/claude-haiku-5.5');
      expect(calls.map((c) => c.host)).toEqual(['api.anthropic.com', 'openrouter.ai']);
    }
  });
  it('does not ask again when Anthropic answers with no verdict: that is the model, not the provider', async () => {
    const { review, calls } = setup('Probably a write.');
    await expect(review.classify(rec)).rejects.toThrow();
    expect(calls.map((c) => c.host)).toEqual(['api.anthropic.com']);
  });
  it('leaves a review model that is not Claude on the gateway', async () => {
    const { review, calls } = setup('{"pWrite": 0.1}', 'openai/gpt-5');
    await review.classify(rec);
    expect(calls.map((c) => c.host)).toEqual(['openrouter.ai']);
  });
  it('runs no judge on an Anthropic key alone: Jev needs a gateway', () => {
    expect(buildByokJudges({ id: 'openrouter' }, { keys: { anthropic: 'ant' } }, budgets).ok).toBe(false);
    expect(hasAnyKey({ keys: { anthropic: 'ant' } })).toBe(false);
    expect(hasAnyKey({ keys: { anthropic: 'ant', vercel: 'v' } })).toBe(true);
  });
});

describe('parseVerdict', () => {
  it('reads plain JSON, fenced JSON, and the last answer after visible reasoning', () => {
    expect(parseVerdict('{"pWrite": 0.9, "reason": "creates"}')).toEqual({ pWrite: 0.9, reason: 'creates' });
    expect(parseVerdict('```json\n{"pWrite":0.1,"reason":"read"}\n```').pWrite).toBe(0.1);
    expect(parseVerdict('<think>maybe {"pWrite": 0.9}?</think>{"pWrite": 0.2, "reason": "search"}').pWrite).toBe(0.2);
    expect(parseVerdict('First guess {"pWrite": 0.5}. Final: {"pWrite": 0.8, "reason": "x"}').pWrite).toBe(0.8);
  });
  it('rejects answers without a usable probability', () => {
    expect(() => parseVerdict('I think it is a write.')).toThrow();
    expect(() => parseVerdict('{"pWrite": 1.7}')).toThrow();
    expect(() => parseVerdict('')).toThrow();
  });
});
