// Service worker that controls the page and proxies /api/ requests, like real apps do.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.pathname.startsWith('/api/') || url.pathname === '/rpc') {
    e.respondWith(fetch(e.request));
  }
});
self.addEventListener('message', async (e) => {
  try {
    const r = await fetch(e.data.url, { method: e.data.method, headers: e.data.body ? { 'content-type': 'application/json' } : {}, body: e.data.body });
    e.source.postMessage({ status: r.status });
  } catch (err) {
    e.source.postMessage({ error: err.name });
  }
});
