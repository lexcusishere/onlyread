import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultPolicy, normalizePolicy } from './policy';

// The first-run demo's state (demo.ts): the policy it sets and puts back, the refusal that ends it, and its time limit.
const session: Record<string, unknown> = {};
vi.stubGlobal('chrome', { storage: { session: {
  get: async (k: string) => ({ [k]: session[k] }),
  set: async (o: Record<string, unknown>) => { Object.assign(session, o); },
  remove: async (k: string) => { delete session[k]; },
} } });
const demo = await import('./demo');

beforeEach(async () => { await demo.endDemo(); });

describe('the first-run demo', () => {
  const prior = () => normalizePolicy({ ...defaultPolicy(), enabled: false, mode: 'monitor', attachWhen: 'agent-session' });

  it('only raises protection for the demo, and puts back what it changed while the site stays guarded', async () => {
    const p = prior();
    const d = await demo.beginDemo('x', p, 7, 1000);
    const during = normalizePolicy(demo.demoPolicy(p, 'x'));
    expect(during).toMatchObject({ enabled: true, mode: 'enforce', attachWhen: 'always', sites: { x: { enabled: true } } });
    expect(normalizePolicy(demo.afterDemoPolicy(during, d.prev))).toMatchObject({ enabled: true, mode: 'monitor', attachWhen: 'agent-session', sites: { x: { enabled: true } } });
    // A second start keeps what the first one changed to put back, not the demo's own settings.
    expect((await demo.beginDemo('linkedin', during, 7)).prev).toEqual(d.prev);
    expect(session.demo).toMatchObject({ site: 'linkedin' });
  });

  it('refuses a site with no demo', async () => {
    await expect(demo.beginDemo('app.example.com', prior(), undefined)).rejects.toThrow(/no demo/);
  });

  it('is ended by the refused write its change sends, not by another write, a check that could not run, or another site', async () => {
    await demo.beginDemo('linkedin', prior(), undefined);
    const stops = vi.fn();
    demo.whenDemoStops(stops);
    const rsc = 'https://www.linkedin.com/flagship-web/rsc-action/actions/server-request';
    await demo.demoRefusal(3, 'x.com', { url: 'https://x.com/i/api/graphql/abc/FavoriteTweet', shape: 'json:queryId,variables' }, 'cached:label');
    await demo.demoRefusal(3, 'www.linkedin.com', { url: rsc, shape: 'json:q' }, 'judge-error:cloud:not_signed_in');
    // A write the page sends by itself as it loads: not the demo's.
    await demo.demoRefusal(3, 'www.linkedin.com', { url: rsc, shape: 'li:rsc:w[notifications.markNotificationsSeen]' }, 'decoded-write');
    expect(stops).not.toHaveBeenCalled();
    await demo.demoRefusal(4, 'www.linkedin.com', { url: rsc, shape: 'li:rsc:w[reactions.create]' }, 'decoded-write');
    await demo.demoRefusal(4, 'www.linkedin.com', { url: rsc, shape: 'li:rsc:w[reactions.create]' }, 'decoded-write');
    expect(stops).toHaveBeenCalledTimes(1);
    expect(demo.demoState()?.stopped?.name).toBe('Create');
  });

  it('folds the follow-ups of its refused write out of the notice, on its own site only, until it ends', async () => {
    await demo.beginDemo('linkedin', prior(), undefined);
    expect(demo.foldsIntoDemo('www.linkedin.com')).toBe(false); // nothing refused yet: the notice says what was
    const rsc = 'https://www.linkedin.com/flagship-web/rsc-action/actions/server-request';
    await demo.demoRefusal(4, 'www.linkedin.com', { url: rsc, shape: 'li:rsc:w[reactions.create]' }, 'decoded-write');
    expect(demo.foldsIntoDemo('www.linkedin.com')).toBe(true); // the app's retries and the beacon after the click
    expect(demo.foldsIntoDemo('x.com')).toBe(false);
    await demo.endDemo();
    expect(demo.foldsIntoDemo('www.linkedin.com')).toBe(false);
  });

  it('runs out after DEMO_TTL_MS, and is found again after the worker restarts', async () => {
    await demo.beginDemo('x', prior(), undefined, 0);
    expect(demo.demoExpired(demo.DEMO_TTL_MS - 1)).toBe(false);
    expect(demo.demoExpired(demo.DEMO_TTL_MS)).toBe(true);
    await demo.readDemo();
    expect(demo.demoState()?.site).toBe('x');
    expect(demo.onDemoSite('mobile.x.com')).toBe(true);
    expect(demo.onDemoSite('www.linkedin.com')).toBe(false);
  });
});
