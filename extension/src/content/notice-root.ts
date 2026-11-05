// The refusal notice's shadow root (actions.ts makes it). The demo's coach card (demo-coach.ts), whose own root is
// closed, finds the notice through here to frame it, and closes it when the demo's step 2 is over.

let root: ShadowRoot | null = null;
let hide: () => void = () => {};

export function setNoticeRoot(r: ShadowRoot, hideNotice: () => void): void { root = r; hide = hideNotice; }

/** Closes the notice now, hovered or with its details open. */
export function closeNotice(): void { hide(); }

/** The notice's box while it shows. */
export function noticeBox(): HTMLElement | null {
  const box = root?.querySelector<HTMLElement>('.box');
  return box && box.getBoundingClientRect().width > 0 ? box : null;
}
