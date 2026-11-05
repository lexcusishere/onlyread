// Appearance: System (follow prefers-color-scheme), Light or Dark. One stored value, applied by every
// extension page by stamping data-theme on <html>; ui.css keys its palette on that attribute.
export type Theme = 'system' | 'light' | 'dark';

export function normalizeTheme(v: unknown): Theme {
  return v === 'light' || v === 'dark' ? v : 'system';
}

/** The data-theme value for a choice: none for System, so the media query decides. */
export function themeAttribute(t: Theme): 'light' | 'dark' | undefined {
  return t === 'system' ? undefined : t;
}

export function applyTheme(t: Theme, root: HTMLElement = document.documentElement): void {
  const v = themeAttribute(t);
  if (v) root.dataset.theme = v; else delete root.dataset.theme;
}

/** Read the stored choice, apply it, and follow later changes (the options page saving a new one). */
export async function initTheme(): Promise<Theme> {
  let t: Theme = 'system';
  try { t = normalizeTheme((await chrome.storage.local.get('theme')).theme); } catch { /* storage unavailable: system */ }
  applyTheme(t);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.theme) applyTheme(normalizeTheme(changes.theme.newValue));
  });
  return t;
}

export async function setTheme(t: Theme): Promise<void> {
  applyTheme(t);
  await chrome.storage.local.set({ theme: t });
}
