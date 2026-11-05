import { afterEach, describe, expect, it, vi } from 'vitest';

// The reports are kept in storage.session for the browser session and read back at startup, so a failed write
// followed by a worker restart still shows.
describe('storage health reports', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });
  it('keeps the reports across a worker restart and clears them on the next success', async () => {
    const session: Record<string, unknown> = {};
    vi.stubGlobal('chrome', { storage: { session: {
      set: async (o: Record<string, unknown>) => { Object.assign(session, o); },
      get: async (k: string) => ({ [k]: session[k] }),
    } } });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let h = await import('./storage-health');
    h.storageFailed('audit', new Error('quota'));
    h.storageFailed('cache', new Error('IO'), 'read');
    await new Promise((r) => setTimeout(r, 0));
    expect(session.storageFailures).toEqual({ 'audit:write': 'the activity log could not be saved (quota)', 'cache:read': 'the tested verdicts could not be read (IO)' });
    vi.resetModules(); // the worker restarts
    h = await import('./storage-health');
    expect(h.storageProblem()).toBeUndefined();
    await h.restoreHealth();
    expect(h.storageProblem()).toBe('the activity log could not be saved (quota); the tested verdicts could not be read (IO)');
    h.storageOk('audit', 'read'); // the first read at startup: says nothing about the failed write
    expect(h.storageProblem()).toBe('the activity log could not be saved (quota); the tested verdicts could not be read (IO)');
    h.storageOk('cache', 'read');
    h.storageOk('audit');
    await new Promise((r) => setTimeout(r, 0));
    expect(h.storageProblem()).toBeUndefined();
    expect(session.storageFailures).toEqual({});
  });
  it('works without session storage (tests, older browsers)', async () => {
    vi.stubGlobal('chrome', {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = await import('./storage-health');
    h.storageFailed('audit', new Error('x'));
    await h.restoreHealth();
    expect(h.storageProblem()).toMatch(/activity log/);
  });
});
