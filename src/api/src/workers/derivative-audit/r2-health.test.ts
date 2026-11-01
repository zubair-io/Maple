import { describe, expect, it } from 'bun:test';
import { createR2Health, FailureDigest, R2_TRIP_AFTER_CONSECUTIVE_FAILURES } from './r2-health.ts';

const dnsFailure = () =>
  Object.assign(new Error('getaddrinfo EAI_AGAIN abc.r2.cloudflarestorage.com'), {
    code: 'EAI_AGAIN',
  });
const timeout = () => new DOMException('The operation timed out.', 'TimeoutError');

describe('createR2Health', () => {
  it('reports "could not tell" instead of absent when the network fails', async () => {
    const health = createR2Health();
    const head = health.guard(async () => {
      throw dnsFailure();
    });

    expect(await head('k')).toBeNull();
    expect(health.deferred).toBe(1);
    expect(health.digest.count).toBe(1);
    expect(health.tripped).toBe(false);
  });

  it('passes real answers through, including absent', async () => {
    const health = createR2Health();
    expect(await health.guard(async () => true)('k')).toBe(true);
    expect(await health.guard(async () => false)('k')).toBe(false);
    expect(health.deferred).toBe(0);
  });

  it('rethrows an answer that is not a network failure', async () => {
    const health = createR2Health();
    const head = health.guard(async () => {
      throw new Error('R2 head failed (403): denied');
    });
    await expect(head('k')).rejects.toThrow('403');
    expect(health.deferred).toBe(0);
  });

  it('trips after consecutive failures and stops issuing lookups', async () => {
    const health = createR2Health();
    let calls = 0;
    const head = health.guard(async () => {
      calls++;
      throw timeout();
    });

    for (let i = 0; i < R2_TRIP_AFTER_CONSECUTIVE_FAILURES + 10; i++) await head(`k${i}`);

    expect(health.tripped).toBe(true);
    expect(calls).toBe(R2_TRIP_AFTER_CONSECUTIVE_FAILURES);
    expect(health.deferred).toBe(R2_TRIP_AFTER_CONSECUTIVE_FAILURES + 10);
    expect(health.digest.count).toBe(R2_TRIP_AFTER_CONSECUTIVE_FAILURES);
  });

  it('does not trip when successes interleave the failures', async () => {
    const health = createR2Health();
    let n = 0;
    const head = health.guard(async () => {
      if (n++ % 2 === 0) throw dnsFailure();
      return true;
    });

    for (let i = 0; i < R2_TRIP_AFTER_CONSECUTIVE_FAILURES * 3; i++) await head('k');

    expect(health.tripped).toBe(false);
  });
});

describe('FailureDigest', () => {
  it('keeps the first and last error and one sample however many were added', () => {
    const digest = new FailureDigest();
    digest.add('row-1', 'first');
    digest.add('row-2', 'middle');
    digest.add('row-3', 'last');

    expect(digest.fields()).toEqual({
      count: 3,
      firstError: 'first',
      lastError: 'last',
      sample: 'row-1',
    });
  });
});
