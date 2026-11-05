// Deterministic target app for e2e tests and manual sessions.
// Exposes every request pattern that matters for read-only enforcement:
// REST CRUD, GraphQL query/mutation/batch on one endpoint, POST search,
// single-endpoint RPC, side-effecting GET, multipart upload, WebSocket, beacon.
// Every request it receives is logged and readable at GET /__log.
import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { cloudRouter } from '../cloud/mock.ts';

type Item = { id: number; name: string; read: boolean };
type LogEntry = { ts: number; method: string; path: string; contentType?: string; body?: string };

const here = path.dirname(fileURLToPath(import.meta.url));
const requestLog: LogEntry[] = [];
const items = new Map<number, Item>();
let nextId = 1;

function seed(): void {
  items.clear();
  nextId = 1;
  for (const name of ['alpha', 'beta', 'gamma']) items.set(nextId, { id: nextId++, name, read: false });
}
seed();

const app = express();
app.use(express.json({ limit: '8mb' }));
app.use(express.text({ type: ['text/*', 'application/graphql'] }));
app.use(express.raw({ type: 'multipart/form-data', limit: '5mb' }));

app.use((req, _res, next) => {
  if (!req.path.startsWith('/__')) {
    const body = req.body === undefined ? undefined
      : Buffer.isBuffer(req.body) ? `<${req.body.length} bytes>`
      : typeof req.body === 'string' ? req.body.slice(0, 200)
      : JSON.stringify(req.body).slice(0, 200);
    requestLog.push({ ts: Date.now(), method: req.method, path: req.originalUrl, contentType: req.headers['content-type'], body });
  }
  next();
});

// Mock OnlyRead Pro backend (dev builds point their service URL here).
app.use('/cloud', cloudRouter());

app.use(express.static(path.join(here, 'public')));

// REST
app.get('/api/items', (_req, res) => { res.json([...items.values()]); });
app.get('/api/items/:id', (req, res) => {
  const it = items.get(Number(req.params.id));
  if (!it) { res.status(404).json({ error: 'not found' }); return; }
  res.json(it);
});
app.post('/api/items', (req, res) => {
  const it: Item = { id: nextId++, name: String(req.body?.name ?? 'unnamed'), read: false };
  items.set(it.id, it);
  res.status(201).json(it);
});
app.put('/api/items/:id', (req, res) => {
  const id = Number(req.params.id);
  const it: Item = { id, name: String(req.body?.name ?? 'renamed'), read: Boolean(req.body?.read) };
  items.set(id, it);
  res.json(it);
});
app.patch('/api/items/:id', (req, res) => {
  const it = items.get(Number(req.params.id));
  if (!it) { res.status(404).json({ error: 'not found' }); return; }
  Object.assign(it, req.body ?? {});
  res.json(it);
});
app.delete('/api/items/:id', (req, res) => {
  res.json({ deleted: items.delete(Number(req.params.id)) });
});

// POST used for a read
app.post('/api/search', (req, res) => {
  const q = String(req.body?.q ?? '').toLowerCase();
  res.json([...items.values()].filter((i) => i.name.includes(q)));
});

// GraphQL: query vs mutation on one endpoint, plus batches
type GqlOp = { query?: string; operationName?: string; variables?: Record<string, unknown> };
function runGql(op: GqlOp): unknown {
  const q = String(op.query ?? '').trim();
  if (/^mutation\b/i.test(q)) {
    const it: Item = { id: nextId++, name: String(op.variables?.name ?? 'via-mutation'), read: false };
    items.set(it.id, it);
    return { data: { createItem: it } };
  }
  return { data: { items: [...items.values()] } };
}
app.post('/graphql', (req, res) => {
  const body = req.body as GqlOp | GqlOp[];
  res.json(Array.isArray(body) ? body.map(runGql) : runGql(body));
});

// Sign-in for the typed-secret scrub check (public/signin.html): always a wrong password.
app.post('/api/signin', (_req, res) => { res.status(401).json({ ok: false, error: 'wrong password' }); });

// Single-endpoint RPC: semantics live entirely in the body
app.post('/rpc', (req, res) => {
  const op = String(req.body?.op ?? '');
  switch (op) {
    case 'list': res.json({ result: [...items.values()] }); return;
    case 'create': {
      const it: Item = { id: nextId++, name: String(req.body?.name ?? 'via-rpc'), read: false };
      items.set(it.id, it);
      res.json({ result: it }); return;
    }
    case 'delete': res.json({ result: items.delete(Number(req.body?.id)) }); return;
    default: res.status(400).json({ error: `unknown op ${op}` });
  }
});

