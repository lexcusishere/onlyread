import { describe, expect, it } from 'vitest';
import { defaultPolicy } from './policy';
import { resolveEffective } from './sites';
import { candidateWorkers, CLOSE_IF_SHARED_WORKER, hideSharedWorker } from './shared-workers';

const eff = () => {
  const p = defaultPolicy();
  p.customSites = [{ id: 'web.telegram.org', name: 'Telegram', domains: ['web.telegram.org'], enabled: true }];
  return resolveEffective(p);
};

describe('candidateWorkers', () => {
  it('takes the unheld, unattached workers of guarded hosts (a SharedWorker and its blob workers), not one a tab is attaching', () => {
    const targets = [
      { id: 'shared', type: 'worker', attached: false, url: 'https://web.telegram.org/k/index.worker.js?__tweb_threaded_worker_protocol=4' },
      { id: 'blob', type: 'worker', attached: false, url: 'blob:https://web.telegram.org/1f2e' },
      { id: 'held', type: 'worker', attached: true, url: 'https://web.telegram.org/k/sw.js' },
      { id: 'starting', type: 'worker', attached: true, url: 'https://web.telegram.org/k/new.worker.js' },
      { id: 'tabchild', type: 'other', attached: true, url: 'https://web.telegram.org/k/compositor.worker.js' },
      { id: 'elsewhere', type: 'worker', attached: false, url: 'https://example.com/shared.js' },
      { id: 'page', type: 'page', attached: true, url: 'https://web.telegram.org/k/' },
    ];
    expect(candidateWorkers(targets, new Set(['held']), eff()).map((w) => w.id)).toEqual(['shared', 'blob']);
  });
});

describe('the scripts put into pages and workers', () => {
  it('parse, and close only a SharedWorker', () => {
    const hidden = (host: string, eff: Parameters<typeof hideSharedWorker>[0]) => {
      const g = { SharedWorker: class {} as unknown };
      new Function('location', 'globalThis', hideSharedWorker(eff))({ hostname: host }, g);
      return g.SharedWorker === undefined;
    };
    const tg = { targetDomains: ['web.telegram.org'], guardAll: false, excludeDomains: [], exemptDomains: [] };
    expect(hidden('web.telegram.org', tg)).toBe(true);
    expect(hidden('example.com', tg)).toBe(false); // a site not guarded keeps it
    expect(hidden('web.telegram.org', { ...tg, targetDomains: [] })).toBe(false); // the site switched off
    expect(hidden('example.com', { ...tg, guardAll: true })).toBe(true);
    expect(hidden('example.com', { ...tg, guardAll: true, exemptDomains: ['example.com'] })).toBe(false);
    expect(() => new Function(`return ${CLOSE_IF_SHARED_WORKER}`)).not.toThrow();
    const run = (scope: Record<string, unknown>) => new Function('self', ...Object.keys(scope), `return ${CLOSE_IF_SHARED_WORKER}`)(...[scope.self, ...Object.values(scope)]);
    class SharedWorkerGlobalScope { closed = false; close() { this.closed = true; } }
    class DedicatedWorkerGlobalScope { closed = false; close() { this.closed = true; } }
    const shared = new SharedWorkerGlobalScope();
    expect(run({ self: shared, SharedWorkerGlobalScope })).toBe(true);
    expect(shared.closed).toBe(true);
    const dedicated = new DedicatedWorkerGlobalScope();
    expect(run({ self: dedicated, SharedWorkerGlobalScope })).toBe(false); // a dedicated worker in a page that has SharedWorker
    expect(run({ self: dedicated })).toBe(false); // a dedicated or service worker where the name does not exist
    expect(dedicated.closed).toBe(false);
  });
});

describe('the hide, kept in place, and the sweep\'s reloads (X\'s loop: a tab open from before the demo)', () => {
  const xEff = () => {
    const p = defaultPolicy();
    p.customSites = [{ id: 'x.com', name: 'X', domains: ['x.com'], enabled: true }];
    return resolveEffective(p);
  };

  it('puts the hide in again when the old one is gone ("Script not found"), instead of leaving the tab without one', async () => {
    const { onTabHeld, reconfigure } = await import('./shared-workers');
    const calls: string[] = [];
    let ids = 0;
    const send = async (_t: unknown, m: string) => {
      calls.push(m);
      if (m === 'Page.removeScriptToEvaluateOnNewDocument') throw new Error('Script not found');
      return m === 'Page.addScriptToEvaluateOnNewDocument' ? { identifier: `s${++ids}` } : {};
    };
    const logs: string[] = [];
    await onTabHeld(71, xEff(), send, (_t, m) => logs.push(m));
    calls.length = 0;
    await reconfigure(xEff(), send, (_t, m) => logs.push(m));
    expect(calls).toEqual(['Page.removeScriptToEvaluateOnNewDocument', 'Page.addScriptToEvaluateOnNewDocument']);
    expect(logs).toEqual([]); // a gone script is no failure
  });

  it('reloads a tab for a SharedWorker at most three times in half a minute, the hide put in afresh before each', async () => {
    const { sweep, onTabReleased, MAX_RELOADS } = await import('./shared-workers');
    onTabReleased(72);
    const reloaded: number[] = [];
    const sent: string[] = [];
    let n = 0;
    (globalThis as unknown as { chrome: unknown }).chrome = {
      debugger: {
        // X's SharedWorker, started again by every load
        getTargets: async () => [{ id: `sw${++n}`, type: 'worker', attached: false, url: 'https://x.com/sw-shared.js' }],
        attach: async () => {}, detach: async () => {},
        sendCommand: async () => ({ result: { value: true } }),
      },
      tabs: { get: async (id: number) => ({ id, url: 'https://x.com/home' }), reload: async (id: number) => { reloaded.push(id); } },
    };
    const logs: string[] = [];
    const send = async (_t: unknown, m: string) => { sent.push(m); return { identifier: 'id' }; };
    for (let i = 0; i < 6; i++) await sweep(xEff(), new Set(), [72], (_t, m) => logs.push(m), send);
    expect(reloaded).toEqual(Array(MAX_RELOADS).fill(72));
    expect(sent.filter((m) => m === 'Page.addScriptToEvaluateOnNewDocument')).toHaveLength(MAX_RELOADS);
    expect(logs.filter((m) => m.startsWith('shared-worker-closed'))).toHaveLength(6); // still closed every time
    expect(logs.filter((m) => m.startsWith('shared-worker-reload-loop'))).toEqual(['shared-worker-reload-loop:x.com: not reloaded again']);
  });
});
