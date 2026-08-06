import { describe, expect, it } from 'vitest';
import { isChromiumV8Runtime, planThreading } from './threading-runtime-policy';

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
  ])('needs the #2516 pre-grow guard before starting Rayon workers: %s', (userAgent) => {
    expect(isChromiumV8Runtime(userAgent)).toBe(true);
  });

  it.each([
    'Mozilla/5.0 Firefox/147.0',
    'Mozilla/5.0 Version/26.0 Safari/605.1.15',
    'Mozilla/5.0 CriOS/150.0.0.0 Mobile/15E148 Safari/604.1',
  ])('skips the pre-grow guard on non-V8 runtimes: %s', (userAgent) => {
    expect(isChromiumV8Runtime(userAgent, [{ brand: 'Not A(Brand' }])).toBe(false);
  });
});

describe('planThreading', () => {
  const TARGET_MIB = 3584;

  it('stays serial when the bundle has no thread pool export (GPU-only build)', () => {
    expect(
      planThreading(
        {
          crossOriginIsolated: true,
          isChromiumV8: false,
          hasThreadPool: false,
          hasHeapGuard: true,
        },
        TARGET_MIB,
      ),
    ).toEqual({ kind: 'serial' });
  });

  it('stays serial without cross-origin isolation, even on a safe runtime', () => {
    expect(
      planThreading(
        {
          crossOriginIsolated: false,
          isChromiumV8: false,
          hasThreadPool: true,
          hasHeapGuard: true,
        },
        TARGET_MIB,
      ),
    ).toEqual({ kind: 'serial' });
  });

  it('threads non-Chromium runtimes without requiring the heap guard (#2515 never applied to them)', () => {
    expect(
      planThreading(
        {
          crossOriginIsolated: true,
          isChromiumV8: false,
          hasThreadPool: true,
          hasHeapGuard: false,
        },
        TARGET_MIB,
      ),
    ).toEqual({ kind: 'threaded', heapGuardTargetMib: null });
  });

  it('stays serial on Chromium when the #2516 heap guard export is missing (pre-#2516 bundle)', () => {
    expect(
      planThreading(
        { crossOriginIsolated: true, isChromiumV8: true, hasThreadPool: true, hasHeapGuard: false },
        TARGET_MIB,
      ),
    ).toEqual({ kind: 'serial' });
  });

  it('threads Chromium WITH the heap guard target when the guard export is present', () => {
    expect(
      planThreading(
        { crossOriginIsolated: true, isChromiumV8: true, hasThreadPool: true, hasHeapGuard: true },
        TARGET_MIB,
      ),
    ).toEqual({ kind: 'threaded', heapGuardTargetMib: TARGET_MIB });
  });
});