// GETs with side effects
app.get('/mark-read/:id', (req, res) => {
  const it = items.get(Number(req.params.id));
  if (it) it.read = true;
  res.json({ ok: Boolean(it) });
});
app.get('/logout', (_req, res) => { res.json({ loggedOut: true }); });

// Telemetry
app.all('/collect', (_req, res) => { res.status(204).end(); });

// Upload
app.post('/upload', (req, res) => {
  res.status(201).json({ bytes: Buffer.isBuffer(req.body) ? req.body.length : 0 });
});

// Test control (Node-side only; never called from the browser under test)
const sinkLog: unknown[] = [];
app.get('/__health', (_req, res) => { res.json({ ok: true }); });
app.get('/__log', (_req, res) => { res.json(requestLog); });
app.get('/__state', (_req, res) => { res.json([...items.values()]); });
app.post('/__reset', (_req, res) => { requestLog.length = 0; sinkLog.length = 0; seed(); res.json({ ok: true }); });
// Dev sink: the extension POSTs batches of {kind, payload} here when policy.devSink points at us.
app.post('/__audit', (req, res) => {
  if (Array.isArray(req.body)) sinkLog.push(...req.body);
  res.status(204).end();
});
app.get('/__audit', (_req, res) => { res.json(sinkLog); });

// Dev control channel: the harness enqueues commands, the extension polls and answers.
// Several extension instances (Chrome profiles) may poll; each has its own queue, keyed by the
// instance id it sends. A command without an instance goes to the only instance seen recently,
// or is refused when there are several, so two profiles never race for one command.
type Job = { id: number; command: unknown; ts: number; instance: string };
const controlQueues = new Map<string, Job[]>();
const controlResults = new Map<number, unknown>();
const controlInstances = new Map<string, { lastSeen: number; label: string }>();
let controlSeq = 0;
const recentInstances = () => [...controlInstances.entries()].filter(([, v]) => Date.now() - v.lastSeen < 10_000).map(([k]) => k);
app.get('/__control/instances', (_req, res) => {
  res.json([...controlInstances.entries()].map(([id, v]) => ({ id, label: v.label, lastSeen: v.lastSeen, ageMs: Date.now() - v.lastSeen, queued: controlQueues.get(id)?.length ?? 0 })));
});
app.post('/__control', (req, res) => {
  const wanted = typeof req.body?.instance === 'string' && req.body.instance ? String(req.body.instance) : undefined;
  const { instance: _i, ...command } = (req.body ?? {}) as Record<string, unknown>;
  let target: string | undefined = wanted;
  if (!target) {
    const live = recentInstances();
    if (live.length === 1) target = live[0]!;
    else if (live.length === 0) { res.status(409).json({ error: 'no extension instance has polled in the last 10 s', instances: [] }); return; }
    else { res.status(409).json({ error: 'several extension instances are live; pass "instance"', instances: live.map((id) => ({ id, label: controlInstances.get(id)?.label })) }); return; }
  }
  const dest: string = target;
  const id = ++controlSeq;
  const q = controlQueues.get(dest) ?? [];
  q.push({ id, command, ts: Date.now(), instance: dest });
  controlQueues.set(dest, q);
  res.json({ id, instance: dest });
});
app.get('/__control/next', (req, res) => {
  const inst = String(req.query.instance ?? 'default');
  controlInstances.set(inst, { lastSeen: Date.now(), label: String(req.query.label ?? '') });
  res.json(controlQueues.get(inst)?.shift() ?? {});
});
app.post('/__control/result', (req, res) => { controlResults.set(Number(req.body?.id), req.body); res.json({ ok: true }); });
app.get('/__control/result/:id', (req, res) => {
  const r = controlResults.get(Number(req.params.id));
  if (!r) { res.status(202).json({ pending: true, queued: [...controlQueues.values()].reduce((n, q) => n + q.length, 0) }); return; }
  res.json(r);
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws, req) => {
  requestLog.push({ ts: Date.now(), method: 'WS', path: req.url ?? '/ws' });
  ws.on('message', (data) => ws.send(data));
});

function start(port = Number(process.env.PORT ?? 4173)): Promise<http.Server> {
  return new Promise((resolve) => {
    // Loopback only: the control channel can read the profile's keys, so nothing else on the network may reach it.
    server.listen(port, '127.0.0.1', () => {
      console.log(`OnlyRead fixture listening on http://localhost:${port}`);
      resolve(server);
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void start();
}
