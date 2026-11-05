import { decodeShape } from './codecs/index';
import { QUERY_VOLATILE } from './query-schema.generated';
// Endpoint fingerprinting: method + host + path template + body shape.
// Pure functions; the single implementation (the Python harness calls it through harness/lib/fp_cli.mts).
// Vectors: extension/fingerprint.vectors.json and codecs/<name>.vectors.json.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX = /^[0-9a-f]{16,}$/i;
const TOKEN = /^[A-Za-z0-9_-]{20,}$/;

const BODY_PREVIEW_MAX = 2048;
/** Methods that do not change state: their fingerprints carry only the operation-selecting query keys. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const STRING_VALUE_MAX = 64;

/** Replace id-like path segments with {id}: digits, UUIDs, long hex, long mixed tokens. */
export function pathTemplate(path: string): string {
  return path
    .split('/')
    .map((seg) => {
      if (!seg) return seg;
      if (/^\d+$/.test(seg)) return '{id}';
      if (UUID.test(seg)) return '{id}';
      if (HEX.test(seg)) return '{id}';
      if (TOKEN.test(seg) && /[A-Za-z]/.test(seg) && /\d/.test(seg)) return '{id}';
      return seg;
    })
    .join('/');
}

function mediaType(contentType: string | undefined): string {
  return (contentType ?? '').split(';')[0]!.trim().toLowerCase();
}

function isGqlOp(v: unknown): v is { query: string; operationName?: string } {
  return typeof v === 'object' && v !== null && typeof (v as { query?: unknown }).query === 'string';
}

export interface GqlOperation {
  kind: 'query' | 'mutation' | 'subscription';
  /** '' when anonymous. */
  name: string;
  /** The tokens directly in the operation's top selection set, outside arguments and nested selections: one plain
   *  root field is `[field]`; an alias, a directive or a spread adds tokens. */
  root: string[];
}

