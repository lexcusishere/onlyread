// Read-tracking requests no decoded shape can name exactly, recognised by their address or body: allowed by rule
// (reason `read-tracking`) only when the person allows read tracking (policy.allowReadTracking), like the shapes a
// site lists in its readTrackingShapes (decision.ts). Each check is exact and fails closed: a body it cannot read,
// or one that does anything more, is not read-tracking and goes on to the site's own rules.
import type { RequestRecord } from '../shared/types';
import { gqlOperations } from './fingerprint';

interface ReadTracking {
  /** What the request records, for the log. */
  name: string;
  test: (rec: Address, body: string | undefined) => boolean;
}

/** Where a request goes: its host, path and full URL (the URL for its query string). */
type Address = Pick<RequestRecord, 'host' | 'path' | 'url'>;
/** Whether the URL carries a query string. A GraphQL server may read the operation from it in place of the body, so a
 *  check that reads only the body requires there be none (the sites' recorded requests have none). */
const hasQuery = (rec: Address) => rec.url.includes('?');
/** Whether an object's keys are exactly these: a key the check does not read (a persisted query's `extensions`, a
 *  stored operation's `documentId`) may make the server run something else. */
const keysAre = (o: Record<string, unknown>, ...keys: string[]) => Object.keys(o).length === keys.length && keys.every((k) => Object.hasOwn(o, k));

const parse = (body: string | undefined): unknown => {
  if (!body) return undefined;
  try { return JSON.parse(body); } catch { return undefined; }
};
const isObj = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/** The queryIds X's `PutClientEducationFlag` has been recorded with (x-battery-1). X runs the operation its queryId
 *  names, whatever name the address carries, so only these are this operation; a new one X ships is judged like any
 *  write until it is added here. */
const X_EDUCATION_FLAG_IDS = new Set(['IjQ-egg0uPkY11NyPMfRMQ']);

/** X: a new-user prompt dismissed (`PutClientEducationFlag`), as X sends it:
 *  `/i/api/graphql/<queryId>/PutClientEducationFlag` with `{"variables":{"flag":"…"},"queryId":"<queryId>"}` and no
 *  query string. X runs the operation its queryId names, so the queryId must be one recorded for this operation
 *  (X_EDUCATION_FLAG_IDS), the body's the address's, and nothing else may be in the body: the name in the address alone
 *  would let any operation's queryId through. */
function xEducationFlag(rec: Address, body: string | undefined): boolean {
  const m = /^\/i\/api\/graphql\/([A-Za-z0-9_-]+)\/PutClientEducationFlag$/.exec(rec.path); // a plain id: no %-escape, no ;suffix
  if (rec.host !== 'x.com' || !m || !X_EDUCATION_FLAG_IDS.has(m[1]!) || hasQuery(rec)) return false;
  const j = parse(body);
  return isObj(j) && keysAre(j, 'variables', 'queryId') && j.queryId === m[1]
    && isObj(j.variables) && keysAre(j.variables, 'flag') && typeof j.variables.flag === 'string';
}

/** GraphQL tokens of a query written plainly: names, `$`, punctuation and simple strings. Undefined for anything else
 *  (comments, block strings, escapes, numbers, spreads, directives, non-ASCII), so a check built on it fails closed. */
function gqlTokens(q: string): string[] | undefined {
  const out: string[] = [];
  const re = /[ \t\r\n,]+|([A-Za-z_][A-Za-z0-9_]*|[$!():{}]|"[^"\\\n\r]*")|([\s\S])/gy;
  for (let m = re.exec(q); m !== null && m.index < q.length; m = re.exec(q)) {
    if (m[2] !== undefined) return undefined;
    if (m[1] !== undefined) out.push(m[1]);
  }
  return out;
}

/** A walk over gqlTokens that throws at the first token out of place. */
class Tokens {
  private p = 0;
  constructor(private readonly t: string[]) {}
  peek(): string | undefined { return this.t[this.p]; }
  done(): boolean { return this.p === this.t.length; }
  take(want?: string): string {
    const v = this.t[this.p++];
    if (v === undefined || (want !== undefined && v !== want)) throw new Error('not the form');
    return v;
  }
  name(): string {
    const v = this.take();
    if (!/^[A-Za-z_]\w*$/.test(v)) throw new Error('not a name');
    return v;
  }
}

