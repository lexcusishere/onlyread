import { describe, expect, it, vi } from 'vitest';

vi.mock('./debugger', () => ({}));
vi.mock('./rules', async (orig) => ({ ...(await orig<typeof import('./rules')>()) }));
const { judgedWorkerHosts } = await import('./guard');

const w = (id: string, url: string) => ({ id, type: 'worker', url });

describe('judgedWorkerHosts', () => {
  it('judges a host whose every running worker the debugger holds', () => {
    expect(judgedWorkerHosts([w('sw1', 'https://x.com/sw.js')], ['x.com'], new Set(['sw1']))).toEqual(['x.com']);
  });
  it('leaves out dedicated (blob:) workers: their requests carry their tab', () => {
    expect(judgedWorkerHosts([w('sw1', 'https://x.com/sw.js'), w('d1', 'blob:https://x.com/abc')], ['x.com'], new Set(['sw1']))).toEqual(['x.com']);
  });
  it('fences a host with a worker the debugger does not hold (woken with no guarded tab)', () => {
    expect(judgedWorkerHosts([w('sw1', 'https://x.com/sw.js'), w('sw2', 'https://x.com/other-sw.js')], ['x.com'], new Set(['sw1']))).toEqual([]);
  });
  it('counts subdomains, which the rule\'s initiator match also lets past', () => {
    expect(judgedWorkerHosts([w('sw1', 'https://x.com/sw.js'), w('sw3', 'https://api.x.com/sw.js')], ['x.com'], new Set(['sw1']))).toEqual([]);
  });
  it('ignores workers of other sites and pages', () => {
    expect(judgedWorkerHosts([w('sw1', 'https://x.com/sw.js'), w('o', 'https://other.example/sw.js'), { id: 'p', type: 'page', url: 'https://x.com/' }], ['x.com'], new Set(['sw1']))).toEqual(['x.com']);
  });
});
