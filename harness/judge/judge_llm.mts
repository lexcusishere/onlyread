// Offline second-opinion scorer: sends each labeled endpoint's judge state, with the review model's question and
// instructions (exactly what the extension sends, judge/questions.ts), to Claude and compares with the label.
//
//   node harness/judge/judge_llm.mts apps/gmail [model,model,…]
//   Credentials, first match wins: ANTHROPIC_API_KEY (Anthropic ids, e.g. claude-haiku-4-5),
//   OPENROUTER_API_KEY (slugs, e.g. anthropic/claude-haiku-4.5), AI_GATEWAY_API_KEY (gateway slugs).
//   Keys are read from the environment or ./.env.
//
// Uses the official SDK with default credential resolution (ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN
// or an `ant auth login` profile). Writes apps/<app>/scores.llm.<model>.jsonl.
import fs from 'node:fs';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { JUDGE_SYSTEM, WRITE_QUESTION } from '../../extension/src/background/judge/questions.ts';

const app = process.argv[2] ?? 'apps/gmail';
const models = (process.argv[3] ?? 'claude-haiku-4-5,claude-opus-5').split(',');
/** What the review model's question calls a write: read tracking too (the extension lets it through before the review
 *  model, by its coded checks, when the setting allows; judge_eval.mts measures that path). */
const isWrite = (label: string): boolean => label === 'write' || label === 'read-tracking';

