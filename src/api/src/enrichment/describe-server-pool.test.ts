/**
 * Admission + failover behaviour of the describe server pool.
 *
 * The two properties that matter to the stage: a server never sees more
 * in-flight calls than its configured concurrency, and a server-fault
 * failure moves the SAME call to another server rather than dead-lettering
 * the asset.
 */

import { describe, expect, it } from 'bun:test';
import { DescribeServerPool } from './describe-server-pool.ts';
import { RemoteError, type DescribeProvider } from './describe-providers/index.ts';

/** Minimal provider stand-in: the pool only ever calls what the caller's
 * `fn` calls, plus `health()`. */
function fakeProvider(url: string, health: () => Promise<void> = async () => {}): DescribeProvider {
  return {
    name: 'ollama',
    describe: async () => ({ text: url, cost_usd: 0, provider_info: {} }),
    health,
  };
}

const servers = [
  { url: 'http://a:11434', concurrency: 2 },
  { url: 'http://b:11434', concurrency: 1 },
];

function poolOf(overrides: Partial<Record<string, () => Promise<void>>> = {}) {
  return new DescribeServerPool(servers, (url) => fakeProvider(url, overrides[url]));
}

const deferred = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
};

describe('DescribeServerPool', () => {
  it('reports total capacity as the sum of per-server concurrency', () => {
    expect(poolOf().capacity).toBe(3);
  });

  it('rejects an empty server list', () => {
    expect(() => new DescribeServerPool([])).toThrow();
  });

  it('never exceeds a server’s concurrency and parks the overflow', async () => {
    const pool = poolOf();
    const gate = deferred();
    const inFlight = new Map<string, number>();
    const peak = new Map<string, number>();
    const started: string[] = [];

    const call = () =>
      pool.run(async (_provider, server) => {
        const now = (inFlight.get(server.url) ?? 0) + 1;
        inFlight.set(server.url, now);
        peak.set(server.url, Math.max(peak.get(server.url) ?? 0, now));
        started.push(server.url);
        await gate.promise;
        inFlight.set(server.url, now - 1);
        return server.url;
      });

    const calls = [call(), call(), call(), call()];
    // Three slots exist, so exactly three calls start; the fourth waits.
    await Bun.sleep(5);
    expect(started.length).toBe(3);
    expect(peak.get('http://a:11434')).toBe(2);
    expect(peak.get('http://b:11434')).toBe(1);

    gate.release();
    expect((await Promise.all(calls)).length).toBe(4);
    expect(started.length).toBe(4);
  });

  it('fills the default server before spilling to the next one', async () => {
    const pool = poolOf();
    const gate = deferred();
    const picked: string[] = [];
    const calls = [0, 1, 2].map(() =>
      pool.run(async (_provider, server) => {
        picked.push(server.url);
        await gate.promise;
        return server.url;
      }),
    );
    await Bun.sleep(5);
    // Server a has concurrency 2 and is the operator's default, so it takes
    // the first two calls before b sees anything.
    expect(picked).toEqual(['http://a:11434', 'http://a:11434', 'http://b:11434']);
    gate.release();
    await Promise.all(calls);
  });

  it('fails over to the next server on a retryable failure', async () => {
    const pool = poolOf();
    const tried: string[] = [];
    const answer = await pool.run(async (_provider, server) => {
      tried.push(server.url);
      if (server.url === 'http://a:11434') {
        throw new RemoteError('connection refused', true);
      }
      return 'ok';
    });
    expect(answer).toBe('ok');
    expect(tried).toEqual(['http://a:11434', 'http://b:11434']);
  });

  it('throws the last error once every server has failed', async () => {
    const pool = poolOf();
    const tried: string[] = [];
    const run = pool.run(async (_provider, server) => {
      tried.push(server.url);
      throw new RemoteError(`down: ${server.url}`, true);
    });
    await expect(run).rejects.toThrow('down: http://b:11434');
    expect(tried).toEqual(['http://a:11434', 'http://b:11434']);
  });

  it('does not fail over on a terminal error', async () => {
    const pool = poolOf();
    const tried: string[] = [];
    const run = pool.run(async (_provider, server) => {
      tried.push(server.url);
      throw new RemoteError('bad request', false, 400);
    });
    await expect(run).rejects.toThrow('bad request');
    expect(tried).toEqual(['http://a:11434']);
  });

  it('releases the slot after a failure so later calls still run', async () => {
    const pool = poolOf();
    await pool
      .run(async () => {
        throw new RemoteError('boom', false);
      })
      .catch(() => {});
    expect(await pool.run(async (_p, server) => server.url)).toBe('http://a:11434');
  });

  it('reports per-server health', async () => {
    const pool = poolOf({
      'http://b:11434': async () => {
        throw new RemoteError('unreachable', true);
      },
    });
    expect(await pool.health()).toEqual([
      { url: 'http://a:11434', ok: true, error: null },
      { url: 'http://b:11434', ok: false, error: 'unreachable' },
    ]);
  });
});

