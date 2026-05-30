import { describe, expect, it } from 'bun:test';
import { BACKOFF_MS, POLL_INTERVAL_MS, deriveBatchSize, nextPollDelay } from './loop-policy.ts';

describe('deriveBatchSize', () => {
  it('is 5× concurrency', () => {
    expect(deriveBatchSize(1)).toBe(5);
    expect(deriveBatchSize(2)).toBe(10);
    expect(deriveBatchSize(100)).toBe(500);
  });
});

describe('nextPollDelay', () => {
  it('re-polls immediately (0) after a full batch', () => {
    // concurrency 4 → derived batch 20; a full batch means backlog remains.
    expect(
      nextPollDelay({ claimed: 20, concurrency: 4, paused: false, consecutiveErrors: 0 }),
    ).toBe(0);
  });

  it('waits the global idle interval after a non-full batch', () => {
    expect(
      nextPollDelay({ claimed: 19, concurrency: 4, paused: false, consecutiveErrors: 0 }),
    ).toBe(POLL_INTERVAL_MS);
    // Drained (claimed 0) also idles.
    expect(nextPollDelay({ claimed: 0, concurrency: 4, paused: false, consecutiveErrors: 0 })).toBe(
      POLL_INTERVAL_MS,
    );
  });

  it('never short-circuits to 0 while paused', () => {
    // Paused runs return claimed 0, but guard defensively against a stale full.
    expect(nextPollDelay({ claimed: 20, concurrency: 4, paused: true, consecutiveErrors: 0 })).toBe(
      POLL_INTERVAL_MS,
    );
  });

  it('overrides everything with exponential backoff on error', () => {
    expect(
      nextPollDelay({ claimed: 20, concurrency: 4, paused: false, consecutiveErrors: 1 }),
    ).toBe(BACKOFF_MS[0]);
    expect(
      nextPollDelay({ claimed: 20, concurrency: 4, paused: false, consecutiveErrors: 3 }),
    ).toBe(BACKOFF_MS[2]);
  });

  it('saturates backoff at the last BACKOFF_MS entry', () => {
    expect(
      nextPollDelay({ claimed: 0, concurrency: 4, paused: false, consecutiveErrors: 999 }),
    ).toBe(BACKOFF_MS[BACKOFF_MS.length - 1]);
  });
});
