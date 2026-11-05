import { describe, expect, it } from 'vitest';
import { framedByService } from './framed';

// The framed settings page shows anything only inside the Pro service's own page (options/framed.ts).
describe('framedByService', () => {
  const pro = 'https://pro.onlyread.ai';
  it('takes exactly one ancestor, the service\'s origin', () => {
    expect(framedByService(['https://pro.onlyread.ai'], pro)).toBe(true);
    expect(framedByService(['https://pro.onlyread.ai'], `${pro}/`)).toBe(true);
    expect(framedByService(['http://localhost:4173'], 'http://localhost:4173/cloud')).toBe(true);
  });
  it('refuses any other page, a frame inside a frame, no frame at all, and a broken address', () => {
    expect(framedByService(['https://evil.example'], pro)).toBe(false);
    expect(framedByService(['https://pro.onlyread.ai.evil.example'], pro)).toBe(false);
    expect(framedByService(['http://pro.onlyread.ai'], pro)).toBe(false);
    expect(framedByService(['https://pro.onlyread.ai', 'https://pro.onlyread.ai'], pro)).toBe(false);
    expect(framedByService(['https://evil.example', 'https://pro.onlyread.ai'], pro)).toBe(false);
    expect(framedByService([], pro)).toBe(false);
    expect(framedByService(['https://pro.onlyread.ai'], 'not a url')).toBe(false);
  });
});
