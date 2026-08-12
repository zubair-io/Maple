// Unit tests for safeReturnUrl (#2798 review): the guard-provided returnUrl
// must only ever redirect within the app — a crafted sign-in link must not
// turn a successful login into an open redirect.

import { describe, it, expect } from 'vitest';
import { safeReturnUrl } from './sign-in.component';

describe('safeReturnUrl', () => {
  it('falls back to / when absent', () => {
    expect(safeReturnUrl(null)).toBe('/');
    expect(safeReturnUrl('')).toBe('/');
  });

  it('accepts internal paths', () => {
    expect(safeReturnUrl('/open-file')).toBe('/open-file');
    expect(safeReturnUrl('/edit/abc?x=1')).toBe('/edit/abc?x=1');
  });

  it('rejects absolute and scheme-relative URLs', () => {
    expect(safeReturnUrl('https://evil.example/phish')).toBe('/');
    expect(safeReturnUrl('//evil.example/phish')).toBe('/');
    expect(safeReturnUrl('javascript:alert(1)')).toBe('/');
  });
});
