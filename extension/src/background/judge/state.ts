// What a judge is allowed to see. Structured request metadata only: never the page,
// never the response, string values already truncated by previewBody(). Mirrored in
// harness/lib/state.py so offline scoring sees exactly what the extension sends.
import type { RequestRecord } from '../../shared/types';
import { redactTokens, scrubKnown } from '../fingerprint';
import * as typedSecrets from '../typed-secrets';

export { READ_TRACKING_QUESTION, WRITE_QUESTION, questionFor } from './questions';

interface JudgeState {
  method: string;
  host: string;
  path: string;
  pathTemplate: string;
  queryKeys: string[];
  contentType: string | null;
  resourceType: string | null;
  bodyShape: string;
  bodyPreview: string | null;
  bodyTruncated: boolean;
  triggeredBy: { type: string; element: string; name: string | null; formMethod: string | null } | null;
}

export function buildJudgeState(rec: RequestRecord): JudgeState {
  const ui = rec.lastUiActions[0];
  return {
    method: rec.method.toUpperCase(),
    host: rec.host,
    // The path and the template (which carries a write's query values) with typed secrets and token-like values
    // redacted before a judge sees them (the path segment by segment, as support.ts maskUrl): a reset or invite token,
    // or an OTP, can be a path segment.
    path: scrubKnown(rec.path, typedSecrets.known()).split('/').map((seg) => redactTokens(seg)).join('/'),
    pathTemplate: redactTokens(scrubKnown(rec.fingerprint.split(' ')[1]?.slice(rec.host.length) ?? rec.path, typedSecrets.known())),
    queryKeys: rec.queryKeys,
    contentType: rec.contentType ?? null,
    resourceType: rec.resourceType ?? null,
    bodyShape: rec.bodyShape,
    bodyPreview: rec.bodyPreview ?? null,
    bodyTruncated: Boolean(rec.bodyTruncated),
    triggeredBy: ui ? { type: ui.type, element: ui.tag, name: ui.name ?? null, formMethod: ui.formMethod ?? null } : null,
  };
}
