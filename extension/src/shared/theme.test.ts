import { describe, it, expect } from 'vitest';
import { normalizeTheme, themeAttribute, applyTheme } from './theme';

describe('theme choice', () => {
  it('normalizes anything but light/dark to system', () => {
    expect(normalizeTheme('light')).toBe('light');
    expect(normalizeTheme('dark')).toBe('dark');
    for (const v of ['system', 'auto', '', undefined, null, 1, {}]) expect(normalizeTheme(v)).toBe('system');
  });
  it('system stamps no attribute so prefers-color-scheme decides; light/dark stamp themselves', () => {
    expect(themeAttribute('system')).toBeUndefined();
    expect(themeAttribute('light')).toBe('light');
    expect(themeAttribute('dark')).toBe('dark');
  });
  it('applyTheme sets and removes data-theme on the given root', () => {
    const root = { dataset: {} as Record<string, string> } as unknown as HTMLElement;
    applyTheme('dark', root); expect(root.dataset.theme).toBe('dark');
    applyTheme('light', root); expect(root.dataset.theme).toBe('light');
    applyTheme('system', root); expect(root.dataset.theme).toBeUndefined();
  });
});
