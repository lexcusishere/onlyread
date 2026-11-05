// The setup window's first-run demo (background/demo.ts): after the judge step, pick a verified site to try one change
// on. The site opens in the person's own browser window and this window closes; the coach card on the site guides the
// demo and shows its summary there (content/demo-coach.ts). It can be skipped.
import type { Message, SiteView } from '../shared/types';
import { DEMO_SITES } from '../shared/demo-sites';
import { iconImg, installIconFallbacks } from '../popup/ui';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
type Step = 'step-judge' | 'step-demo';

/** Shows one step, coming in with a soft rise. */
export function go(step: Step): void {
  for (const s of document.querySelectorAll<HTMLElement>('section.step')) {
    const on = s.id === step;
    s.hidden = !on;
    s.classList.toggle('enter', on);
  }
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

let close: () => void = () => window.close();
let tilesDrawn = false;

/** The demo's choice of site, drawn once with each site's own icon. */
async function drawTiles(): Promise<void> {
  if (tilesDrawn) return;
  tilesDrawn = true;
  const views = (await chrome.runtime.sendMessage({ type: 'sites:list' }).catch(() => [])) as SiteView[];
  $('demo-tiles').replaceChildren(...DEMO_SITES.map((d, i) => {
    const v = views.find((x) => x.id === d.id);
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = 'tile';
    tile.style.setProperty('--i', String(i));
    const ic = document.createElement('span');
    ic.className = 'logo'; // the shared icon box, whose images fall back to the drawn icon (popup/ui.ts)
    ic.append(iconImg({ id: d.id, builtin: true, domains: v?.domains ?? [new URL(d.url).hostname], iconUrl: v?.iconUrl }));
    const text = document.createElement('span');
    text.className = 'txt';
    text.append(Object.assign(document.createElement('b'), { textContent: d.name }), Object.assign(document.createElement('span'), { textContent: d.action }));
    tile.append(ic, text);
    tile.addEventListener('click', () => void start(d.id, tile));
    return tile;
  }));
  installIconFallbacks();
}

/** Starts the demo on the site, which opens in the person's own window; this window has nothing more to do. */
async function start(site: string, tile: HTMLElement): Promise<void> {
  tile.classList.add('busy');
  const out = $('demo-result');
  out.textContent = '';
  try {
    const r = (await chrome.runtime.sendMessage({ type: 'demo:start', site } satisfies Message)) as { ok?: boolean; error?: string } | undefined;
    if (!r?.ok) throw new Error(r?.error ?? 'The demo could not start.');
    close();
  } catch (err) {
    out.textContent = err instanceof Error ? err.message.replace(/^locked:[a-z-]+:/, '') : String(err);
    out.className = 'result warn';
    tile.classList.remove('busy');
  }
}

/** The demo step. `again`: opened for the demo alone, after setup, so leaving it is Close rather than Skip demo. */
export function showDemo(again = false): void {
  void drawTiles();
  if (again) $('demo-skip').textContent = 'Close';
  go('step-demo');
}

/** "Skip demo", and "Close" on a demo opened again later: back to OnlyRead's page (the Pro account page in Pro mode,
 *  else the settings page), in the tab already showing it if there is one, and this window closes. */
export function installDemo(closeWindow: () => void): void {
  close = closeWindow;
  $('demo-skip').addEventListener('click', () => {
    void chrome.runtime.sendMessage({ type: 'settings:open', section: 'overview' }).catch(() => {}).finally(close);
  });
}
