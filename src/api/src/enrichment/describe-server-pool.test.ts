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