/** `($a: Type!, $b: Type!)`: each variable and its type, all non-null named types (no lists), none twice. */
function variableTypes(t: Tokens): Map<string, string> {
  const decl = new Map<string, string>();
  t.take('(');
  while (t.peek() === '$') {
    t.take('$');
    const v = t.name();
    t.take(':');
    const type = t.name();
    t.take('!');
    if (decl.has(v)) throw new Error('declared twice');
    decl.set(v, type);
  }
  t.take(')');
  return decl;
}

/** `(name: $var, name: "literal")`: each argument and its value (`$var` or the quoted literal), none twice. */
function argumentValues(t: Tokens): Map<string, string> {
  const args = new Map<string, string>();
  t.take('(');
  while (t.peek() !== ')') {
    const a = t.name();
    t.take(':');
    const value = t.peek() === '$' ? `${t.take('$')}${t.name()}` : t.take();
    if (args.has(a) || !(value.startsWith('$') || value.startsWith('"'))) throw new Error('not an argument');
    args.set(a, value);
  }
  t.take(')');
  return args;
}

/** `{ a b … }`: one or more plain fields, none of them `__`-named; no arguments, aliases or nested selections. */
function plainSelection(t: Tokens): void {
  t.take('{');
  do { if (t.name().startsWith('__')) throw new Error('meta field'); } while (t.peek() !== '}');
  t.take('}');
}

/** The one form Linear marks a notification read with, checked token by token:
 *  `mutation NotificationUpdate($in: NotificationUpdateInput! [, $id: String!]) { notificationUpdate(input: $in [, id: "…" | $id]) { a b … } }`
 *  One operation, one root field (its name, so an alias cannot rename another mutation), its arguments `input` (the
 *  variable) and at most `id`, and a selection of plain fields. The variables it returns are the ones declared. */
function notificationUpdateVars(query: string): { input: string; id?: string } | undefined {
  const tokens = gqlTokens(query);
  if (!tokens) return undefined;
  try {
    const t = new Tokens(tokens);
    t.take('mutation');
    t.take('NotificationUpdate');
    const decl = variableTypes(t);
    t.take('{');
    t.take('notificationUpdate');
    const args = argumentValues(t);
    plainSelection(t);
    t.take('}');
    if (!t.done()) return undefined;
    return checkedArguments(decl, args);
  } catch {
    return undefined;
  }
}

/** input: a declared NotificationUpdateInput! variable; at most id besides: a literal, or a declared String!/ID!; and
 *  no variable declared that is not used. */
function checkedArguments(decl: Map<string, string>, args: Map<string, string>): { input: string; id?: string } | undefined {
  const input = args.get('input'), id = args.get('id');
  if (!input?.startsWith('$') || decl.get(input.slice(1)) !== 'NotificationUpdateInput' || args.size !== (id === undefined ? 1 : 2)) return undefined;
  const idVar = id?.startsWith('$') ? id.slice(1) : undefined;
  if (idVar !== undefined && decl.get(idVar) !== 'String' && decl.get(idVar) !== 'ID') return undefined;
  if (decl.size !== (idVar === undefined ? 1 : 2)) return undefined;
  return { input: input.slice(1), id: idVar };
}

/** Linear: a notification marked read. `NotificationUpdate` also archives and snoozes; only an input of `readAt` alone is
 *  marking it read. The query is parsed (notificationUpdateVars), not matched by its opening words: a second root
 *  field (`issueDelete(…)`) rides along otherwise, with its arguments written inline. */
function linearNotificationRead(rec: Address, body: string | undefined): boolean {
  if (rec.host !== 'client-api.linear.app' || rec.path !== '/graphql' || hasQuery(rec)) return false;
  const j = parse(body);
  // The body's keys exactly as Linear sends them: a persisted query or a stored document beside the query is not read.
  if (!isObj(j) || !keysAre(j, 'operationName', 'query', 'variables')) return false;
  if (j.operationName !== 'NotificationUpdate' || typeof j.query !== 'string' || !isObj(j.variables)) return false;
  const form = notificationUpdateVars(j.query);
  if (!form) return false;
  const vars = j.variables;
  if (Object.keys(vars).length !== (form.id === undefined ? 1 : 2) || (form.id !== undefined && typeof vars[form.id] !== 'string')) return false;
  const input = vars[form.input];
  return isObj(input) && Object.keys(input).length === 1 && typeof input.readAt === 'string';
}

