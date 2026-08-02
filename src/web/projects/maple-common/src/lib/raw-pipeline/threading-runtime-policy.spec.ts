import { describe, expect, it } from 'vitest';
import { isChromiumV8Runtime } from './threading-runtime-policy';

describe('isChromiumV8Runtime', () => {
  it.each(['Chromium', 'Google Chrome', 'Microsoft Edge', 'Opera', 'Brave'])(
    'uses the UA-CH %s brand when the legacy UA is reduced',
    (brand) => {
      expect(isChromiumV8Runtime('Mozilla/5.0 Safari/537.36', [{ brand }])).toBe(true);
    },
  );

  it.each([
    'Mozilla/5.0 Chrome/150.0.0.0 Safari/537.36',
    'Mozilla/5.0 Chromium/150.0.0.0 Safari/537.36',
    'Mozilla/5.0 Edg/150.0.0.0 Chrome/150.0.0.0 Safari/537.36',
    'Mozilla/5.0 OPR/120.0.0.0 Chrome/135.0.0.0 Safari/537.36',
  ])('keeps V8 worker-isolate memory growth serial: %s', (userAgent) => {
    expect(isChromiumV8Runtime(userAgent)).toBe(true);
  });

  it.each([
    'Mozilla/5.0 Firefox/147.0',
    'Mozilla/5.0 Version/26.0 Safari/605.1.15',
    'Mozilla/5.0 CriOS/150.0.0.0 Mobile/15E148 Safari/604.1',
  ])('allows supported non-V8 runtimes to use Rayon: %s', (userAgent) => {
    expect(isChromiumV8Runtime(userAgent, [{ brand: 'Not A(Brand' }])).toBe(false);
  });
});