const GQL_TOKEN = /"""(?:\\"""|[\s\S])*?"""|"(?:[^"\\\n\r]|\\.)*"|#[^\n\r]*|[A-Za-z_][A-Za-z0-9_]*|[^\s,]/g;

/** The definition a top-level selection set opens, from the words before it: an operation, null for a fragment, or
 *  undefined for anything else (a schema definition, an unknown keyword). No words is the anonymous query `{ … }`. */
function definition(head: string[], root: string[]): GqlOperation | null | undefined {
  const [kw, name] = head;
  if (kw === undefined) return { kind: 'query', name: '', root };
  if (kw === 'query' || kw === 'mutation' || kw === 'subscription') return { kind: kw, name: /^[A-Za-z_]\w*$/.test(name ?? '') ? name! : '', root };
  return kw === 'fragment' ? null : undefined;
}

/** A GraphQL document's tokens outside arguments and variable definitions (`(…)`), comments dropped. Undefined for an
 *  unterminated string or unbalanced parentheses. */
function gqlTopTokens(doc: string): string[] | undefined {
  const out: string[] = [];
  let parens = 0;
  for (const [t] of doc.matchAll(GQL_TOKEN)) {
    if (t === '"') return undefined; // an unterminated string
    if (t === '(') parens++;
    else if (t === ')') { if (--parens < 0) return undefined; }
    else if (parens === 0 && !t.startsWith('#')) out.push(t);
  }
  return parens === 0 ? out : undefined;
}

const BRACE_STEP = new Map([['{', 1], ['}', -1]]);

/** A document's top-level definitions: the words before each top-level selection set, and the tokens directly in it.
 *  Undefined when the braces do not balance or words follow the last one. */
function gqlDefinitions(tokens: string[]): { head: string[]; root: string[] }[] | undefined {
  const defs: { head: string[]; root: string[] }[] = [];
  const head: string[] = [];
  let depth = 0;
  for (const t of tokens) {
    const step = BRACE_STEP.get(t);
    if (step === undefined) {
      [head, defs.at(-1)?.root][depth]?.push(t); // words between definitions, or directly in one's selection set
      continue;
    }
    depth += step;
    if (depth < 0) return undefined;
    if (step === 1 && depth === 1) defs.push({ head: head.splice(0), root: [] });
  }
  return depth === 0 && !head.length ? defs : undefined;
}

/** The operations a GraphQL document defines (fragments left out). Undefined when it cannot be read as a list of
 *  operation and fragment definitions: unbalanced, a schema definition, an unknown keyword, an unterminated string. */
export function gqlOperations(doc: string): GqlOperation[] | undefined {
  const tokens = gqlTopTokens(doc);
  const defs = tokens && gqlDefinitions(tokens);
  if (!defs) return undefined;
  const ops: GqlOperation[] = [];
  for (const { head, root } of defs) {
    const d = definition(head, root);
    if (d === undefined) return undefined;
    if (d) ops.push(d);
  }
  return ops;
}

/** The kind of operation a GraphQL request runs. A server runs the operation operationName names (or the only one),
 *  so the kind is that operation's own, not the first keyword in the document: `query Pad {…} mutation Search {…}`
 *  with operationName Search is a mutation. Several operations with no single one named, an operationName the only
 *  operation does not carry, or a document that cannot be read: `unknown`. */
function gqlOperation(query: string, operationName?: unknown): string {
  const ops = gqlOperations(query);
  if (!ops?.length) return 'unknown';
  const named = typeof operationName === 'string' && operationName !== '' ? ops.filter((o) => o.name === operationName) : ops;
  return named.length === 1 ? named[0]!.kind : 'unknown';
}

function sortedKeys(o: object): string {
  return Object.keys(o).sort().join(',');
}

/** Keys whose short enum-like value decides what a single-endpoint RPC call does. */
const DISCRIMINATOR_KEYS = ['op', 'action', 'method', 'operation', 'type', 'cmd', 'command', 'event', 'mode', 'intent'];
const ENUM_VALUE = /^[A-Za-z0-9_.:/-]{1,32}$/;

/** A discriminator's value as the fingerprint shows it: short names, integers and booleans as they are;
 *  anything else that is present (spaces, long text, objects, lists) is `?`, an operation the fingerprint
 *  cannot name, so a cached allow is never reused for it. Null or absent: no discriminator. */
function discriminatorValue(v: unknown): string | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v === 'string') return ENUM_VALUE.test(v) ? v : '?';
  if (typeof v === 'number') return Number.isSafeInteger(v) ? String(v) : '?';
  if (typeof v === 'boolean') return String(v);
  return '?';
}

function discriminators(o: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const k of DISCRIMINATOR_KEYS) {
    const v = discriminatorValue(o[k]);
    if (v !== undefined) parts.push(`${k}=${v}`);
  }
  return parts.length ? ';' + parts.join(';') : '';
}

const TYPE_LETTER: Record<string, string> = { object: 'o', string: 's', number: 'd', boolean: 'b' };
/** n null, a array, o object, s string, d number, b bool, ? anything else. */
function typeLetter(x: unknown): string {
  if (x === null) return 'n';
  if (Array.isArray(x)) return 'a';
  return TYPE_LETTER[typeof x] ?? '?';
}

/** One letter per top-level array element (see typeLetter); `+` when there are more than `max`. */
function arraySignature(v: unknown[], max = 12): string {
  const sig = v.slice(0, max).map(typeLetter).join('');
  return v.length > max ? sig + '+' : sig;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** A batch of objects: one signature per distinct kind of entry (its keys and its discriminators), so a
 *  write anywhere in the batch changes the fingerprint and each operation stays with its own entry.
 *  Entries past the inspection limit are marked unknown (`more=?`). */
function objectArrayShape(v: Record<string, unknown>[], max = 12): string {
  const entries = new Set<string>();
  for (const o of v.slice(0, max)) entries.add(`${sortedKeys(o)}${discriminators(o)}`);
  const parts = [...entries].sort();
  if (v.length > max) parts.push('more=?');
  return `json[]:${parts.join('|')}`;
}

/** Query parameters that select the operation (`?action=delete`) and so belong in the fingerprint.
 *  A repeated selector is `?` (unknown): servers differ on whether the first or the last value wins, so no
 *  one reading of it is safe. So is a value too long or odd to be an operation name. */
export const QUERY_DISCRIMINATOR_KEYS = [...DISCRIMINATOR_KEYS, 'rpcids'];
const QUERY_VALUE = /^[A-Za-z0-9_.:/,-]{1,64}$/;

export function queryDiscriminators(params: URLSearchParams): string {
  const parts: string[] = [];
  for (const k of [...QUERY_DISCRIMINATOR_KEYS].sort()) {
    const vals = params.getAll(k);
    if (!vals.length) continue;
    parts.push(vals.length === 1 && QUERY_VALUE.test(vals[0]!) ? `${k}=${vals[0]}` : `${k}=?`);
  }
  return parts.length ? '?' + parts.join('&') : '';
}

/** Word-like query values a write's fingerprint keeps as they are (LinkedIn's dotted component names). */
const WRITE_QUERY_VALUE = /^[A-Za-z0-9_.:/,-]{1,128}$/;

/** A query value as a write's fingerprint shows it. Nothing is folded because of how it looks: `action=1`
 *  and `action=2` can be different operations, so a number is kept like any other word-like value (up to
 *  128 characters). Only a reviewed schema folds a key (queryShape). A secret-named key's value, an email,
 *  or anything else that cannot be shown is `?` (unknown): never stored, never matched by a saved verdict. */
function queryValueShape(k: string, v: string): string {
  if (v === '') return '';
  if (SECRET_KEY.test(k)) return '?';
  return WRITE_QUERY_VALUE.test(v) ? v : '?';
}

/** The query as a write's fingerprint shows it: every key, each with its value's shape. No generic list
 *  of selector names is complete (`?procedure=delete`), and no spelling proves a value is only an id
 *  (`action=2`), so a request that can change state carries all of its query values. The only values
 *  left out are those of keys a verified site's reviewed schema lists as volatile for this endpoint
 *  (tokens, counters, record ids: `k={v}`, apps/<app>/query-schema.json). A repeated key is `?`. */
export function queryShape(params: URLSearchParams, endpoint = ''): string {
  const keys = [...new Set(params.keys())].sort();
  if (!keys.length) return '';
  const volatile = QUERY_VOLATILE[endpoint] ?? [];
  return '?' + keys.map((k) => {
    if (volatile.includes(k)) return `${k}={v}`;
    const vals = params.getAll(k);
    return `${k}=${vals.length === 1 ? queryValueShape(k, vals[0]!) : '?'}`;
  }).join('&');
}

/** True when the fingerprint marks part of the operation as unknown: a cached allow must not be reused. */
export function hasUnknownPart(fp: string): boolean {
  return fp.includes('=?');
}

function jsonShape(v: unknown): string {
  if (Array.isArray(v)) {
    if (v.length > 0 && v.every(isGqlOp)) return `gql[]:${v.map((o) => gqlOperation(o.query, o.operationName)).join(',')}`;
    if (v.length > 0 && v.every(isPlainObject)) return objectArrayShape(v);
    // Positional arrays (Google-style RPC bodies): the type signature is the only structure there is.
    // Without it, a sync poll [null,null,[…]] and a draft write [null,[[…]]] share one fingerprint.
    return `json[]:${arraySignature(v)}`;
  }
  if (v !== null && typeof v === 'object') {
    if (isGqlOp(v)) return `gql:${gqlOperation(v.query, v.operationName)}:${v.operationName ?? '-'}`;
    return `json:${sortedKeys(v)}${discriminators(v as Record<string, unknown>)}`;
  }
  return `json:${typeof v}`;
}

/**
 * Structural summary of a request body. Never includes values.
 *  none | opaque | multipart | json:<keys>[;k=v…] | json[]:<keys> | gql:<op>:<name> | gql[]:<ops> | form:<fields> | ct:<type>
 * For JSON objects, short enum-like values of well-known discriminator keys (op, action,
 * method, …) are appended so single-endpoint RPC reads and writes get distinct fingerprints.
 */
/** form:<fields>[;k=v…]. A field whose value is JSON (Google's f.req, batchexecute) contributes its own
 *  shape (`f.req=json[]:aa`), and enum-like discriminator fields (action=restore) are appended like for JSON,
 *  so one endpoint that multiplexes operations through a form field does not collapse onto one fingerprint. */
/** A numbered form field is one field: `route_urls[0]`, `route_urls[1]` → `route_urls[]`. Otherwise every
 *  different count of items is a new shape, and one operation gets dozens of fingerprints. */
function formFieldName(k: string): string {
  return k.replace(/\[\d+\]/g, '[]');
}

function formShape(pairs: [string, string][]): string {
  const first = new Map<string, string>();
  const seen = new Map<string, number>();
  for (const [raw, v] of pairs) { const k = formFieldName(raw); if (!first.has(k)) first.set(k, v); seen.set(k, (seen.get(k) ?? 0) + 1); }
  const fields = [...first.keys()].sort().map((k) => {
    const v = first.get(k)!.trim();
    if ((v.startsWith('[') || v.startsWith('{')) && v.length > 1) {
      try {
        const j: unknown = JSON.parse(v);
        if (Array.isArray(j)) return `${k}=json[]:${arraySignature(j)}`;
        if (j && typeof j === 'object') return `${k}=json:${Object.keys(j as object).sort().join('+')}`;
      } catch { /* not JSON: plain field */ }
    }
    return k;
  });
  // A discriminator field that is repeated or not a short name is unknown (`?`), as in the query string.
  const disc = DISCRIMINATOR_KEYS.filter((k) => first.has(k)).map((k) => `${k}=${seen.get(k) === 1 && ENUM_VALUE.test(first.get(k)!) ? first.get(k) : '?'}`);
  return `form:${fields.join(',')}${disc.length ? ';' + disc.join(';') : ''}`;
}

export function bodyShape(contentType: string | undefined, body: string | undefined, hasBody: boolean): string {
  if (!hasBody) return 'none';
  const ct = mediaType(contentType);
  if (ct === 'multipart/form-data') return 'multipart';
  if (body === undefined) return 'opaque';
  if (ct === 'application/graphql') return `gql:${gqlOperation(body)}:-`;
  if (ct === 'application/x-www-form-urlencoded') {
    return formShape([...new URLSearchParams(body).entries()]);
  }
  if (ct === '' || ct.includes('json') || ct === 'text/plain') {
    try {
      return jsonShape(JSON.parse(body));
    } catch {
      /* not JSON */
    }
  }
  return ct ? `ct:${ct}` : 'opaque';
}

/** Keys whose values are credentials or one-time secrets. Never stored, never sent to a judge. */
export const SECRET_KEY = /(pass(word)?|passwd|pwd|passcode|^pin$|secret|token|api[-_]?key|access[-_]?key|private[-_]?key|authorization|auth[-_]?code|^code$|otp|totp|mfa|session[-_]?id|cookie|credential|refresh|id[-_]?token|assertion|signature|nonce|csrf|xsrf|cvv|cvc|card[-_]?number|security[-_]?code|^pan$|cc[-_]?num)/i;
const REDACTED = '[redacted]';

/** A run that looks like a credential or an opaque id, whatever its field is called: 16+ characters of
 *  letters, digits and token punctuation, with both letters and digits, switching often between lower case,
 *  upper case and digits (random strings do, words and names do not). Catches CSRF and session tokens,
 *  UUIDs, hex and base64 ids, JWT parts and API keys; keeps CometUFIFeedbackReactMutation, markSeen,
 *  plain numbers (ids, timestamps) and dotted names (only a hash segment of one is replaced). */
function isTokenLike(run: string): boolean {
  if (run.length < 16 || !/\d/.test(run) || !/[A-Za-z]/.test(run)) return false;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(run) || /^[0-9a-f]{16,}$/i.test(run)) return true;
  const cls = (c: string) => (/\d/.test(c) ? 'd' : /[a-z]/.test(c) ? 'l' : /[A-Z]/.test(c) ? 'u' : '');
  let switches = 0, prev = '';
  for (const c of run) { const k = cls(c); if (!k) continue; if (prev && k !== prev) switches++; prev = k; }
  return switches / run.length >= 0.35;
}

/** Every token-like run in a string replaced with [redacted] (see isTokenLike). */
export function redactTokens(text: string): string {
  return text.replace(/[A-Za-z0-9_\-+/=]{16,}/g, (run) => (isTokenLike(run) ? REDACTED : run));
}

function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
}

/** Payment card numbers written in groups (`4111 1111 1111 1111`, `3782-822463-10005`) with a card network's
 *  leading digit and a valid Luhn check. A plain digit run is left alone: ids look the same (Facebook's photo
 *  ids and doc_id pass the check), and a card typed into a card field is removed as a typed value anyway. */
function redactCards(text: string): string {
  return text.replace(/(?<![\d.])\d{4}(?:[ -]\d{4}){3}(?:[ -]?\d{1,3})?(?![\d.])|(?<![\d.])\d{4}[ -]\d{6}[ -]\d{4,5}(?![\d.])/g, (run) => {
    const d = run.replace(/[ -]/g, '');
    return /^[3456]/.test(d) && luhn(d) ? REDACTED : run;
  });
}

const KEEP_VALUE = /^(true|false|null|undefined|)$/i;
/** Secrets named in free text, whatever the format: `password: x`, `"otp":"x"`, `pwd=x`, `login(password: "x")`,
 *  `password="x"` (an XML attribute) and `<Password>x</Password>`. For bodies (or parts of them) the parsers
 *  don't read: broken JSON, XML, GraphQL written inline, plain text. */
function redactNamedSecrets(text: string): string {
  const pairs = text.replace(/(^|[^\w-])(["']?)([A-Za-z_][\w-]{0,40})\2(\s*(?::|=>|=)\s*)("(?:[^"\\]|\\.)*"|'[^']*'|[^\s,;&)}\]<"']+)/g,
    (m, pre: string, q: string, name: string, sep: string, value: string) => {
      if (!SECRET_KEY.test(name)) return m;
      const quote = /^["']/.test(value) ? value[0]! : '';
      if (KEEP_VALUE.test(quote ? value.slice(1, -1) : value)) return m;
      return `${pre}${q}${name}${q}${sep}${quote}${REDACTED}${quote}`;
    });
  return pairs.replace(/<([\w:.-]+)([^>]*)>([^<]+)<\/\1>/g, (m, tag: string, attrs: string, value: string) =>
    SECRET_KEY.test(tag.split(':').pop()!) && !KEEP_VALUE.test(value.trim()) ? `<${tag}${attrs}>${REDACTED}</${tag}>` : m);
}

/** One value's secrets: token-like runs, card numbers, and secrets named inside it (a GraphQL query string). */
function redactValue(text: string): string {
  return redactNamedSecrets(redactCards(redactTokens(text)));
}

/** Every encoding a typed value can travel in: raw, URL-encoded (with + or %20 for spaces, once or twice, as
 *  Google's f.req does), JSON-escaped and both, and base64. URL encoding comes as encodeURIComponent writes it
 *  and as forms and URLSearchParams write it (`! ' ( ) ~` escaped too), with upper- and lower-case escapes. */
function encodings(value: string): string[] {
  const json = JSON.stringify(value).slice(1, -1);
  const url = (t: string) => {
    const uri = encodeURIComponent(t);
    const form = uri.replace(/[!'()~]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
    const forms = [uri, form].flatMap((e) => [e, e.replace(/%20/g, '+')]);
    return [...forms, ...forms.map((e) => e.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase()))];
  };
  const once = [value, json, ...url(value), ...url(json)];
  let b64: string[] = [];
  try { b64 = [btoa(String.fromCharCode(...new TextEncoder().encode(value)))]; } catch { /* not encodable */ }
  return [...new Set([...once, ...once.flatMap((t) => url(t)), ...b64])].sort((a, b) => b.length - a.length);
}

/** Whether a typed value is scrubbed at all. Under 4 characters it would hit too much; letters alone could be
 *  a word the judge needs ("delete", "archive"): an agent told to type one into a password field must not
 *  blind the judge to it. (A weak letters-only password then reaches the judge: the smaller harm.) */
function scrubbable(value: string): boolean {
  return value.length >= 4 && !/^\p{L}+$/u.test(value);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Before a whole value: the start, a character that is not a letter or digit, or an escape (`%22`, `%2522`). */
const BEFORE = '(?:(?<![\\p{L}\\p{N}])|(?<=%[0-9A-Fa-f]{2})|(?<=%25[0-9A-Fa-f]{2}))';
const AFTER = '(?![\\p{L}\\p{N}])';

/** The values the person typed into password, one-time-code and card fields (typed-secrets.ts), removed from a
 *  body in any encoding before anything else reads it, but only where one stands whole (inside quotes, after
 *  `=`, between separators), never as part of a longer word. See `scrubbable` for the values skipped. */
export function scrubKnown(text: string, known: readonly string[]): string {
  let out = text;
  for (const v of known) {
    if (!scrubbable(v)) continue;
    for (const e of encodings(v)) {
      if (!out.includes(e)) continue;
      const before = /^[\p{L}\p{N}]/u.test(e) ? BEFORE : '';
      const after = /[\p{L}\p{N}]$/u.test(e) ? AFTER : '';
      out = out.replace(new RegExp(`${before}${escapeRe(e)}${after}`, 'gu'), REDACTED);
    }
  }
  return out;
}

/** multipart/form-data: each part's content redacted by its name (a secret-named part entirely), parsed as
 *  JSON or form encoding when it is one, and a file part reduced to its size. Boundaries and part headers are
 *  kept, so the body reads as before. Undefined when there is no boundary to split on. */
function redactMultipart(contentType: string | undefined, body: string): string | undefined {
  const boundary = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType ?? '');
  const b = boundary?.[1] ?? boundary?.[2];
  if (!b) return undefined;
  const delim = `--${b}`;
  return body.split(delim).map((part, i) => {
    if (i === 0 || part.startsWith('--')) return part;
    const sep = part.indexOf('\r\n\r\n') >= 0 ? '\r\n\r\n' : '\n\n';
    const at = part.indexOf(sep);
    if (at < 0) return part;
    const head = part.slice(0, at);
    const content = part.slice(at + sep.length).replace(/\r?\n$/, '');
    const name = /\bname="([^"]*)"/i.exec(head)?.[1] ?? '';
    let value: string;
    if (/\bfilename=/i.test(head)) value = `[file, ${content.length} bytes]`;
    else if (SECRET_KEY.test(name) && content) value = REDACTED;
    else value = redactPart(content);
    return `${head}${sep}${value}\r\n`;
  }).join(delim);
}

function redactPart(content: string): string {
  try { return JSON.stringify(redactJsonValue(JSON.parse(content))); } catch { /* not JSON */ }
  if (FORM_LIKE.test(content)) return redactFormLike(content);
  const r = redactValue(content);
  return r.length > STRING_VALUE_MAX ? r.slice(0, STRING_VALUE_MAX) + '…' : r;
}

/** Looks like key=value[&…] (form or query encoding). Same language as the former
 *  /^[^\s=&]+=[^\s]*(&[^\s=&]+=[^\s]*)*$/ (the group adds nothing once \S* can take `&`), without its nested
 *  repetition, which backtracks exponentially on a body that ends in whitespace. */
const FORM_LIKE = /^[^\s=&]+=\S*$/;

function decodeFormPart(s: string): string {
  try { return decodeURIComponent(s.replace(/\+/g, ' ')); } catch { return s; }
}

/** key=value pairs (form-urlencoded, query strings): secret values redacted, and long values cut like JSON
 *  strings (STRING_VALUE_MAX), so a few long opaque fields cannot push the rest out of the preview (Facebook
 *  names its operation after three fields of 600–850 characters). */
function redactFormLike(text: string): string {
  // A key starts only at the beginning or after & ? = or whitespace, where the unanchored pattern's matches
  // started anyway; unanchored, a large body with no `=` (Google's /log sends JSON as a form) rescanned to the
  // end from every position, quadratic (a 338 KB body took a minute).
  return text.replace(/(^|[&?=\s])([^&=?\s]+)=([^&\s]*)/g, (m, sep: string, k: string, v: string) => {
    if (SECRET_KEY.test(decodeFormPart(k)) && v) return `${sep}${k}=${REDACTED}`;
    const raw = decodeFormPart(v);
    const value = redactNestedValue(raw);
    if (value.length > STRING_VALUE_MAX) return `${sep}${k}=${encodeURIComponent(value.slice(0, STRING_VALUE_MAX))}…`;
    return value === raw ? m : `${sep}${k}=${encodeURIComponent(value)}`;
  });
}

/** A parsed JSON body with secrets redacted (by key name, and by value), strings truncated and arrays capped at
 *  20 entries. Keys are kept. A secret key's value is redacted inside nested arrays too. */
function redactJsonValue(v: unknown, key?: string): unknown {
  if (typeof v === 'string') {
    if (key !== undefined && SECRET_KEY.test(key)) return REDACTED;
    const r = redactNestedValue(v);
    return r.length > STRING_VALUE_MAX ? r.slice(0, STRING_VALUE_MAX) + '…' : r;
  }
  if (Array.isArray(v)) return v.slice(0, 20).map((x) => redactJsonValue(x, key));
  if (v !== null && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactJsonValue(x, k)]));
  return v;
}

/** A string value that may itself hold JSON (Google's f.req holds JSON arrays inside a form field, with
 *  more JSON inside their strings): parsed and redacted as JSON when it is, else redacted as a value. */
function redactNestedValue(text: string): string {
  if (/^\s*[[{]/.test(text)) {
    try { return JSON.stringify(redactJsonValue(JSON.parse(text))); } catch { /* not JSON */ }
  }
  return redactValue(text);
}

/** Body as the judge and the audit log may see it: secrets redacted, strings truncated, total capped. Keys
 *  preserved. `known` are values the person typed into password, one-time-code and card fields: removed first,
 *  in any encoding, whatever the format. */
export function previewBody(contentType: string | undefined, body: string | undefined, known: readonly string[] = []): { preview?: string; truncated: boolean } {
  if (body === undefined) return { truncated: false };
  const ct = mediaType(contentType);
  let text = known.length ? scrubKnown(body, known) : body;
  let parsed = false;
  if (ct === '' || ct.includes('json') || ct === 'text/plain') {
    try {
      text = JSON.stringify(redactJsonValue(JSON.parse(text)));
      parsed = true;
    } catch {
      /* keep raw */
    }
  }
  const multipart = !parsed && ct === 'multipart/form-data' ? redactMultipart(contentType, text) : undefined;
  if (multipart !== undefined) {
    text = multipart;
  } else if (!parsed && (ct === 'application/x-www-form-urlencoded' || FORM_LIKE.test(text))) {
    text = redactFormLike(text);
  } else if (!parsed) {
    text = redactValue(text);
  }
  const truncated = text.length > BODY_PREVIEW_MAX || text !== body;
  return { preview: text.length > BODY_PREVIEW_MAX ? text.slice(0, BODY_PREVIEW_MAX) + '…' : text, truncated };
}

/** Like previewBody, but only for bodies the redactor understands (JSON, or form/query encoding). Anything
 *  else (multipart bytes, truncated JSON, free text) could carry a secret the redactor cannot find, so it
 *  is dropped: undefined, not the raw text. For bodies kept at rest (observations). */
export function strictPreview(contentType: string | undefined, body: string | undefined): string | undefined {
  if (body === undefined) return undefined;
  const ct = mediaType(contentType);
  if (ct === 'multipart/form-data') return undefined;
  let json = false;
  try { JSON.parse(body); json = true; } catch { /* not JSON */ }
  const form = !json && (ct === 'application/x-www-form-urlencoded' || FORM_LIKE.test(body));
  if (!json && !form) return undefined;
  const { preview } = previewBody(json ? 'application/json' : 'application/x-www-form-urlencoded', body);
  return preview;
}

export interface Fingerprinted {
  host: string;
  path: string;
  queryKeys: string[];
  template: string;
  shape: string;
  fingerprint: string;
}

export function fingerprint(method: string, url: string, contentType: string | undefined, body: string | undefined, hasBody: boolean): Fingerprinted {
  const u = new URL(url);
  const host = u.hostname.toLowerCase();
  const template = pathTemplate(u.pathname);
  const decoded = decodeShape(host, template, body, u.searchParams);
  const shape = decoded ?? bodyShape(contentType, body, hasBody);
  // A write's fingerprint carries its whole query (see queryShape), unless a site codec already named the
  // operation from the body; reads and decoded requests carry only the operation-selecting keys.
  const query = decoded !== undefined || SAFE_METHODS.has(method.toUpperCase()) ? queryDiscriminators(u.searchParams) : queryShape(u.searchParams, host + template);
  return {
    host,
    path: u.pathname,
    queryKeys: [...new Set([...u.searchParams.keys()])].sort(),
    template,
    shape,
    fingerprint: `${method.toUpperCase()} ${host}${template}${query} ${shape}`,
  };
}
