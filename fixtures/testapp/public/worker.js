// Dedicated worker: issues a request on behalf of the page so tests can prove
// worker traffic is intercepted via Target.setAutoAttach.
self.onmessage = async (e) => {
  const { method, url, body } = e.data;
  try {
    const res = await fetch(url, { method, headers: body ? { 'content-type': 'application/json' } : {}, body });
    self.postMessage({ status: res.status });
  } catch (err) {
    self.postMessage({ error: err.name });
  }
};
