/**
 * Per-asset retry backoff policy (#2729).
 *
 * Pure-function coverage for `retryDelayMs`. The runner-side wiring — the
 * claim-query gate and the fields written on failure — is covered in
 * `run-stage.retry-backoff.test.ts`.
 */

import { describe, expect, it } from 'bun:test';
import { RETRY_BACKOFF_MS, retryDelayMs } from './loop-policy.ts';

/** Jitter is ±20%, so a deterministic 0.5 draw returns the base exactly. */
const NO_JITTER = () => 0.5;

describe('retryDelayMs', () => {
  it('walks the ladder by attempt number', () => {
    expect(retryDelayMs(1, NO_JITTER)).toBe(RETRY_BACKOFF_MS[0]!);
    expect(retryDelayMs(2, NO_JITTER)).toBe(RETRY_BACKOFF_MS[1]!);
    expect(retryDelayMs(3, NO_JITTER)).toBe(RETRY_BACKOFF_MS[2]!);
  });

  it('saturates rather than growing without bound', () => {
    const last = RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1]!;
    expect(retryDelayMs(RETRY_BACKOFF_MS.length, NO_JITTER)).toBe(last);
    expect(retryDelayMs(99, NO_JITTER)).toBe(last);
  });

  // attemptNo is 1-based; a 0 or negative would index off the front of the
  // ladder and produce `undefined * n` → NaN, which would be written into
  // Mongo as an Invalid Date and silently park the asset forever.
  it('clamps a non-positive attempt to the first rung', () => {
    expect(retryDelayMs(0, NO_JITTER)).toBe(RETRY_BACKOFF_MS[0]!);
    expect(retryDelayMs(-5, NO_JITTER)).toBe(RETRY_BACKOFF_MS[0]!);
  });

  it('applies ±20% jitter at the extremes of the random draw', () => {
    const base = RETRY_BACKOFF_MS[0]!;
    expect(retryDelayMs(1, () => 0)).toBe(Math.round(base * 0.8));
    expect(retryDelayMs(1, () => 0.999999)).toBeLessThanOrEqual(Math.round(base * 1.2));
    expect(retryDelayMs(1, () => 0.999999)).toBeGreaterThan(Math.round(base * 1.19));
  });

  // Stage failures arrive correlated — when a provider dies, every in-flight
  // asset fails within the same second. Without jitter the whole batch would
  // march back at the same instant and knock it over again on the way up.
  it('spreads a correlated batch across a window', () => {
    const draws = Array.from({ length: 200 }, () => retryDelayMs(1));
    expect(new Set(draws).size).toBeGreaterThan(50);
  });

  it('never returns a delay that would make an asset claimable immediately', () => {
    for (let attempt = 1; attempt <= 10; attempt++) {
      expect(retryDelayMs(attempt)).toBeGreaterThan(0);
    }
  });
});
