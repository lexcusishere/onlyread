import { describe, it, expect, vi } from 'vitest';
import { JevJudge } from './jev';
import { buildJudgeState, READ_TRACKING_QUESTION, WRITE_QUESTION } from './state';
import { previewBody } from '../fingerprint';
import * as typedSecrets from '../typed-secrets';
import type { RequestRecord } from '../../shared/types';

const rec = (): RequestRecord => ({
  ts: 0, tabId: 1, requestId: 'r', method: 'POST', url: 'https://app.example.com/api/items/42/close?x=1',
  host: 'app.example.com', path: '/api/items/42/close', queryKeys: ['x'], contentType: 'application/json', resourceType: 'Fetch',
  hasBody: true, bodyPreview: '{"note":"done"}', bodyShape: 'json:note', fingerprint: 'POST app.example.com/api/items/{id}/close json:note',
  lastUiActions: [{ ts: 0, type: 'click', tag: 'button', name: 'Close issue', url: 'https://app.example.com/i/42' }],
});

const fetchOk = (body: unknown, status = 200) => vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));

describe('buildJudgeState', () => {
  it('exposes structured metadata only and the path template', () => {
    const s = buildJudgeState(rec());
    expect(s).toMatchObject({ method: 'POST', host: 'app.example.com', pathTemplate: '/api/items/{id}/close', bodyShape: 'json:note', queryKeys: ['x'] });
    expect(s.triggeredBy).toEqual({ type: 'click', element: 'button', name: 'Close issue', formMethod: null });
    expect(JSON.stringify(s)).not.toContain('<html');
  });
  it('redacts typed secrets and token-like segments from the path, as from the template', () => {
    typedSecrets.remember(1, 'f#0', 'Hunter2-pass!');
    try {
      const r = { ...rec(), url: 'https://app.example.com/api/reset/Hunter2-pass!/confirm/9f8c2b1aE4d7Xk3Lq0ZpR7', path: '/api/reset/Hunter2-pass!/confirm/9f8c2b1aE4d7Xk3Lq0ZpR7', fingerprint: 'POST app.example.com/api/reset/Hunter2-pass!/confirm/{id} json:note' };
      const s = buildJudgeState(r);
      expect(s.path).toBe('/api/reset/[redacted]/confirm/[redacted]');
      expect(s.pathTemplate).toBe('/api/reset/[redacted]/confirm/{id}');
    } finally { typedSecrets.forget(1); }
  });
  it('question text names the read/write boundary explicitly', () => {
    expect(WRITE_QUESTION).toMatch(/Telemetry/);
    expect(WRITE_QUESTION).toMatch(/mutation/);
  });
});

