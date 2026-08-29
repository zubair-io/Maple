/**
 * Per-server slot pool + failover for the describe stage.
 *
 * The stage may be pointed at several Ollama endpoints (Settings → Workers →
 * Describe). Each has its own concurrency, because a 4090 box and a laptop
 * do not want the same number of in-flight vision requests. This pool owns
 * two things the stage handler must not reinvent per asset:
 *
 *   1. Admission. A describe call waits for a free slot on some server and
 *      never exceeds any server's configured concurrency. The pool's total
 *      capacity is the sum across servers — which is also what the stage
 *      clamps its dispatch fan-out to, so a claimed asset never sits idle
 *      holding a lease while waiting for admission.
 *   2. Failover. A RETRYABLE failure (network error, timeout, 5xx) means
 *      "this box is unwell", so the same call is retried on the next server
 *      that has capacity, until every server has been tried. A TERMINAL
 *      failure (4xx, malformed output) is the request's fault, not the
 *      server's — it propagates immediately, because retrying it elsewhere
 *      would just burn every endpoint on a doomed asset.
 *
 * Order is the operator's order: entry 0 (the default server, the one every
 * other service reads via `describe_provider_url`) is preferred, then the
 * rest by most free capacity. A pool is immutable; a config change builds a
 * new one (see `describe.ts:resetDescribeDeps`).
 */

import { RemoteError, type DescribeProvider } from './describe-providers/index.ts';
import { getDescribeProvider } from './describe-providers/index.ts';
import { totalDescribeCapacity, type DescribeServerConfig } from './describe-servers.ts';

interface PoolSlot {
  readonly server: DescribeServerConfig;
  readonly provider: DescribeProvider;
  inFlight: number;
}

/** A failure the pool judges to be the server's fault rather than the
 * request's. `RemoteError.retryable` is the providers' own classification;
 * anything that isn't a RemoteError (a raw fetch rejection, an AbortError
 * from the request timeout) is treated the same way — it never reached a
 * verdict from the model, so another box may well answer. */
function isServerFault(err: unknown): boolean {
  return err instanceof RemoteError ? err.retryable : true;
}

export class DescribeServerPool {
  private readonly slots: PoolSlot[];
  /** Callers parked because every server they may use was saturated. A
   * release wakes ALL of them and each re-checks: waiters differ in which
   * servers they have already tried, so waking only the head could hand the
   * token to a caller that cannot use the freed slot and stall the rest. */
  private readonly waiters: Array<() => void> = [];

  constructor(
    servers: readonly DescribeServerConfig[],
    makeProvider: (url: string) => DescribeProvider = (url) =>
      getDescribeProvider('ollama', { url }),
  ) {
    if (servers.length === 0) {
      throw new Error('DescribeServerPool requires at least one server');
    }
    this.slots = servers.map((server) => ({
      server,
      provider: makeProvider(server.url),
      inFlight: 0,
    }));
  }

  /** Configured endpoints, in operator order. */
  get servers(): readonly DescribeServerConfig[] {
    return this.slots.map((slot) => slot.server);
  }

  /** Sum of every server's concurrency — the most describe calls this pool
   * will ever have in flight at once. */
  get capacity(): number {
    return totalDescribeCapacity(this.servers);
  }

  /**
   * Run `fn` against one server, waiting for admission and failing over on
   * server-fault errors. Rejects with the LAST error seen once every server
   * has been tried (or immediately, on a terminal error).
   */
  async run<T>(fn: (provider: DescribeProvider, server: DescribeServerConfig) => Promise<T>) {
    const tried = new Set<string>();
    let lastError: unknown = null;
    while (tried.size < this.slots.length) {
      const slot = await this.acquire(tried);
      tried.add(slot.server.url);
      try {
        return await fn(slot.provider, slot.server);
      } catch (err) {
        if (!isServerFault(err)) throw err;
        lastError = err;
      } finally {
        this.release(slot);
      }
    }
    throw lastError ?? new Error('describe: no server available');
  }

  /** Wait for a free slot on a server not in `exclude`, preferring the
   * default server and then whichever has the most headroom. */
  private async acquire(exclude: ReadonlySet<string>): Promise<PoolSlot> {
    for (;;) {
      const free = this.slots
        .filter((slot) => !exclude.has(slot.server.url) && slot.inFlight < slot.server.concurrency)
        .sort(
          (a, b) =>
            b.server.concurrency - b.inFlight - (a.server.concurrency - a.inFlight) ||
            this.slots.indexOf(a) - this.slots.indexOf(b),
        );
      const pick = free[0];
      if (pick) {
        pick.inFlight += 1;
        return pick;
      }
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
      });
    }
  }

  private release(slot: PoolSlot): void {
    slot.inFlight -= 1;
    const woken = this.waiters.splice(0, this.waiters.length);
    for (const wake of woken) wake();
  }

  /**
   * Probe every server. Resolves to one result per server in pool order —
   * the settings UI and the boot log both need per-server detail, because
   * "describe is unhealthy" is useless when one of three boxes is down.
   */
  async health(): Promise<Array<{ url: string; ok: boolean; error: string | null }>> {
    return Promise.all(
      this.slots.map(async (slot) => {
        try {
          await slot.provider.health();
          return { url: slot.server.url, ok: true, error: null };
        } catch (err) {
          return {
            url: slot.server.url,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }),
    );
  }
}
