// Development builds only: the settings page, the popup and the setup window reload themselves when `npm run dev`
// rebuilt only them (background/dev-reload.ts sends the word). A release build keeps an empty function.
declare const __ONLYREAD_DIST__: boolean;

export function reloadOnDevBuild(): void {
  // The build defines the flag; unit tests do not (typeof keeps them running).
  if (typeof __ONLYREAD_DIST__ !== 'undefined' && __ONLYREAD_DIST__) return;
  chrome.runtime.onMessage?.addListener((msg: unknown) => {
    if ((msg as { type?: unknown } | null)?.type === 'dev:reload-pages') location.reload();
  });
}
