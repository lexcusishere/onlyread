// Shared by the agent-setup page's content script and the background (background/agent-setup.ts).

/** The Pro service's agent-setup page. */
export const AGENT_SETUP_PATH = '/agent-setup';
/** At most this many sites in one setup. */
export const MAX_SETUP_SITES = 30;
/** A setup link's one-time code, as the Pro service makes it (32 random bytes, base64url). */
export const SETUP_LINK_CODE = /^[A-Za-z0-9_-]{43}$/;
/** The key in the setup page's address fragment that carries it (#connect=…). */
export const SETUP_LINK_KEY = 'connect';
/** The AI agents a browser can say it is run by (the setup page's "Which agent are you?"); the Pro service's account
 *  page shows the name and mark (its lib/browser-info.ts AGENTS). */
const AGENT_NAMES = ['grok', 'chatgpt', 'claude', 'comet', 'cowork', 'codex'] as const;
export type AgentName = (typeof AGENT_NAMES)[number];
export const isAgentName = (v: unknown): v is AgentName => (AGENT_NAMES as readonly unknown[]).includes(v);
/** The name the agent gives this browser on the setup page, as the account page shows it: at most this long. */
const MAX_BROWSER_NAME = 40;
/** A name as kept: control characters dropped, spaces collapsed, cut to MAX_BROWSER_NAME; undefined when empty. */
export function browserNameOf(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const printable = [...v].filter((c) => { const n = c.charCodeAt(0); return n > 31 && n !== 127; }).join('');
  const s = printable.replace(/\s+/g, ' ').trim().slice(0, MAX_BROWSER_NAME);
  return s || undefined;
}
