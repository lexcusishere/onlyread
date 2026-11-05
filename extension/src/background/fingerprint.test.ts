/// <reference types="vite/client" />
import { describe, it, expect } from 'vitest';
import vectors from '../../fingerprint.vectors.json';
import { fingerprint, previewBody, pathTemplate } from './fingerprint';

type Vector = { name: string; method: string; url: string; contentType?: string; body?: string; hasBody: boolean; expected: string; queryKeys?: string[] };

// Generic vectors, plus each site codec's own (codecs/<name>.vectors.json, next to the codec).
const codecVectors = import.meta.glob<Vector[]>('./codecs/*.vectors.json', { eager: true, import: 'default' });
const suites: [string, Vector[]][] = [['generic', vectors as Vector[]], ...Object.entries(codecVectors).map(([f, v]): [string, Vector[]] => [f.replace(/^.*\/|\.vectors\.json$/g, ''), v])];

for (const [suite, vs] of suites) {
  describe(`fingerprint vectors: ${suite}`, () => {
    for (const v of vs) {
      it(v.name, () => {
        const fp = fingerprint(v.method, v.url, v.contentType, v.body, v.hasBody);
        expect(fp.fingerprint).toBe(v.expected);
        if (v.queryKeys) expect(fp.queryKeys).toEqual(v.queryKeys);
      });
    }
  });
}

it('loads every codec vector file', () => {
  expect(Object.keys(codecVectors).length).toBeGreaterThanOrEqual(5);
});

describe('pathTemplate', () => {
  it('keeps short alphanumeric words', () => {
    expect(pathTemplate('/v2/users/me/settings')).toBe('/v2/users/me/settings');
  });
});

describe('previewBody', () => {
  it('truncates long string values but keeps keys', () => {
    const long = 'x'.repeat(500);
    const { preview, truncated } = previewBody('application/json', JSON.stringify({ a: long, b: { c: 'ok' } }));
    expect(truncated).toBe(true);
    expect(preview!.length).toBeLessThan(200);
    expect(JSON.parse(preview!)).toMatchObject({ b: { c: 'ok' } });
  });
  it('caps total size', () => {
    const { preview } = previewBody('text/plain', 'y'.repeat(10_000));
    expect(preview!.length).toBeLessThanOrEqual(2049);
  });
  it('stays linear on large bodies the form redactor cannot split (JSON sent as a form, trailing whitespace)', () => {
    const t = Date.now();
    previewBody('application/x-www-form-urlencoded', '[[' + '1,"abc",'.repeat(40_000) + ']]');   // ~320 KB, no `=`
    previewBody('text/plain', 'a=b&'.repeat(80_000) + 'c=d ');
    expect(Date.now() - t).toBeLessThan(1000);
  });
  it('redacts secret form fields after whitespace or `=` as well as after &', () => {
    expect(previewBody('application/x-www-form-urlencoded', 'a=1\npassword=hunter2').preview).toBe('a=1\npassword=[redacted]');
    expect(previewBody('application/x-www-form-urlencoded', 'x&=token=abc').preview).toBe('x&=token=[redacted]');
  });
  it('redacts credential-like values wherever they appear in JSON', () => {
    const body = JSON.stringify({ query: 'mutation GoogleUserAccountAuth($code: String!) { x }', variables: { code: '4/0AXlqoi6secretsecretsecret', inviteLink: null, user: { password: 'hunter2', email: 'a@b.c' } }, token: 'abc' });
    const { preview } = previewBody('application/json', body);
    const p = JSON.parse(preview!);
    expect(p.variables.code).toBe('[redacted]');
    expect(p.variables.user.password).toBe('[redacted]');
    expect(p.token).toBe('[redacted]');
    expect(p.variables.user.email).toBe('a@b.c');
    expect(p.query).toContain('GoogleUserAccountAuth');
    expect(preview).not.toContain('secretsecret');
  });
  it('redacts secret values in form bodies', () => {
    const { preview } = previewBody('application/x-www-form-urlencoded', 'username=alice&password=hunter2&csrf_token=zzz&next=%2Fhome');
    expect(preview).toBe('username=alice&password=[redacted]&csrf_token=[redacted]&next=%2Fhome');
  });
});

import { redactTokens, scrubKnown } from './fingerprint';
import redactionVectors from '../../redaction.vectors.json';

describe('redactTokens: secrets found by value, not only by field name (shared with harness/lib/state.py)', () => {
  for (const v of redactionVectors as { input: string; expected: string }[]) {
    it(v.input.slice(0, 50), () => expect(redactTokens(v.input)).toBe(v.expected));
  }
  it('Facebook\'s CSRF field (fb_dtsg) and account ids in a form body never reach the judge', () => {
    const body = 'av=100000000000001&fb_dtsg=NAcN8sZqk2bB0xYzQ1r4T7u%3A17%3A1712345678&fb_api_req_friendly_name=CometUFIFeedbackReactMutation';
    const { preview } = previewBody('application/x-www-form-urlencoded', body);
    expect(preview).not.toContain('NAcN8sZqk2bB0xYzQ1r4T7u');
    expect(preview).toContain('fb_api_req_friendly_name=CometUFIFeedbackReactMutation');
  });
  it('a token inside a JSON string value and in unparseable text is redacted too', () => {
    expect(previewBody('application/json', '{"x":"Bearer eyJhbGciOiJIUzI1NiJ9xYz1"}').preview).toBe('{"x":"Bearer [redacted]"}');
    expect(previewBody('text/x-custom', 'session=AbC123dEf456GhI789jKl').preview).not.toContain('AbC123dEf456GhI789jKl');
  });
});

