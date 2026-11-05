import { describe, expect, it } from 'vitest';
import { llmModelFor } from './llm';

describe('llmModelFor', () => {
  it('keeps provider slugs for the gateway and OpenRouter', () => {
    expect(llmModelFor('https://ai-gateway.vercel.sh', 'anthropic/claude-haiku-4.5')).toBe('anthropic/claude-haiku-4.5');
    expect(llmModelFor('https://openrouter.ai/api', 'anthropic/claude-sonnet-5')).toBe('anthropic/claude-sonnet-5');
  });
  it('translates slugs to Anthropic API ids for api.anthropic.com', () => {
    expect(llmModelFor('https://api.anthropic.com', 'anthropic/claude-haiku-4.5')).toBe('claude-haiku-4-5');
    expect(llmModelFor('https://api.anthropic.com', 'anthropic/claude-sonnet-5')).toBe('claude-sonnet-5');
    expect(llmModelFor('https://api.anthropic.com', 'claude-opus-5')).toBe('claude-opus-5');
  });
});

import { LlmJudge } from './llm';
import type { RequestRecord } from '../../shared/types';

describe('LlmJudge', () => {
  const rec: RequestRecord = {
    ts: 0, tabId: 1, requestId: 'r', method: 'POST', url: 'https://app.example.com/api/items', host: 'app.example.com',
    path: '/api/items', queryKeys: [], contentType: 'application/json', resourceType: 'Fetch', hasBody: true,
    bodyPreview: '{"title":"x"}', bodyShape: 'json:title', fingerprint: 'POST app.example.com/api/items json:title',
    lastUiActions: [{ ts: 0, type: 'click', tag: 'button', name: 'Create', url: 'https://app.example.com/' }],
  };
  const message = (text: string) => ({ id: 'm', type: 'message', role: 'assistant', model: 'anthropic/claude-sonnet-5', content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } });
  const judgeWith = (reply: () => Response, seen: { url?: string; body?: Record<string, unknown> } = {}) =>
    new LlmJudge({ apiKey: 'k', baseUrl: 'https://openrouter.ai/api', model: 'anthropic/claude-sonnet-5', fetchImpl: async (url, init) => {
      seen.url = String(url); seen.body = JSON.parse(String(init?.body)); return reply();
    } });

  it('asks the gateway once with the judge prompt and the request state, and returns its answer', async () => {
    const seen: { url?: string; body?: Record<string, unknown> } = {};
    const r = await judgeWith(() => Response.json(message('{"pWrite": 0.92, "reason": "creates an item"}')), seen).classify(rec);
    expect(r).toMatchObject({ pWrite: 0.92, reason: 'creates an item', model: 'anthropic/claude-sonnet-5' });
    expect(seen.url).toBe('https://openrouter.ai/api/v1/messages');
    expect(seen.body?.model).toBe('anthropic/claude-sonnet-5');
    expect(String(seen.body?.system)).toMatch(/untrusted data/);
    const user = JSON.stringify(seen.body?.messages);
    expect(user).toContain('api/items');
    expect(user).toContain('Create');
  });
  it('tells it how analytics beacons look only for a binary or compressed body; its question never changes', async () => {
    const seen: { url?: string; body?: Record<string, unknown> } = {};
    const j = judgeWith(() => Response.json(message('{"pWrite": 0.1}')), seen);
    await j.classify(rec, { readTracking: true });
    expect(String(seen.body?.system)).not.toMatch(/analytics beacons/);
    expect(JSON.stringify(seen.body?.messages)).toContain('Marking items as read or seen');
    await j.classify(rec, { binary: true });
    expect(String(seen.body?.system)).toMatch(/analytics beacons/);
  });
  it('throws on an answer without a probability, so the request is refused', async () => {
    await expect(judgeWith(() => Response.json(message('Probably a write.'))).classify(rec)).rejects.toThrow(/no usable answer/);
  });
  it('throws on a null probability, never reading it as 0 (a read)', async () => {
    await expect(judgeWith(() => Response.json(message('{"pWrite": null, "reason": "cannot tell"}'))).classify(rec)).rejects.toThrow(/no usable answer/);
  });
  it('throws on a gateway error, without retrying', async () => {
    let calls = 0;
    const j = new LlmJudge({ apiKey: 'k', baseUrl: 'https://openrouter.ai/api', model: 'm', fetchImpl: async () => { calls++; return Response.json({ type: 'error', error: { type: 'authentication_error', message: 'bad key' } }, { status: 401 }); } });
    await expect(j.classify(rec)).rejects.toThrow();
    expect(calls).toBe(1);
  });
});