type Label = { fingerprint: string; label: string; sample_url: string; sample_body: string | null; note: string };
const labels: Label[] = fs.readFileSync(path.join(app, 'labels.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
// Representative decision per fingerprint for the trigger context (best effort: latest session).
const sessions = fs.readdirSync(path.join(app, 'sessions')).filter((s) => fs.existsSync(path.join(app, 'sessions', s, 'decisions.jsonl')));
const decisions = sessions.flatMap((s) => fs.readFileSync(path.join(app, 'sessions', s, 'decisions.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)));
// Credentials: a real Anthropic key if present, otherwise the AI Gateway key through the
// gateway's Anthropic-compatible endpoint (which also serves non-Anthropic models by slug).
const envFile = fs.existsSync('.env') ? Object.fromEntries(fs.readFileSync('.env', 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.split('=')[0]!.trim(), l.split('=').slice(1).join('=').trim()])) : {};
const gatewayKey = process.env.AI_GATEWAY_API_KEY ?? envFile.AI_GATEWAY_API_KEY;
const openrouterKey = process.env.OPENROUTER_API_KEY ?? envFile.OPENROUTER_API_KEY;
const client = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN
  ? new Anthropic({ maxRetries: 2 })
  : openrouterKey
    ? new Anthropic({ apiKey: openrouterKey, baseURL: 'https://openrouter.ai/api', maxRetries: 2 })
    : new Anthropic({ apiKey: gatewayKey, baseURL: 'https://ai-gateway.vercel.sh', maxRetries: 2 });
console.log(`provider: ${process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN ? 'anthropic' : openrouterKey ? 'openrouter' : 'vercel-gateway'}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// JUDGE_LLM_PACE_MS: gap between requests (OpenRouter free models allow ~20/min → 3500 is safe).
const PACE_MS = Number(process.env.JUDGE_LLM_PACE_MS ?? (openrouterKey ? 3500 : 400));
const RETRY_MS = Number(process.env.JUDGE_LLM_RETRY_MS ?? 20000);

function state(l: Label) {
  const u = new URL(l.sample_url);
  const [method, rest] = l.fingerprint.split(' ');
  const template = rest!.slice(u.hostname.length).split(' ')[0];
  const d = decisions.find((x) => x.url === l.sample_url && x.lastUiActions?.length) ?? decisions.find((x) => x.url === l.sample_url);
  const ui = d?.lastUiActions?.[0];
  return {
    method, host: u.hostname, path: u.pathname, pathTemplate: template, queryKeys: [...new Set(u.searchParams.keys())].sort(),
    contentType: d?.contentType ?? null, resourceType: d?.resourceType ?? null, bodyShape: l.fingerprint.split(' ').pop(),
    bodyPreview: l.sample_body, bodyTruncated: false,
    triggeredBy: ui ? { type: ui.type, element: ui.tag, name: ui.name ?? null, formMethod: ui.formMethod ?? null } : null,
  };
}

for (const model of models) {
  const rows: unknown[] = [];
  console.log(`\n=== ${model}`);
  for (const l of labels) {
    if (l.label === '?' || l.fingerprint.startsWith('GET ')) continue;
    const t0 = Date.now();
    try {
      // Generous budget: several free-tier models reason before answering and spend tokens on it.
      const req = { model, max_tokens: 2000, system: JUDGE_SYSTEM, messages: [{ role: 'user' as const, content: `${WRITE_QUESTION}\n\nRequest:\n${JSON.stringify(state(l))}` }] };
      // Free tiers rate-limit per minute; on 429 wait and retry a few times instead of losing the row.
      let r!: Anthropic.Message;
      for (let attempt = 0; ; attempt++) {
        try { r = await client.messages.create(req); break; }
        catch (e) {
          if ((e as { status?: number }).status === 429 && attempt < 4) { console.log(`     429, waiting ${RETRY_MS / 1000}s`); await sleep(RETRY_MS); continue; }
          throw e;
        }
      }
      const text = r.content.map((b) => (b.type === 'text' ? b.text : '')).join('').replace(/```(?:json)?/g, '');
      // Take the LAST JSON object in the text: reasoning text may contain braces before the answer.
      const candidates = [...text.matchAll(/\{[^{}]*"pWrite"[^{}]*\}/g)];
      const m = candidates.length ? candidates[candidates.length - 1] : /\{[\s\S]*\}/.exec(text);
      let parsed: { pWrite?: unknown; reason?: unknown } = {};
      try { parsed = m ? JSON.parse(m[0]) : {}; } catch { parsed = {}; }
      if (parsed.pWrite === undefined) console.log(`     raw(${r.stop_reason}, ${r.usage?.output_tokens} out): ${text.slice(0, 160).replace(/\n/g, ' ')}`);
      const p = Number(parsed.pWrite);
      const verdict = p > 0.85 ? 'BLOCK' : p >= 0.3 ? 'review' : 'allow';
      const ok = isWrite(l.label) ? p > 0.85 : p < 0.3;
      rows.push({ fingerprint: l.fingerprint, label: l.label, pWrite: p, reason: parsed.reason, latencyMs: Date.now() - t0, model });
      await sleep(PACE_MS);
      console.log(`${ok ? '✓' : '✗'} ${l.label.padEnd(9)} p=${p.toFixed(2)} ${verdict.padEnd(6)} ${String(Date.now() - t0).padStart(5)}ms  ${l.fingerprint.split(' ', 2)[1]?.slice(0, 40)}  ${l.fingerprint.split(' ').pop()}\n     ${String(parsed.reason).slice(0, 110)}`);
    } catch (e) {
      console.log(`! ${l.fingerprint}: ${(e as Error).message.slice(0, 160)}`);
    }
  }
  const good = rows.filter((r: any) => (isWrite(r.label) ? r.pWrite > 0.85 : r.pWrite < 0.3)).length;
  const writesCaught = rows.filter((r: any) => isWrite(r.label) && r.pWrite > 0.85).length, writes = rows.filter((r: any) => isWrite(r.label)).length;
  const falseBlocks = rows.filter((r: any) => !isWrite(r.label) && r.pWrite > 0.85).length, nonWrites = rows.filter((r: any) => !isWrite(r.label)).length;
  // What the extension would do with this model as the review-band judge: < allow passes, everything else fails closed.
  const stopped = rows.filter((r: any) => isWrite(r.label) && !(r.pWrite < 0.3)).length;
  const passed = rows.filter((r: any) => !isWrite(r.label) && r.pWrite < 0.3).length;
  console.log(`--- ${model}: correct ${good}/${rows.length}; writes caught ${writesCaught}/${writes}; non-writes hard-blocked ${falseBlocks}/${nonWrites}`);
  console.log(`    as review-band judge (fail-closed above 0.30): writes stopped ${stopped}/${writes}; reads passed ${passed}/${nonWrites}`);
  fs.writeFileSync(path.join(app, `scores.llm.${model.replace('/', '_')}.jsonl`), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}