/** Gmail's unread (^u) and unseen-in-list (^us) marks: removed when a message is read, or the inbox shows it. */
const READ_MARKS = new Set(['^u', '^us']);
/** What Gmail adds as a message is read: opened (^o), read and read for 30 seconds (^io_lr, ^io_lr30s, its importance
 *  model's reading signals), a click in the message (^eclicks_msg). */
const READ_SIGNALS = new Set(['^o', '^io_lr', '^io_lr30s', '^eclicks_msg']);

const only = (v: unknown, allowed: Set<string>): v is string[] => Array.isArray(v) && v.every((l) => typeof l === 'string' && allowed.has(l));
const none = (v: unknown) => v == null || (Array.isArray(v) && v.length === 0);

/** One operation that only marks a thread read: its thread state sets nothing but its label change, which adds only
 *  reading signals and removes only the read marks, and does at least one of those. */
function marksRead(op: unknown): boolean {
  if (!Array.isArray(op) || typeof op[0] !== 'number' || !Array.isArray(op[1]) || typeof op[1][0] !== 'string') return false;
  const state = op[1][1];
  if (!Array.isArray(state) || state.length !== 7 || state.slice(0, 6).some((x) => x != null)) return false;
  const labels = state[6];
  if (!Array.isArray(labels)) return false;
  const [added, removed] = labels;
  if (!(none(added) || only(added, READ_SIGNALS)) || !(none(removed) || only(removed, READ_MARKS))) return false;
  return !(none(added) && none(removed));
}

/** Gmail: messages read, or the inbox's unseen flags cleared as it renders. A sync write whose every operation only marks
 *  a thread read (marksRead). A star, archive, trash, label, draft, reply or send adds or removes another label, or
 *  sets another field, and is not this; a batch with one of them in it is refused whole. */
function gmailMarksRead(rec: Address, body: string | undefined): boolean {
  if (rec.host !== 'mail.google.com' || !/^\/sync\/u\/\d+\/i\/s$/.test(rec.path)) return false;
  const j = parse(body);
  if (!Array.isArray(j) || j[0] != null || !Array.isArray(j[1]) || j[1].length === 0) return false;
  const ops = (j[1] as unknown[]).flatMap((g) => (Array.isArray(g) ? g : [null]));
  return ops.length > 0 && ops.every(marksRead);
}

const CHECKS: ReadTracking[] = [
  { name: 'x:education-flag', test: xEducationFlag },
  { name: 'linear:notification-read', test: linearNotificationRead },
  { name: 'gmail:marked-read', test: gmailMarksRead },
];

/** A GraphQL shape a site lists as read tracking (`gql:mutation:ViewPreferencesUpdate`) names the operation by the
 *  body's operationName alone, and any mutation can be given that name. So the body must run that operation and only
 *  its own root field: keys operationName, query and at most variables, no query string, a document of that one
 *  operation, and one root field, unaliased and with no directive, named as the operation with a lower-case first
 *  letter (`viewPreferencesUpdate`). `mutation ViewPreferencesUpdate { issueDelete(…) }` is not read tracking. */
export function gqlReadTrackingHolds(rec: Address & Pick<RequestRecord, 'bodyFull' | 'bodyPreview'>): boolean {
  if (hasQuery(rec)) return false;
  const j = parse(rec.bodyFull ?? rec.bodyPreview);
  if (!isObj(j) || !(keysAre(j, 'operationName', 'query') || keysAre(j, 'operationName', 'query', 'variables'))) return false;
  const name = j.operationName;
  if (typeof name !== 'string' || !name || typeof j.query !== 'string') return false;
  const ops = gqlOperations(j.query);
  if (ops?.length !== 1) return false;
  const [op] = ops;
  return op!.name === name && op!.root.length === 1 && op!.root[0] === name[0]!.toLowerCase() + name.slice(1);
}

/** The read-tracking check a request passes, by name, or undefined. */
export function readTrackingRequest(rec: Address & Pick<RequestRecord, 'bodyFull' | 'bodyPreview'>): string | undefined {
  const body = rec.bodyFull ?? rec.bodyPreview;
  return CHECKS.find((c) => c.test(rec, body))?.name;
}
