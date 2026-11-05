// OnlyRead Pro's agent-setup page (background/agent-setup.ts): tells the page that OnlyRead is installed
// and what it guards, and passes the setup on when the page's Apply button is really clicked. Only a click the
// browser marks trusted counts (a person's, or an agent's through the debugger): the page's own script cannot
// press it, so a site that opens the page changes nothing. A setup link's code is the exception: it is sent as the
// page loads, and the background runs it then only on a fresh install, else after a real click on Connect. The
// background takes these messages only from the service this browser uses, top frame; on any other page with this
// path they are nothing.
import { AGENT_SETUP_PATH, MAX_SETUP_SITES, SETUP_LINK_KEY } from '../shared/agent-setup';

const FROM_PAGE = 'onlyread-setup-page';
const FROM_EXTENSION = 'onlyread-extension';

function post(type: 'status' | 'result' | 'link' | 'agent', data: unknown): void {
  window.postMessage({ source: FROM_EXTENSION, type, data }, location.origin);
}

async function ask(msg: unknown): Promise<unknown> {
  try { return await chrome.runtime.sendMessage(msg); } catch { return undefined; } // the extension reloaded
}

/** The setup link's last answer, sent again on each hello: it can come before the page's own script listens. */
let lastLink: unknown;

async function hello(): Promise<void> {
  const status = await ask({ type: 'page:agent-setup-hello' });
  if (status) post('status', status);
  if (lastLink) post('link', lastLink);
}

const field = (id: string) => document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement | null;
const ticked = (id: string) => (field(id) as HTMLInputElement | null)?.checked === true;

/** A setup link's code, from the address fragment (which never reaches a server). */
function linkCode(): string | undefined {
  return new URLSearchParams(location.hash.slice(1)).get(SETUP_LINK_KEY) ?? undefined;
}

async function apply(): Promise<void> {
  const sites = (field('onlyread-sites')?.value ?? '').split(/[\n,]+/).map((s) => s.trim()).filter(Boolean).slice(0, MAX_SETUP_SITES);
  const result = await ask({ type: 'page:agent-setup-apply', sites, allTabs: ticked('onlyread-all-tabs') });
  if (result) post('result', result);
  void hello();
}

/** A setup link: sent as the page loads, and again on a real click if the extension asks for one (background
 *  agent-setup.ts linkRunsByItself). Once it has run, the code leaves the address: it is good once. */
async function useLink(clicked: boolean): Promise<void> {
  const connect = linkCode();
  if (!connect) return;
  const result = await ask({ type: 'page:agent-setup-link', connect, clicked }) as { needsClick?: boolean } | undefined;
  if (!result) return;
  if (!result.needsClick) history.replaceState(history.state, '', location.pathname + location.search);
  lastLink = result;
  void hello();
}

export function installAgentSetup(): void {
  // The path's end only: the service's address may have a path of its own (the background checks the whole of it).
  if (window !== window.top || !location.pathname.replace(/\/$/, '').endsWith(AGENT_SETUP_PATH)) return;
  // The page asks once it is ready (at document_start its listener is not there yet).
  addEventListener('message', (e) => {
    if (e.source === window && (e.data as { source?: string; type?: string } | null)?.source === FROM_PAGE && e.data.type === 'hello') void hello();
  });
  document.addEventListener('click', (e) => {
    if (!e.isTrusted || !(e.target instanceof Element)) return;
    const agent = e.target.closest('[data-onlyread-agent]')?.getAttribute('data-onlyread-agent');
    if (e.target.closest('#onlyread-apply')) void apply();
    else if (e.target.closest('#onlyread-connect')) void useLink(true);
    else if (agent) void ask({ type: 'page:agent-setup-agent', agent, name: field('onlyread-agent-name')?.value ?? '' }).then((r) => { if (r) post('agent', r); });
  }, true);
  void hello();
  void useLink(false);
}
