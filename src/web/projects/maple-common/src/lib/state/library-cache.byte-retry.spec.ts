// #2407: transient byte-fetch failures get a bounded retry instead of
// surfacing as a permanent blank canvas on the first blip.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { isTransientFetchError, withTransientRetry } from './library-cache.byte-retry';

function httpError(status: number): { status: number; url: string } {
  return { status, url: '/api/image/lib/2026/a.dng' };
}

describe('isTransientFetchError', () => {
  it('is true for status 0 (network/CORS failure)', () => {
    expect(isTransientFetchError(httpError(0))).toBe(true);
  });

  it('is true for 429 and every 5xx', () => {
    expect(isTransientFetchError(httpError(429))).toBe(true);
    expect(isTransientFetchError(httpError(500))).toBe(true);
    expect(isTransientFetchError(httpError(503))).toBe(true);
    expect(isTransientFetchError(httpError(599))).toBe(true);
  });

  it('is false for 4xx (404/403/401) and for a statusless error', () => {
    expect(isTransientFetchError(httpError(404))).toBe(false);
    expect(isTransientFetchError(httpError(403))).toBe(false);
    expect(isTransientFetchError(httpError(401))).toBe(false);
    expect(isTransientFetchError(new Error('boom'))).toBe(false);
  });
});

describe('withTransientRetry', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('retries a transient failure and resolves once the attempt succeeds', async () => {
    const attempt = vi.fn().mockRejectedValueOnce(httpError(503)).mockResolvedValueOnce('bytes');

    const promise = withTransientRetry(attempt);
    await vi.runAllTimersAsync();

    await expect(promise).resolves.toBe('bytes');
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it('rejects immediately on a non-transient failure, no retry', async () => {
    const attempt = vi.fn().mockRejectedValue(httpError(404));

    await expect(withTransientRetry(attempt)).rejects.toEqual(httpError(404));
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('gives up after the third attempt and rejects with the last error', async () => {
    const attempt = vi.fn().mockRejectedValue(httpError(0));

    const promise = withTransientRetry(attempt);
    const assertion = expect(promise).rejects.toEqual(httpError(0));
    await vi.runAllTimersAsync();
    await assertion;

    expect(attempt).toHaveBeenCalledTimes(3);
  });
});
