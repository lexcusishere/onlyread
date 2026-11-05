// Static measurement of the body redactor (extension/src/background/fingerprint.ts previewBody): what the
// judge would be shown, scanned for secrets that survived. No judge is called.
//   npx tsx harness/lib/redaction_measure.mts [--m2w N]   (N = how many Mind2Web recordings, default all)
// Corpora: the recorded sessions' raw bodies (apps/*/sessions/*/decisions.jsonl bodyFull) and the Mind2Web
// HAR recordings (harness/eval/mind2web/bulk). Plus a planted suite: one password, OTP and card number in
// every sign-in body format we know, with and without the typed-value scrub.
// Prints counts only, never a body or a matched value.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { SECRET_KEY, previewBody } from '../../extension/src/background/fingerprint';

/** A HAR's `_file` names a body saved beside it; resolved only inside that folder, so a crafted dump cannot read other files. */
function bodyFile(dir: string, rel: string): string | undefined {
  const base = path.resolve(dir);
  const p = path.resolve(base, rel);
  return p.startsWith(base + path.sep) ? p : undefined;
}


const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const m2wLimit = Number(process.argv[process.argv.indexOf('--m2w') + 1]) || Infinity;

type Body = { ct: string | undefined; body: string; source: string };

function* sessionBodies(): Generator<Body> {
  for (const app of fs.readdirSync(path.join(ROOT, 'apps'))) {
    const dir = path.join(ROOT, 'apps', app, 'sessions');
    if (!fs.existsSync(dir)) continue;
    for (const s of fs.readdirSync(dir)) {
      const f = path.join(dir, s, 'decisions.jsonl');
      if (!fs.existsSync(f)) continue;
      for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
        if (!line) continue;
        const d = JSON.parse(line);
        if (typeof d.bodyFull === 'string') yield { ct: d.contentType, body: d.bodyFull, source: `session:${app}` };
      }
    }
  }
}

function* m2wBodies(): Generator<Body> {
  const bulk = path.join(ROOT, 'harness/eval/mind2web/bulk');
  if (!fs.existsSync(bulk)) return;
  let n = 0;
  for (const rec of fs.readdirSync(bulk)) {
    if (n++ >= m2wLimit) return;
    const har = path.join(bulk, rec, 'session.har');
    if (!fs.existsSync(har)) continue;
    let entries: Array<{ request: { method: string; headers: Array<{ name: string; value: string }>; postData?: { mimeType?: string; text?: string; _file?: string } } }>;
    try { entries = JSON.parse(fs.readFileSync(har, 'utf8')).log.entries; } catch { continue; }
    for (const e of entries) {
      const pd = e.request.postData;
      if (!pd || ['GET', 'HEAD', 'OPTIONS'].includes(e.request.method)) continue;
      let body = pd.text;
      if (body === undefined && pd._file) {
        const file = bodyFile(path.join(bulk, rec), pd._file);
        if (!file) continue;
        try { body = new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(file)); } catch { continue; }
      }
      if (!body) continue;
      const ct = e.request.headers.find((h) => h.name.toLowerCase() === 'content-type')?.value ?? pd.mimeType;
      yield { ct, body, source: 'mind2web' };
    }
  }
}

function format(ct: string | undefined, body: string): string {
  const t = (ct ?? '').split(';')[0]!.trim().toLowerCase();
  if (t === 'multipart/form-data') return 'multipart';
  if (t === 'application/graphql') return 'graphql';
  try { JSON.parse(body); return 'json'; } catch { /* not JSON */ }
  if (t === 'application/x-www-form-urlencoded' || /^[^\s=&]+=\S*$/.test(body)) return 'form';
  if (/^\s*</.test(body)) return 'xml';
  if (/protobuf|octet-stream|grpc/.test(t)) return 'binary';
  return 'other-text';
}

