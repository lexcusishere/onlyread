import type { Codec } from './types';

// ---- Facebook (Relay GraphQL): POST www.facebook.com/api/graphql/, application/x-www-form-urlencoded.
// Every operation, read or write, shares the endpoint AND the form keys (av, __user, fb_dtsg, doc_id,
// variables, …), so the key shape is one fingerprint for the whole site. The operation is the VALUE of
// fb_api_req_friendly_name: Relay names reads "*Query" (…PaginationQuery, …RefetchQuery) and writes
// "*Mutation". Write-biased: only a name ending in "Query" is a read; any other name, a missing name or an
// unreadable body is a write.
// Known limit (accepted): the server runs the doc_id, not the friendly name, which is Facebook's own logging label.
// Facebook's page always sends a matching pair, but a request built by hand (an agent running its own JS) with a
// mutation's doc_id and a "*Query" name decodes as fb:gql:r. doc_ids rotate, so they are not pinned here.
function facebookGraphql(body: string): string {
  if (!body) return 'fb:gql:w[unparseable]';
  let name: string | null;
  try { name = new URLSearchParams(body).get('fb_api_req_friendly_name'); } catch { return 'fb:gql:w[unparseable]'; }
  if (!name || !/^[A-Za-z0-9_]+$/.test(name)) return 'fb:gql:w[unknown]';
  return name.endsWith('Query') ? 'fb:gql:r' : `fb:gql:w[${name}]`;
}

export const facebook: Codec = {
  id: 'facebook-graphql',
  writePrefixes: ['fb:gql:w'],
  matches: (host, template) => (host === 'facebook.com' || host.endsWith('.facebook.com')) && template === '/api/graphql/',
  decode: facebookGraphql,
};
