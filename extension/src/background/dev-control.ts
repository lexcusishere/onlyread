// Dev control channel (see control.ts): the same handlers as the popup/options messages, plus secrets, reload
// and a few measurement experiments. The channel exists only in development builds.
import type { Message, Policy } from '../shared/types';
import type { Secrets } from '../shared/providers';
import { carryManaged, setPolicy } from './policy';
import { ownSet } from './owned-storage';
import { normalizeDomains, replaceSessionRule, BLOCK_ALL_RULE_ID, WORKER_ORIGIN_RULE_ID } from './rules';
import * as control from './control';
import * as dbg from './debugger';
import * as typedSecrets from './typed-secrets';
import { refreshRules } from './guard';
import { handle } from './messages';
import { S, attachmentOn, enabledSiteIds, getSecrets, system } from './state';

const controlLabel = async () => `${S.policy.mode} · sites=${enabledSiteIds().join(',') || 'none'} · tabs=${dbg.attachedTabs().length}`;

type Command = control.ControlCommand;

/** Dev experiment: stop every service worker via a guarded tab's debugger session. A channel a worker
 *  opened before the rules existed survives every later rule; stopping the worker is the only way to
 *  drop it from the extension side. */
async function stopWorkers(cmd: Command) {
  const tabId = Number(cmd.tabId);
  const out: string[] = [];
  try {
    await chrome.debugger.sendCommand({ tabId }, 'ServiceWorker.enable');
    await chrome.debugger.sendCommand({ tabId }, 'ServiceWorker.stopAllWorkers');
    await chrome.debugger.sendCommand({ tabId }, 'ServiceWorker.disable');
    out.push('stopAllWorkers ok');
  } catch (err) { out.push(`error: ${err instanceof Error ? err.message : String(err)}`); }
  system(`sw:stop:${out.join(',')}`, tabId);
  return { ok: true, out };
}

/** Dev experiment: refuse EVERY request (all methods, all types, any tab or none) to the guarded domains,
 *  so a hidden carrier can be bisected. Its own session rule; removed with {on:false} or on reload. */
async function setBlockAll(cmd: Command) {
  const on = Boolean(cmd.on);
  const domains = normalizeDomains(S.policy.effective.targetDomains);
  await replaceSessionRule(BLOCK_ALL_RULE_ID, on && domains.length ? { id: BLOCK_ALL_RULE_ID, priority: 300, action: { type: 'block' }, condition: { requestDomains: domains } } : null);
  system(`blockall:${on ? 'on' : 'off'}`);
  return { ok: true, on, domains };
}

/** Dev experiment for agent-session detection: which tabs have a debugger attached, and is it ours? */
async function debugTargets() {
  const ours = new Set(dbg.attachedTabs());
  const targets = await chrome.debugger.getTargets();
  const held = dbg.heldTargetIds();
  const workers = targets.filter((t) => t.type !== 'page' && /^(https?|blob):/.test(t.url)).map((t) => ({ type: t.type, held: held.has(t.id), attached: t.attached, url: t.url.slice(0, 80) }));
  return { ok: true, workerHosts: S.workerHosts, intercepted: dbg.interceptedWorkerHosts(), workers, ours: [...ours], targets: targets.filter((t) => t.type === 'page').map((t) => ({ tabId: t.tabId, attached: t.attached, ours: t.tabId !== undefined && ours.has(t.tabId), url: t.url.slice(0, 80), title: t.title.slice(0, 40) })) };
}

async function setSecrets(cmd: Command) {
  const current = await getSecrets();
  const incoming = (cmd.secrets ?? {}) as Secrets;
  await ownSet({ secrets: { ...current, keys: { ...current.keys, ...incoming.keys } } }); // the background's own write (owned-storage.ts)
  return { ok: true, keys: Object.keys(incoming.keys ?? {}) };
}

function setPolicyCmd(cmd: Command) {
  // A harness policy file carries no Pro account list: the one last written stays (policy.ts carryManaged),
  // as on a reset; a file that names `managed` sets or clears it.
  const patch = cmd.policy as Policy;
  const incoming = 'managed' in patch ? patch : carryManaged({ ...(S.policy.managed ? { managed: S.policy.managed } : {}), ...patch });
  return setPolicy(cmd.keepMode ? { ...incoming, mode: S.policy.mode } : incoming);
}

/** Close the restart window. Dynamic rules survive chrome.runtime.reload(), session rules and the debugger do
 *  not: for a second or two nothing judges and nothing fences worker requests, and a site's retry queue
 *  (Facebook's Messenger uploads retry every minute) can flush through it. Install the fail-closed dynamic
 *  rule now; start() removes it once the tabs are re-attached. */
async function reload() {
  if (S.policy.mode === 'enforce' && attachmentOn()) {
    S.failClosed = true;
    try { await refreshRules(); } catch (err) { console.warn('[onlyread] fail-closed before reload failed:', err); }
  }
  setTimeout(() => chrome.runtime.reload(), 300);
  return { ok: true, reloading: true };
}

/** Sends a synthetic "blocked" notice to a tab so the in-page path can be verified from the harness. */
async function testNotice(cmd: Command) {
  const tabId = Number(cmd.tabId);
  try {
    const r = await chrome.tabs.sendMessage(tabId, { type: 'onlyread:blocked', shape: 'test:w[notice]', reason: 'notice-test', path: '/' } satisfies Message);
    return { ok: true, delivered: true, response: r ?? null };
  } catch (err) {
    return { ok: false, delivered: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function listRules() {
  const rules = await chrome.declarativeNetRequest.getDynamicRules();
  const session = await chrome.declarativeNetRequest.getSessionRules();
  return [
    ...rules.map((r) => ({ id: r.id, scope: 'dynamic', reason: S.ruleReasons.get(r.id), action: r.action.type, condition: r.condition })),
    ...session.map((r) => ({ id: r.id, scope: 'session', reason: r.id === WORKER_ORIGIN_RULE_ID ? 'worker-origin' : undefined, action: r.action.type, condition: r.condition })),
  ];
}

/** Commands only the dev channel has; everything else goes to the popup/options handlers. */
const COMMANDS: Record<string, (cmd: Command) => unknown> = {
  'sw:stop': stopWorkers,
  'blockall:set': setBlockAll,
  'debug:targets': debugTargets,
  // How many typed sensitive values the background holds, and their lengths: never the values.
  'debug:typed-secrets': () => { const k = typedSecrets.known(); return { ok: true, count: k.length, lengths: k.map((v) => v.length) }; },
  // Dev control channel only (the channel does not exist in a distribution build): lets the harness pull the
  // keys the extension actually uses, so .env and the extension cannot drift apart.
  'secrets:get': async () => ({ ok: true, secrets: await getSecrets() }),
  'secrets:set': setSecrets,
  'policy:set': setPolicyCmd,
  reload,
  'notice:test': testNotice,
  'rules:list': listRules,
  // Starts a Pro sign-in in a tab the harness drives (a browser agent cannot open the settings page itself): as the
  // settings page's Sign in does, that tab going to the service and back to the settings page.
  'debug:signin-in-tab': (cmd) => handle({ type: 'cloud:signin' }, { tab: { id: Number(cmd.tabId) } as chrome.tabs.Tab, url: chrome.runtime.getURL('options.html#judge') }),
};

export function initDevControl(): void {
  control.init(async (cmd) => {
    const own = Object.hasOwn(COMMANDS, cmd.type) ? COMMANDS[cmd.type] : undefined;
    return own ? own(cmd) : handle(cmd as Message, {} as chrome.runtime.MessageSender);
  }, controlLabel);
}
