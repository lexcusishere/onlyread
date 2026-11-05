import { describe, it, expect } from 'vitest';
import { shouldPromptForKey } from './setup';
import { hasAnyKey } from '../shared/providers';

describe('first-install judge prompt', () => {
  it('prompts on a fresh install with no key', () => {
    expect(shouldPromptForKey('install', {})).toBe(true);
    expect(shouldPromptForKey('install', undefined)).toBe(true);
    expect(shouldPromptForKey('install', { keys: { openrouter: '   ' } })).toBe(true);
  });
  it('never prompts when any provider key is already stored (a dev profile seeded through ctl.py secrets)', () => {
    expect(shouldPromptForKey('install', { keys: { openrouter: 'sk-or-x' } })).toBe(false);
    expect(shouldPromptForKey('install', { keys: { vercel: 'vck_x' } })).toBe(false);
  });
  it('never prompts on update, dev reload or startup', () => {
    expect(shouldPromptForKey('update', {})).toBe(false);
    expect(shouldPromptForKey('chrome_update', {})).toBe(false);
    expect(shouldPromptForKey(undefined, {})).toBe(false);
  });
  it('hasAnyKey trims', () => { expect(hasAnyKey({ keys: { vercel: ' ' } })).toBe(false); expect(hasAnyKey({ keys: { vercel: ' k ' } })).toBe(true); });
});