// ---- Detectors, run on the preview the judge would see.
// A redacted value, a literal, or the start of a nested object or array (whose own fields are checked by name).
const SKIP_VALUE = /^(\[redacted\]?|true|false|null|undefined|""|''|[[{].*|)$/i;
/** A secret-named field whose value is still there: `name: v`, `name=v`, `"name":"v"`, `<name>v</name>`, `name="v"`. */
function namedSecrets(text: string): number {
  let n = 0;
  const pair = /(?:^|[^\w-])["']?([A-Za-z_][\w-]{1,40})["']?\s*(?::|=>|=)\s*("(?:[^"\\]|\\.)*"|'[^']*'|[^\s,;&)}\]<"']+)/g;
  for (const m of text.matchAll(pair)) if (SECRET_KEY.test(m[1]!) && !SKIP_VALUE.test(m[2]!.replace(/^["']|["']$/g, ''))) n++;
  for (const m of text.matchAll(/<([\w:.-]+)[^>]*>([^<]+)<\/\1>/g)) if (SECRET_KEY.test(m[1]!.split(':').pop()!) && !SKIP_VALUE.test(m[2]!.trim())) n++;
  return n;
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
function cards(text: string): number {
  let n = 0;
  for (const m of text.matchAll(/(?<![\d.])\d{4}(?:[ -]\d{4}){3}(?![\d.])/g)) {
    const d = m[0].replace(/[ -]/g, '');
    if (/^[3456]/.test(d) && !/^(\d)\1+$/.test(d) && luhn(d)) n++;
  }
  return n;
}

// ---- Planted suite: sign-in bodies in every format we know, each carrying the same secrets.
const PW = 'Tr0ub4dor&3x';
const OTP = '482913';
const CARD = '4111111111111111';
const enc = encodeURIComponent;
const PLANTED: Array<{ name: string; ct: string; body: string; plant: string }> = [
  { name: 'json, named field', ct: 'application/json', body: JSON.stringify({ email: 'a@example.com', password: PW }), plant: PW },
  { name: 'form, named field', ct: 'application/x-www-form-urlencoded', body: `email=a%40example.com&password=${enc(PW)}`, plant: PW },
  { name: 'form, positional JSON (Google sign-in f.req)', ct: 'application/x-www-form-urlencoded;charset=UTF-8', body: `f.req=${enc(JSON.stringify([[['MI613e', JSON.stringify([null, [1, null, null, null, [PW, null, true]]]), null, 'generic']]]))}&at=AFoagUX1`, plant: PW },
  { name: 'json, positional array', ct: 'application/json', body: JSON.stringify([['a@example.com', PW, 1]]), plant: PW },
  { name: 'xml element', ct: 'text/xml', body: `<Login><Username>a</Username><Password>${PW.replace('&', '&amp;')}</Password></Login>`, plant: PW.replace('&', '&amp;') },
  { name: 'xml attribute', ct: 'application/xml', body: `<auth user="a" password="${PW.replace('&', '&amp;')}"/>`, plant: PW.replace('&', '&amp;') },
  { name: 'graphql inline in json', ct: 'application/json', body: JSON.stringify({ query: `mutation { login(email: "a", password: "${PW}") { ok } }` }), plant: PW },
  { name: 'application/graphql inline', ct: 'application/graphql', body: `mutation { login(password: "${PW}") { ok } }`, plant: PW },
  { name: 'multipart, named part', ct: 'multipart/form-data; boundary=XyZ', body: `--XyZ\r\nContent-Disposition: form-data; name="email"\r\n\r\na@example.com\r\n--XyZ\r\nContent-Disposition: form-data; name="password"\r\n\r\n${PW}\r\n--XyZ--\r\n`, plant: PW },
  { name: 'multipart, unnamed part', ct: 'multipart/form-data; boundary=XyZ', body: `--XyZ\r\nContent-Disposition: form-data; name="field_3"\r\n\r\n${PW}\r\n--XyZ--\r\n`, plant: PW },
  { name: 'broken json, named field', ct: 'application/json', body: `{"user":"a","password":"${PW}","x":`, plant: PW },
  { name: 'text, key: value', ct: 'text/plain', body: `user: a\npassword: ${PW}\n`, plant: PW },
  { name: 'form, pwd field', ct: 'application/x-www-form-urlencoded', body: `u=a&pwd=${enc(PW)}`, plant: PW },
  { name: 'json, OTP in named field', ct: 'application/json', body: JSON.stringify({ otp: OTP }), plant: OTP },
  { name: 'json, OTP positional', ct: 'application/json', body: JSON.stringify({ step: 'verify', data: [OTP] }), plant: OTP },
  { name: 'json, card number in a cardNumber field', ct: 'application/json', body: JSON.stringify({ payment: { cardNumber: CARD } }), plant: CARD },
  { name: 'json, card number, unnamed', ct: 'application/json', body: JSON.stringify({ payment: { number: CARD } }), plant: CARD },
  { name: 'text, card number', ct: 'text/plain', body: `pay with 4111-1111-1111-1111 now`, plant: '4111-1111-1111-1111' },
];

type Preview = (ct: string | undefined, body: string, known?: string[]) => { preview?: string };
const preview = previewBody as unknown as Preview;

/** The secret in any encoding a body may carry it in: raw, URL-encoded (twice, as f.req does), JSON-escaped. */
function carries(text: string, secret: string): boolean {
  const forms = [secret, enc(secret), enc(enc(secret)), JSON.stringify(secret).slice(1, -1), enc(JSON.stringify(secret).slice(1, -1))];
  return forms.some((f) => text.includes(f));
}

function plantedReport(): void {
  console.log('\n## Planted secrets (leaks = the secret is still in the preview)');
  let without = 0, withKnown = 0;
  for (const p of PLANTED) {
    const a = carries(preview(p.ct, p.body).preview ?? '', p.plant);
    const b = carries(preview(p.ct, p.body, [PW, OTP, CARD]).preview ?? '', p.plant);
    without += Number(a); withKnown += Number(b);
    console.log(`${a ? 'LEAK' : 'ok  '}  ${b ? 'LEAK' : 'ok  '}  ${p.name}`);
  }
  console.log(`leaks: ${without}/${PLANTED.length} by format alone · ${withKnown}/${PLANTED.length} with the typed values known`);
}

function corpusReport(): void {
  const seen = new Set<string>();
  const byFormat = new Map<string, { n: number; named: number; namedBodies: number; cards: number; changed: number }>();
  const names = new Map<string, number>();
  let total = 0;
  for (const src of [sessionBodies(), m2wBodies()]) {
    for (const b of src) {
      const h = createHash('sha1').update(b.ct ?? '').update('\0').update(b.body).digest('hex');
      if (seen.has(h)) continue;
      seen.add(h); total++;
      const f = format(b.ct, b.body);
      const row = byFormat.get(f) ?? { n: 0, named: 0, namedBodies: 0, cards: 0, changed: 0 };
      const pv = preview(b.ct, b.body).preview ?? '';
      const named = namedSecrets(pv);
      row.n++; row.named += named; row.namedBodies += Number(named > 0); row.cards += cards(pv);
      row.changed += Number(pv !== b.body.slice(0, pv.length));
      if (named) for (const m of pv.matchAll(/["']?([A-Za-z_][\w-]{1,40})["']?\s*(?::|=>|=)/g)) if (SECRET_KEY.test(m[1]!)) names.set(m[1]!.toLowerCase(), (names.get(m[1]!.toLowerCase()) ?? 0) + 1);
      byFormat.set(f, row);
    }
  }
  console.log(`## Corpus: ${total} distinct non-GET bodies`);
  console.log('format        bodies  secret-named fields left (bodies)  card numbers left');
  for (const [f, r] of [...byFormat].sort((a, b) => b[1].n - a[1].n)) {
    console.log(`${f.padEnd(13)} ${String(r.n).padStart(6)}  ${String(r.named).padStart(8)} (${r.namedBodies})${' '.repeat(18)}${r.cards}`);
  }
  console.log('field names behind the remaining secret-named matches:', [...names].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([k, v]) => `${k}×${v}`).join(' '));
}

corpusReport();
plantedReport();
