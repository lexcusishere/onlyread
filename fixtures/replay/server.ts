// Stand-in for the verified sites' servers, for the replay tests (e2e/replay.spec.ts). The test browsers
// resolve every host name (linear.app, mail.google.com, www.facebook.com, …) to this server, so OnlyRead
// sees the same hosts, paths and bodies as in production and nothing reaches the real sites. It answers every request, logs every request that
// reaches it (a refused request never does), and keeps one Linear issue's status as the server truth.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

interface Received { host: string; method: string; path: string; replayId?: string; operationName?: string }
interface IssueState { id: string; name: string }

export const LINEAR_STATES: IssueState[] = [
  { id: 'state-todo', name: 'Todo' },
  { id: 'state-progress', name: 'In Progress' },
  { id: 'state-done', name: 'Done' },
];

/** A throwaway self-signed certificate (the browsers are told to accept it). */
function certificate(): { key: Buffer; cert: Buffer } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onlyread-replay-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=onlyread-replay',
    '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem')], { stdio: 'ignore' });
  return { key: fs.readFileSync(path.join(dir, 'key.pem')), cert: fs.readFileSync(path.join(dir, 'cert.pem')) };
}

/** The page the test browsers open on https://linear.app/: shows the issue's status, read the way
 *  Linear's client reads models (a POST to client-api.linear.app/sync/batch, a labeled read). */
const APP_PAGE = `<!doctype html><meta charset="utf-8"><title>Linear (replay)</title>
<h1>Issue ONL-REPLAY</h1><p>Status: <b id="status">…</b></p>
<script>
fetch('https://client-api.linear.app/sync/batch', { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ clientDatabaseId: 'replay', firstSyncId: 1, requests: [{ modelName: 'Issue', identifier: 'ONL-REPLAY' }] }) })
  .then((r) => r.json()).then((d) => { document.getElementById('status').textContent = d.issue.state.name; })
  .catch(() => { document.getElementById('status').textContent = 'unavailable'; });
</script>`;

export interface ReplayServer { port: number; received: Received[]; state: IssueState; close(): Promise<void> }

export async function startReplayServer(): Promise<ReplayServer> {
  const received: Received[] = [];
  const srv = { state: LINEAR_STATES[0]! };
  const server = https.createServer(certificate(), (req, res) => {
    const host = (req.headers.host ?? '').split(':')[0]!;
    const url = new URL(req.url ?? '/', `https://${host}`);
    const cors = {
      'access-control-allow-origin': req.headers.origin ?? '*',
      'access-control-allow-credentials': 'true',
      'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
      'access-control-allow-headers': req.headers['access-control-request-headers'] ?? '*',
    };
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let gql: { operationName?: string; variables?: Record<string, unknown> } | undefined;
      try { gql = body ? JSON.parse(body) : undefined; } catch { gql = undefined; }
      const replayId = (req.headers['x-replay-id'] as string | undefined) ?? url.searchParams.get('__rid') ?? undefined;
      received.push({ host, method: req.method ?? 'GET', path: url.pathname, replayId, operationName: gql?.operationName });
      if (req.method === 'OPTIONS') { res.writeHead(204, cors).end(); return; }
      if (host === 'linear.app' && req.method === 'GET') { res.writeHead(200, { ...cors, 'content-type': 'text/html' }).end(APP_PAGE); return; }
      // Any other site's page: a blank page on that origin, for the replay to send its requests from.
      if (req.method === 'GET' && req.headers['sec-fetch-dest'] === 'document') {
        res.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><meta charset="utf-8"><title>${host} (replay)</title><p>${host} — replay page</p>`);
        return;
      }
      if (host === 'client-api.linear.app' && url.pathname === '/sync/batch') {
        res.writeHead(200, { ...cors, 'content-type': 'application/json' }).end(JSON.stringify({ issue: { state: srv.state } }));
        return;
      }
      if (host === 'client-api.linear.app' && url.pathname === '/graphql') {
        const reply = (data: unknown) => res.writeHead(200, { ...cors, 'content-type': 'application/json' }).end(JSON.stringify({ data }));
        if (gql?.operationName === 'IssueUpdate') {
          const v = gql.variables ?? {};
          const input = (v.issueUpdateInput ?? v.input ?? {}) as { stateId?: string };
          const next = LINEAR_STATES.find((s) => s.id === input.stateId);
          if (next) srv.state = next;
          reply({ issueUpdate: { success: true } });
          return;
        }
        reply({});
        return;
      }
      res.writeHead(200, { ...cors, 'content-type': 'text/plain' }).end('');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    received,
    get state() { return srv.state; },
    set state(s: IssueState) { srv.state = s; },
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
