// The extension's own fingerprinting, served to the Python harness over stdin/stdout, so there is one
// implementation (extension/src/background/fingerprint.ts and codecs/) instead of a Python mirror.
// harness/lib/fingerprint.py starts this once per process and sends one JSON request per line:
//   {"op":"fp", "method", "url", "contentType", "body", "hasBody"}  → {host, path, queryKeys, template, shape, fingerprint}
//   {"op":"obs", "obs": {method, url, bodyPreview, bodyFull}}       → {fingerprint}  (a webRequest observation)
//   {"op":"constants"}                                              → {SAFE_METHODS, QUERY_DISCRIMINATOR_KEYS}
// Each request gets exactly one response line; an error answers {"error": "…"}.
import readline from 'node:readline';
import { fingerprint, QUERY_DISCRIMINATOR_KEYS } from '../../extension/src/background/fingerprint';

const SAFE_METHODS = ['GET', 'HEAD', 'OPTIONS'];

function fp(method: string, url: string, contentType: string | null | undefined, body: string | null | undefined, hasBody: boolean) {
  return fingerprint(method, url, contentType ?? undefined, body ?? undefined, hasBody);
}

/** Best-effort fingerprint from a webRequest observation, which has no content-type header. */
function observation(obs: { method?: string; url: string; bodyPreview?: string | null; bodyFull?: string | null }): string {
  const method = obs.method ?? 'GET';
  // Prefer the full body the dev sink captured when the preview was truncated: the live extension fingerprints
  // the full body, and a 2 KB preview of a JSON body is not parseable.
  const preview = obs.bodyFull ?? obs.bodyPreview ?? undefined;
  const hasBody = preview != null && !SAFE_METHODS.includes(method.toUpperCase());
  if (hasBody && preview!.trimStart().startsWith('--') && preview!.includes('Content-Disposition: form-data')) {
    return fp(method, obs.url, 'multipart/form-data', preview, true).fingerprint;
  }
  if (hasBody && preview!.startsWith('{') && preview!.includes('"')) {
    // webRequest formData is serialised as {"field": ["value"]} by the observer: a form when every value is a list.
    try {
      const parsed = JSON.parse(preview!) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const entries = Object.entries(parsed as Record<string, unknown>);
        if (entries.length && entries.every(([, v]) => Array.isArray(v))) {
          const form = new URLSearchParams(entries.map(([k, vs]) => [k, (vs as unknown[]).length ? String((vs as unknown[])[0]) : '']));
          return fp(method, obs.url, 'application/x-www-form-urlencoded', form.toString(), true).fingerprint;
        }
      }
    } catch { /* not JSON */ }
  }
  return fp(method, obs.url, undefined, preview, hasBody).fingerprint;
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let out: unknown;
  try {
    const r = JSON.parse(line);
    if (r.op === 'fp') out = fp(r.method, r.url, r.contentType, r.body, Boolean(r.hasBody));
    else if (r.op === 'obs') out = { fingerprint: observation(r.obs) };
    else if (r.op === 'constants') out = { SAFE_METHODS, QUERY_DISCRIMINATOR_KEYS };
    else out = { error: `unknown op ${String(r.op)}` };
  } catch (err) {
    out = { error: err instanceof Error ? err.message : String(err) };
  }
  process.stdout.write(JSON.stringify(out) + '\n');
});
