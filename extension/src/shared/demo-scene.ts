// The demo scene that the setup window and the settings page's no-judge view open with (welcome.css .scene): a
// browser on one made-up app at a time (a professional network, mail, team chat, tasks), in which an AI agent tries
// one change and OnlyRead refuses it with the same notice a guarded page shows. Each app plays its 8 s story once (CSS
// under .play), then the next comes in. With reduced motion, the first app shows still, its notice already up.
// The markup is fixed text, with no outside input in it.

const STORY_MS = 8000;

// The apps are half skeletons: only the words that tell the story stay (what the agent types, where it goes, the line
// that says it should not), with grey bars for the rest, so the eye goes to the agent, the button it presses and
// OnlyRead's notice, and the scene stays in the background of the setup window. Every button the agent presses is at
// the right, so the notice (bottom left, over the empty corner) never hides it.
const ICON = (d: string, size = 15): string =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const SEND_ICON = '<path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z"/>';
const TRASH_ICON = '<path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/>';
/** A grey bar standing for a line of text. */
const SK = (w: number | string): string => `<i class="sk" style="--w:${typeof w === 'number' ? `${w}px` : w}"></i>`;
const BAR = (host: string): string =>
  `<div class="scene-bar"><span class="nav">${ICON('<path d="M15 18l-6-6 6-6"/>')}${ICON('<path d="M9 18l6-6-6-6"/>')}${ICON('<path d="M21 12a9 9 0 1 1-2.6-6.4M21 4v5h-5"/>')}</span>` +
  `<span class="url">${ICON('<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>', 11)}<b>${host}</b></span><span class="ext" title="OnlyRead"><img src="assets/icon-32.png" alt=""></span></div>`;
const RAIL = '<div class="rail"><span class="pen"></span><span class="on"></span><span></span><span></span><span></span></div>';
const AGENT =
  '<span class="agent"><svg width="18" height="20" viewBox="0 0 18 20"><path d="M1 1v15l4.2-3.9 2.8 6.4 2.9-1.3-2.8-6.3H14z" fill="#fff" stroke="#1d1320" stroke-width="1.4" stroke-linejoin="round"/></svg>' +
  `<span class="tag">${ICON('<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/>', 11)}AI agent</span></span>`;
/** The agent's words going in, `w` their width once typed. */
const TYPED = (w: number, text: string): string => `<div class="text"><span class="typed" style="--w:${w}px">${text}</span><span class="caret"></span></div>`;
const NOTICE = (app: string, change: string): string =>
  `<div class="notice"><img src="assets/icon-128.png" alt=""><div><div class="t">OnlyRead kept ${app} read-only</div><div>Stopped a change: ${change}.</div><div class="b"><span>Details</span><span>Dismiss</span></div></div></div>`;
const SLIDE = (host: string, pane: string, notice: string): string =>
  `<div class="slide">${BAR(host)}<div class="app">${RAIL}<div class="pane">${pane}</div>${notice}</div></div>`;

const SCENE_HTML = [
  SLIDE('network',
    `<div class="profile"><span class="avatar big"></span><div class="who"><b>Rachel Kim</b>${SK(130)}</div><span class="pbtn">${SK(46)}</span></div>` +
    `<div class="compose"><div class="to">Add a note to your invitation</div>${TYPED(330, 'Hi Rachel, saw your post on outbound. Quick chat?')}<div class="actions"><span class="target end push"><span class="send hit">Send invitation</span>${AGENT}</span></div></div>`,
    NOTICE('Network', 'Send invitation')),
  SLIDE('mail',
    `<div class="thread"><span class="avatar"></span><div class="who">${SK(80)}${SK(130)}</div></div><div class="msg">Please keep the Q3 draft internal until Friday.</div>` +
    `<div class="compose"><div class="to">To <i>whole-team@</i></div>${TYPED(270, 'Sharing the Q3 numbers with everyone now.')}<div class="actions"><span class="target end push"><span class="send hit">Send${ICON(SEND_ICON, 12)}</span>${AGENT}</span></div></div>`,
    NOTICE('Mail', 'Send email')),
  SLIDE('chat',
    `<div class="channel"><b># general</b></div>` +
    `<div class="post"><span class="avatar"></span><div>${SK(70)}<p>Reminder: the launch date stays under wraps until Monday.</p></div></div>` +
    `<div class="post"><span class="avatar"></span><div>${SK(60)}${SK(150)}</div></div>` +
    `<div class="compose chatbox">${TYPED(300, 'Posting the launch date to #announcements')}<div class="actions"><span class="target end"><span class="send hit icon">${ICON(SEND_ICON, 13)}</span>${AGENT}</span></div></div>`,
    NOTICE('Chat', 'Post message')),
  SLIDE('tasks',
    `<div class="channel">${SK(100)}</div>` +
    `<div class="issue"><span class="st done"></span>${SK('55%')}</div>` +
    `<div class="issue sel"><span class="st"></span><b>Migrate customer accounts</b><span class="kebab"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg></span>` +
    `<div class="menu"><span class="mi">${SK(64)}</span><span class="target end"><span class="mi hit danger">${ICON(TRASH_ICON, 13)}Delete issue</span>${AGENT}</span></div></div>`,
    NOTICE('Tasks', 'Delete issue')),
].join('\n');

/** Fills `host` (an empty `.scene`) once and starts its loop. */
export function mountScene(host: HTMLElement | null): void {
  if (!host || host.childElementCount) return;
  host.innerHTML = SCENE_HTML;
  const slides = [...host.querySelectorAll<HTMLElement>('.slide')];
  // Once every app has played its story, the scene fades back slowly (welcome.css .scene.dim), leaving the eye to Pro.
  setTimeout(() => host.classList.add('dim'), STORY_MS * slides.length);
  if (!slides.length) return;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) { slides[0]!.classList.add('on'); return; }
  let i = 0;
  const show = (): void => {
    slides.forEach((s, k) => { s.classList.toggle('on', k === i); s.classList.remove('play'); });
    void slides[i]!.offsetWidth; // restart the story's animations
    slides[i]!.classList.add('play');
    i = (i + 1) % slides.length;
  };
  show();
  setInterval(show, STORY_MS);
}