/**
 * Per-server circuit breaker (#2734). Ollama's model runner crashes
 * intermittently; the in-flight generation dies and every request for the
 * next few seconds is refused while the runner reloads. Without a breaker
 * the stage keeps claiming backlog through that window and every claim
 * spends one of the asset's attempts on a box that cannot answer.
 */
describe('DescribeServerPool — circuit breaker', () => {
  const serverFault = (url: string) => new RemoteError(`down: ${url}`, true, 500);

  /** A pool whose breakers trip after two consecutive server faults and
   * cool down quickly enough for a test to wait it out. */
  function breakerPool(list = servers, openDurationMs = 40) {
    return new DescribeServerPool(list, (url) => fakeProvider(url), {
      failureThreshold: 2,
      openDurationMs,
    });
  }

  it('takes a server out of rotation after consecutive server faults', async () => {
    const pool = breakerPool();
    const tried: string[][] = [];
    const call = (failA: boolean) => {
      const seen: string[] = [];
      tried.push(seen);
      return pool.run(async (_provider, server) => {
        seen.push(server.url);
        if (failA && server.url === 'http://a:11434') throw serverFault(server.url);
        return server.url;
      });
    };
    // Two crashes on a: each fails over to b, and the second trips a's breaker.
    expect(await call(true)).toBe('http://b:11434');
    expect(await call(true)).toBe('http://b:11434');
    // a would answer now, but it is tripped — the call goes straight to b.
    expect(await call(false)).toBe('http://b:11434');
    expect(tried).toEqual([
      ['http://a:11434', 'http://b:11434'],
      ['http://a:11434', 'http://b:11434'],
      ['http://b:11434'],
    ]);
  });

  it('does not count a terminal error against the server', async () => {
    const pool = breakerPool();
    for (let i = 0; i < 3; i++) {
      await pool
        .run(async () => {
          throw new RemoteError('bad request', false, 400);
        })
        .catch(() => {});
    }
    // Three request-side failures in a row and a is still the first pick.
    expect(await pool.run(async (_p, server) => server.url)).toBe('http://a:11434');
  });

  it('waits out the cool-down and probes when every server is tripped', async () => {
    const pool = breakerPool([{ url: 'http://a:11434', concurrency: 2 }], 40);
    const failing = () =>
      pool
        .run(async (_p, server) => {
          throw serverFault(server.url);
        })
        .catch(() => {});
    await failing();
    await failing();

    // The only server is open. Rather than failing the call (and spending
    // the asset's attempt on a box that is reloading), the pool holds it
    // until the cool-down elapses and runs it as the probe.
    const started = Date.now();
    expect(await pool.run(async (_p, server) => server.url)).toBe('http://a:11434');
    expect(Date.now() - started).toBeGreaterThanOrEqual(35);

    // The successful probe closed the breaker: the next call is immediate.
    const again = Date.now();
    expect(await pool.run(async (_p, server) => server.url)).toBe('http://a:11434');
    expect(Date.now() - again).toBeLessThan(35);
  });

  it('admits a single probe while half-open, then reopens fully on success', async () => {
    const pool = breakerPool([{ url: 'http://a:11434', concurrency: 2 }], 20);
    for (let i = 0; i < 2; i++) {
      await pool
        .run(async (_p, server) => {
          throw serverFault(server.url);
        })
        .catch(() => {});
    }
    await Bun.sleep(25);

    const gate = deferred();
    let started = 0;
    const call = () =>
      pool.run(async () => {
        started += 1;
        await gate.promise;
        return 'ok';
      });
    const calls = [call(), call()];
    await Bun.sleep(5);
    // Concurrency is 2, but a half-open server gets exactly one probe.
    expect(started).toBe(1);
    gate.release();
    expect(await Promise.all(calls)).toEqual(['ok', 'ok']);
    expect(started).toBe(2);
  });

  it('a failed probe sends the server back to open for another cool-down', async () => {
    const pool = breakerPool([{ url: 'http://a:11434', concurrency: 1 }], 30);
    const failing = () =>
      pool
        .run(async (_p, server) => {
          throw serverFault(server.url);
        })
        .catch(() => {});
    await failing();
    await failing();
    await Bun.sleep(35);
    // Probe fails.
    await failing();

    const started = Date.now();
    expect(await pool.run(async (_p, server) => server.url)).toBe('http://a:11434');
    expect(Date.now() - started).toBeGreaterThanOrEqual(25);
  });
});
