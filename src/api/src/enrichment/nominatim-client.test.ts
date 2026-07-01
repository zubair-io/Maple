/**
 * NominatimClient tests — mock the underlying `fetch` so CI never depends on
 * a real Nominatim instance being reachable.
 */

import { describe, it, expect } from 'bun:test';
import type { NominatimError } from './nominatim-client.ts';
import { NominatimClient } from './nominatim-client.ts';

interface MockResponse {
  status?: number;
  body?: unknown;
  delayMs?: number;
  /** When set, the mock fetch will reject with this error instead of resolving. */
  failWith?: Error;
}

interface MockOpts {
  responses: MockResponse[];
}

function mockFetch(opts: MockOpts): { fetchImpl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  let i = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push(url);
    const r = opts.responses[Math.min(i++, opts.responses.length - 1)]!;
    if (r.failWith) {
      // Mirror native fetch: an aborted signal rethrows AbortError.
      throw r.failWith;
    }
    if (r.delayMs && r.delayMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, r.delayMs);
        if (init?.signal) {
          if (init.signal.aborted) {
            clearTimeout(timer);
            reject(new DOMException('aborted', 'AbortError'));
          } else {
            init.signal.addEventListener('abort', () => {
              clearTimeout(timer);
              reject(new DOMException('aborted', 'AbortError'));
            });
          }
        }
      });
    }
    return new Response(JSON.stringify(r.body ?? {}), {
      status: r.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe('NominatimClient.health', () => {
  it('resolves on 200', async () => {
    const { fetchImpl, calls } = mockFetch({ responses: [{ status: 200 }] });
    const client = new NominatimClient({
      baseUrl: 'http://nominatim.test',
      fetchImpl,
    });
    await client.health();
    expect(calls).toEqual(['http://nominatim.test/status']);
  });

  it('throws a non-retryable error on 5xx (boot path will exit the process)', async () => {
    const { fetchImpl } = mockFetch({ responses: [{ status: 503 }] });
    const client = new NominatimClient({
      baseUrl: 'http://nominatim.test/',
      fetchImpl,
    });
    await expect(client.health()).rejects.toMatchObject({
      name: 'NominatimError',
      retryable: false,
      status: 503,
    });
  });

  it('strips trailing slash from baseUrl', async () => {
    const { fetchImpl, calls } = mockFetch({ responses: [{ status: 200 }] });
    const client = new NominatimClient({
      baseUrl: 'http://nominatim.test///',
      fetchImpl,
    });
    await client.health();
    expect(calls).toEqual(['http://nominatim.test/status']);
  });
});

describe('NominatimClient.reverse', () => {
  it('issues a GET with the right query parameters', async () => {
    const { fetchImpl, calls } = mockFetch({
      responses: [{ status: 200, body: { address: { city: 'Albany' } } }],
    });
    const client = new NominatimClient({
      baseUrl: 'http://nominatim.test',
      fetchImpl,
      rateLimitPerSec: 1000,
    });
    const res = await client.reverse(42.6526, -73.7562);
    expect(res.address?.city).toBe('Albany');
    const url = calls[0]!;
    expect(url).toContain('/reverse?');
    expect(url).toContain('lat=42.6526');
    expect(url).toContain('lon=-73.7562');
    expect(url).toContain('format=jsonv2');
    expect(url).toContain('addressdetails=1');
    expect(url).toContain('extratags=1');
    expect(url).toContain('namedetails=1');
    expect(url).toContain('zoom=18');
  });

  it('classifies 5xx as retryable', async () => {
    const { fetchImpl } = mockFetch({ responses: [{ status: 502 }] });
    const client = new NominatimClient({
      baseUrl: 'http://nominatim.test',
      fetchImpl,
      rateLimitPerSec: 1000,
    });
    let caught: NominatimError | null = null;
    try {
      await client.reverse(0, 0);
    } catch (e) {
      caught = e as NominatimError;
    }
    expect(caught).toBeTruthy();
    expect(caught!.retryable).toBe(true);
    expect(caught!.status).toBe(502);
  });

  it('classifies 4xx as non-retryable', async () => {
    const { fetchImpl } = mockFetch({ responses: [{ status: 400 }] });
    const client = new NominatimClient({
      baseUrl: 'http://nominatim.test',
      fetchImpl,
      rateLimitPerSec: 1000,
    });
    let caught: NominatimError | null = null;
    try {
      await client.reverse(0, 0);
    } catch (e) {
      caught = e as NominatimError;
    }
    expect(caught).toBeTruthy();
    expect(caught!.retryable).toBe(false);
    expect(caught!.status).toBe(400);
  });

  it('times out a slow response and surfaces a retryable error', async () => {
    const { fetchImpl } = mockFetch({
      responses: [{ status: 200, body: {}, delayMs: 5_000 }],
    });
    const client = new NominatimClient({
      baseUrl: 'http://nominatim.test',
      fetchImpl,
      requestTimeoutMs: 50,
      rateLimitPerSec: 1000,
    });
    let caught: NominatimError | null = null;
    try {
      await client.reverse(0, 0);
    } catch (e) {
      caught = e as NominatimError;
    }
    expect(caught).toBeTruthy();
    expect(caught!.retryable).toBe(true);
    expect(caught!.message).toMatch(/timed out/);
  });

  it('classifies network failures as retryable', async () => {
    const { fetchImpl } = mockFetch({
      responses: [{ failWith: new TypeError('getaddrinfo ENOTFOUND nominatim.test') }],
    });
    const client = new NominatimClient({
      baseUrl: 'http://nominatim.test',
      fetchImpl,
      rateLimitPerSec: 1000,
    });
    let caught: NominatimError | null = null;
    try {
      await client.reverse(0, 0);
    } catch (e) {
      caught = e as NominatimError;
    }
    expect(caught).toBeTruthy();
    expect(caught!.retryable).toBe(true);
  });

  it('classifies non-JSON 200 as non-retryable', async () => {
    // A successful HTTP call that returns garbage bytes won't be saved by a
    // retry — the upstream is responding, just badly.
    const fetchImpl = (async () =>
      new Response('<not json>', { status: 200 })) as unknown as typeof fetch;
    const client = new NominatimClient({
      baseUrl: 'http://nominatim.test',
      fetchImpl,
      rateLimitPerSec: 1000,
    });
    let caught: NominatimError | null = null;
    try {
      await client.reverse(0, 0);
    } catch (e) {
      caught = e as NominatimError;
    }
    expect(caught).toBeTruthy();
    expect(caught!.retryable).toBe(false);
  });
});

describe('NominatimClient — token-bucket rate limit', () => {
  it('does not block until the burst capacity is exhausted', async () => {
    let virtualMs = 0;
    const { fetchImpl } = mockFetch({
      responses: [{ status: 200, body: { address: {} } }],
    });
    const sleepCalls: number[] = [];
    const client = new NominatimClient({
      baseUrl: 'http://nominatim.test',
      fetchImpl,
      rateLimitPerSec: 10,
      now: () => virtualMs,
      sleep: async (ms) => {
        sleepCalls.push(ms);
        virtualMs += ms;
      },
    });

    // Burst capacity = 10, so the first 10 calls are non-blocking.
    for (let i = 0; i < 10; i++) await client.reverse(0, 0);
    expect(sleepCalls).toEqual([]);
  });

  it('sleeps long enough for the next token to mature when the bucket is empty', async () => {
    let virtualMs = 0;
    const { fetchImpl } = mockFetch({
      responses: [{ status: 200, body: { address: {} } }],
    });
    const sleepCalls: number[] = [];
    const client = new NominatimClient({
      baseUrl: 'http://nominatim.test',
      fetchImpl,
      rateLimitPerSec: 10, // 1 token per 100 ms
      now: () => virtualMs,
      sleep: async (ms) => {
        sleepCalls.push(ms);
        virtualMs += ms;
      },
    });

    for (let i = 0; i < 10; i++) await client.reverse(0, 0);
    // 11th call: bucket is empty, must sleep ~100 ms for one token.
    await client.reverse(0, 0);
    expect(sleepCalls.length).toBeGreaterThan(0);
    expect(sleepCalls[0]!).toBeGreaterThanOrEqual(80);
    expect(sleepCalls[0]!).toBeLessThanOrEqual(120);
  });
});
