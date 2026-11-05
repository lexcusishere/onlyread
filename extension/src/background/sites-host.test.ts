import { describe, expect, it } from 'vitest';
import { builtinForHost } from './sites';

describe('builtinForHost', () => {
  it('finds the verified site that covers a host, however it is typed', () => {
    expect(builtinForHost('mail.google.com')?.id).toBe('gmail');
    expect(builtinForHost('calendar.google.com')?.id).toBe('calendar');
    expect(builtinForHost('www.linkedin.com')?.id).toBe('linkedin');
    expect(builtinForHost('linkedin.com')?.id).toBe('linkedin');
    expect(builtinForHost('facebook.com')?.id).toBe('facebook');
    expect(builtinForHost('linear.app')?.id).toBe('linear');
  });
  it('finds nothing for other hosts, which become sites guarded by the judge alone', () => {
    expect(builtinForHost('app.example.com')).toBeUndefined();
    expect(builtinForHost('google.com')).toBeUndefined();
    expect(builtinForHost('')).toBeUndefined();
  });
});