describe('JevJudge', () => {
  it('asks the read-tracking question only when read tracking is allowed, one question either way', async () => {
    const f = fetchOk({ answers: { write: { type: 'noul', noul: 0.1 } } });
    const j = new JevJudge({ apiKey: 'k', fetchImpl: f as unknown as typeof fetch });
    await j.classify(rec());
    await j.classify(rec(), { readTracking: false });
    await j.classify(rec(), { readTracking: true });
    const asked = f.mock.calls.map((c) => JSON.parse((c as unknown as [string, RequestInit])[1].body as string).questions);
    expect(asked.map((q) => Object.keys(q))).toEqual([['write'], ['write'], ['write']]);
    expect(asked.map((q) => q.write.instructions)).toEqual([WRITE_QUESTION, WRITE_QUESTION, READ_TRACKING_QUESTION]);
    // Unclear stays a write: the read-tracking question says so in as many words.
    expect(READ_TRACKING_QUESTION).toMatch(/whose body does not show which, IS a write/);
  });

  it('honours an explicit endpoint (OpenRouter serves System One at /api/v1/systemone)', async () => {
    const f = fetchOk({ model: 'typesafe/jev-latest', answers: { write: { type: 'noul', noul: 0.4 } } });
    const j = new JevJudge({ apiKey: 'or', endpoint: 'https://openrouter.ai/api/v1/systemone', model: 'typesafe/jev-latest', fetchImpl: f as unknown as typeof fetch });
    const r = await j.classify(rec());
    expect(r.pWrite).toBe(0.4);
    const [url, init] = f.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe('https://openrouter.ai/api/v1/systemone');
    expect(JSON.parse(init.body as string).model).toBe('typesafe/jev-latest');
  });

  it('posts the TypeSafe shape to the gateway and returns the noul probability', async () => {
    const f = fetchOk({ model: 'typesafe-ai/jev', answers: { write: { type: 'noul', noul: 0.93 } }, usage: { input_tokens: 120, output_tokens: 0 } });
    const j = new JevJudge({ apiKey: 'k', baseUrl: 'https://gw.example', fetchImpl: f as unknown as typeof fetch });
    const r = await j.classify(rec());
    expect(r.pWrite).toBe(0.93);
    expect(r.model).toBe('typesafe-ai/jev');
    const [url, init] = f.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe('https://gw.example/typesafe/v1/systemone');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer k');
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('typesafe-ai/jev');
    expect(body.questions.write).toEqual({ type: 'noul', instructions: WRITE_QUESTION });
    expect(body.state.pathTemplate).toBe('/api/items/{id}/close');
  });
  it('throws on HTTP errors with the gateway message', async () => {
    const f = fetchOk({ error: { message: 'AI Gateway requires a valid credit card on file', type: 'customer_verification_required' } }, 403);
    const j = new JevJudge({ apiKey: 'k', fetchImpl: f as unknown as typeof fetch });
    await expect(j.classify(rec())).rejects.toThrow(/jev http 403: AI Gateway requires/);
  });
  it('throws when the probability is missing or out of range', async () => {
    const j1 = new JevJudge({ apiKey: 'k', fetchImpl: fetchOk({ answers: {} }) as unknown as typeof fetch });
    await expect(j1.classify(rec())).rejects.toThrow(/no probability/);
    const j2 = new JevJudge({ apiKey: 'k', fetchImpl: fetchOk({ answers: { write: { type: 'noul', noul: 1.7 } } }) as unknown as typeof fetch });
    await expect(j2.classify(rec())).rejects.toThrow(/no probability/);
  });
  it('uses the global fetch when none is injected, without detaching it', async () => {
    const original = globalThis.fetch;
    const calls: unknown[] = [];
    // A receiver-checking fetch: mimics the browser, which throws when `this` is not the global.
    function strictFetch(this: unknown, ...args: unknown[]) {
      if (this !== globalThis && this !== undefined) throw new TypeError('Illegal invocation');
      calls.push(args);
      return Promise.resolve(new Response(JSON.stringify({ answers: { write: { type: 'noul', noul: 0.12 } } }), { status: 200 }));
    }
    globalThis.fetch = strictFetch as unknown as typeof fetch;
    try {
      const r = await new JevJudge({ apiKey: 'k' }).classify(rec());
      expect(r.pWrite).toBe(0.12);
      expect(calls.length).toBe(1);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('judge question', () => {
  it('treats marking as read or seen as a write, matching the policy', () => {
    expect(WRITE_QUESTION).toMatch(/read or seen.*ARE writes/);
    expect(WRITE_QUESTION).toMatch(/consent choices and device status reports are NOT writes/);
    expect(WRITE_QUESTION).toMatch(/a mutation that only tracks, logs or reports presence or typing is NOT a write/);
    expect(WRITE_QUESTION).toMatch(/Carts, choosing a store, and anything that sends an email or notification ARE writes/);
    expect(WRITE_QUESTION).not.toMatch(/read-tracking are NOT/);
    expect(WRITE_QUESTION).toMatch(/Signing in, signing out and refreshing a session are NOT writes; creating an account IS a write/);
  });
});

describe('form previews keep the whole request in view', () => {
  it('cuts long form values like JSON strings, so a later field stays inside the preview', () => {
    const body = `__csr=${'x'.repeat(800)}&__hsdp=${'y'.repeat(700)}&__hblp=${'z'.repeat(650)}&fb_api_req_friendly_name=CometUFIFeedbackReactMutation`;
    const { preview, truncated } = previewBody('application/x-www-form-urlencoded', body);
    expect(preview).toContain('fb_api_req_friendly_name=CometUFIFeedbackReactMutation');
    expect(preview!.length).toBeLessThan(400);
    expect(truncated).toBe(true);
  });
  it('still redacts secret-named values', () => {
    expect(previewBody('application/x-www-form-urlencoded', 'user=ana&password=hunter2&csrf_token=abc').preview).toBe('user=ana&password=[redacted]&csrf_token=[redacted]');
  });
});