describe('previewBody: secrets in formats the parsers do not read, and values the person typed', () => {
  const PW = 'Tr0ub4dor&3x';
  const enc = encodeURIComponent;
  it('redacts secret-named fields in XML, inline GraphQL, broken JSON and plain text', () => {
    expect(previewBody('text/xml', '<Login><User>a</User><Password>hunter22</Password></Login>').preview).toBe('<Login><User>a</User><Password>[redacted]</Password></Login>');
    expect(previewBody('application/xml', '<auth user="a" password="hunter22"/>').preview).toBe('<auth user="a" password="[redacted]"/>');
    expect(previewBody('application/json', JSON.stringify({ query: 'mutation { login(email: "a", password: "hunter22") { ok } }' })).preview).toContain('password: \\"[redacted]\\"');
    expect(previewBody('application/graphql', 'mutation { login(pwd: "hunter22") { ok } }').preview).toBe('mutation { login(pwd: "[redacted]") { ok } }');
    expect(previewBody('application/json', '{"user":"a","password":"hunter22","x":').preview).toBe('{"user":"a","password":"[redacted]","x":');
    expect(previewBody('text/plain', 'user: a\npasscode: 1234\n').preview).toBe('user: a\npasscode: [redacted]\n');
  });
  it('keeps flags and operation names next to secret-like words', () => {
    expect(previewBody('application/graphql', 'mutation { autoRefresh(enabled: true) }').preview).toBe('mutation { autoRefresh(enabled: true) }');
    expect(previewBody('text/plain', 'refreshToken: null').preview).toBe('refreshToken: null');
  });
  it('multipart: a secret-named part is redacted, a file part becomes its size, JSON parts are redacted as JSON', () => {
    const ct = 'multipart/form-data; boundary=XyZ';
    const body = '--XyZ\r\nContent-Disposition: form-data; name="password"\r\n\r\nhunter22\r\n' +
      '--XyZ\r\nContent-Disposition: form-data; name="variables"\r\n\r\n{"input":{"otp":"482913","text":"hi"}}\r\n' +
      '--XyZ\r\nContent-Disposition: form-data; name="upload"; filename="a.bin"\r\nContent-Type: application/octet-stream\r\n\r\n\u0001\u0002binary\r\n--XyZ--\r\n';
    const p = previewBody(ct, body).preview!;
    expect(p).toContain('name="password"\r\n\r\n[redacted]\r\n');
    expect(p).toContain('{"input":{"otp":"[redacted]","text":"hi"}}');
    expect(p).toContain('[file, 8 bytes]');
    expect(p).not.toContain('hunter22');
  });
  it('redacts card numbers written in groups, and leaves plain digit runs (ids) alone', () => {
    expect(previewBody('text/plain', 'pay with 4111 1111 1111 1111 now').preview).toBe('pay with [redacted] now');
    expect(previewBody('text/plain', 'amex 3782-822463-10005').preview).toBe('amex [redacted]');
    expect(previewBody('application/x-www-form-urlencoded', 'doc_id=4111111111111111&fbid=378282246310005').preview).toBe('doc_id=4111111111111111&fbid=378282246310005');
  });
  it('removes a typed value however it is nested: Google\'s sign-in f.req, a positional array, an unnamed part', () => {
    const freq = `f.req=${enc(JSON.stringify([[['MI613e', JSON.stringify([null, [1, null, null, null, [PW, null, true]]]), null, 'generic']]]))}`;
    for (const [ct, body] of [
      ['application/x-www-form-urlencoded', freq],
      ['application/json', JSON.stringify([['a@example.com', PW]])],
      ['multipart/form-data; boundary=B', `--B\r\nContent-Disposition: form-data; name="f3"\r\n\r\n${PW}\r\n--B--\r\n`],
    ] as const) {
      const carries = (p: string) => [PW, enc(PW), enc(enc(PW)), btoa(PW)].some((form) => p.includes(form));
      expect(carries(previewBody(ct, body).preview!)).toBe(true); // no field name to find it by
      expect(carries(previewBody(ct, body, [PW]).preview!)).toBe(false);
    }
  });
  it('removes a typed value as a form or URLSearchParams encodes it (! \' ( ) ~ escaped, any escape case)', () => {
    for (const pw of ['Hunter2!go', "it's(9)~x"]) {
      const body = new URLSearchParams({ user: 'bob', new_pw: pw }).toString();
      expect(previewBody('application/x-www-form-urlencoded', body, [pw]).preview).toBe('user=bob&new_pw=[redacted]');
    }
    expect(scrubKnown('new_pw=Hunter2%21go%2fx', ['Hunter2!go/x'])).toBe('new_pw=[redacted]');
  });
  it('removes a typed value sent base64-encoded', () => {
    expect(scrubKnown(`auth=${btoa(PW)}`, [PW])).toBe('auth=[redacted]');
  });
  it('removes a typed value only where it stands whole, and never a letters-only one', () => {
    expect(scrubKnown('{"pin":"4829x1","note":"a4829x1b"}', ['4829x1'])).toBe('{"pin":"[redacted]","note":"a4829x1b"}');
    // An agent told to type "delete" into a password field must not hide the word from the judge.
    expect(scrubKnown('{"action":"delete","id":7}', ['delete'])).toBe('{"action":"delete","id":7}');
  });
  it('ignores typed values shorter than 4 characters', () => {
    expect(scrubKnown('a=abc&b=abcd', ['abc'])).toBe('a=abc&b=abcd');
  });
});
