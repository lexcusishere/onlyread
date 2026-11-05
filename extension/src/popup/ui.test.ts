import { describe, expect, it } from 'vitest';
import { samePixels } from './ui';

// The favicon cache's default globe is recognised by its pixels: only an exact match counts as the globe.
describe('samePixels', () => {
  const px = (...v: number[]) => new Uint8ClampedArray(v);
  it('matches identical pixels', () => { expect(samePixels(px(1, 2, 3, 255), px(1, 2, 3, 255))).toBe(true); });
  it('rejects one differing value or a different size', () => {
    expect(samePixels(px(1, 2, 3, 255), px(1, 2, 4, 255))).toBe(false);
    expect(samePixels(px(1, 2, 3, 255), px(1, 2, 3, 255, 0, 0, 0, 0))).toBe(false);
  });
  it('never matches when either image could not be read', () => {
    expect(samePixels(undefined, px(0))).toBe(false);
    expect(samePixels(px(0), undefined)).toBe(false);
  });
});
