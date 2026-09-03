/**
 * Per-server slot pool + failover + circuit breaker for the describe stage.
 *
 * The stage may be pointed at several Ollama endpoints (Settings → Workers →
 * Describe). Each has its own concurrency, because a 4090 box and a laptop
 * do not want the same number of in-flight vision requests. This pool owns
 * three things the stage handler must not reinvent per asset:
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
 *   3. A circuit breaker per server (#2734). Ollama's model runner crashes
 *      intermittently: the in-flight generation dies mid-stream, and every
 *      request for the next ~10–20 s is refused while the server reloads the
 *      runner. Without a breaker the stage keeps claiming backlog through
 *      that window — each claim fails in ~40 ms, spends one of the asset's
 *      attempts, and with a small `maxAttempts` a couple of crashes
 *      dead-letter a whole batch of assets that were never at fault. After
 *      `BREAKER_FAILURE_THRESHOLD` consecutive server-fault failures the
 *      server is taken out of rotation for `BREAKER_OPEN_MS`; a call that
 *      has no other server to go to WAITS for the cool-down and then runs as
 *      the single probe, instead of failing. Only the calls that were in
 *      flight when the runner died spend an attempt; everything claimed
 *      afterwards is held back until the box answers again.
 *
 * Order is the operator's order: entry 0 (the default server, the one every
 * other service reads via `describe_provider_url`) takes work while it has
 * a free slot, and the later servers absorb the overflow. A pool is immutable; a config change builds a
 * new one (see `describe.ts:resetDescribeDeps`).
 */

import { RemoteError, type DescribeProvider } from './describe-providers/index.ts';
import { getDescribeProvider } from './describe-providers/index.ts';
import { totalDescribeCapacity, type DescribeServerConfig } from './describe-servers.ts';
import { CircuitBreaker, type CircuitBreakerConfig } from './circuit-breaker.ts';
import { child as childLogger } from '../log.ts';

const log = childLogger('describe:pool');

/**
 * Consecutive server-fault failures that open a server's breaker. Two, not
 * one: a runner crash fails every request in flight against that box within
 * the same second (the stage runs at concurrency ≥ 2 per server), so a real
 * crash trips this on the spot, while a lone timeout on a cold model load
 * does not take a healthy box out of rotation.
 */
export const BREAKER_FAILURE_THRESHOLD = 2;
/**
 * How long a tripped server sits out before one probe call is allowed.
 * Ollama reloads gemma4:12b in ~17 s on the reference host (see the timeout
 * rationale in `describe-providers/ollama.ts`); 30 s covers that with
 * headroom and is far shorter than the per-asset retry ladder, so a call
 * that waits here still lands well inside its own attempt.
 */
export const BREAKER_OPEN_MS = 30_000;

interface PoolSlot {
  readonly server: DescribeServerConfig;
  readonly provider: DescribeProvider;
  readonly breaker: CircuitBreaker;
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

/** Breaker tuning. Production uses the module constants; tests drive a
 * virtual clock through `now`. */
export type DescribeBreakerOptions = Pick<
  CircuitBreakerConfig,
  'failureThreshold' | 'openDurationMs' | 'now'
>;

export class DescribeServerPool {
  private readonly slots: PoolSlot[];
  private readonly openDurationMs: number;
  private readonly now: () => number;
  /** Callers parked because every server they may use was saturated or
   * tripped. A release wakes ALL of them and each re-checks: waiters differ
   * in which servers they have already tried, so waking only the head could
   * hand the token to a caller that cannot use the freed slot and stall the
   * rest. */
  private readonly waiters: Array<() => void> = [];

  constructor(
    servers: readonly DescribeServerConfig[],
    makeProvider: (url: string) => DescribeProvider = (url) =>
      getDescribeProvider('ollama', { url }),
    breaker: DescribeBreakerOptions = {},
  ) {
    if (servers.length === 0) {
      throw new Error('DescribeServerPool requires at least one server');
    }
    this.openDurationMs = breaker.openDurationMs ?? BREAKER_OPEN_MS;
    this.now = breaker.now ?? (() => Date.now());
    this.slots = servers.map((server) => ({
      server,
      provider: makeProvider(server.url),
      breaker: new CircuitBreaker({
        failureThreshold: breaker.failureThreshold ?? BREAKER_FAILURE_THRESHOLD,
        openDurationMs: this.openDurationMs,
        now: this.now,
        // A tripped server is the one thing an operator triaging "describe
        // stopped" needs to see, so the transition is a warn with the URL.
        log: (transition) =>
          log.warn({ server: server.url, transition }, 'describe server breaker'),
      }),
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
        const result = await fn(slot.provider, slot.server);
        slot.breaker.recordSuccess();
        return result;
      } catch (err) {
        if (!isServerFault(err)) throw err;
        slot.breaker.recordFailure();
        lastError = err;
      } finally {
        this.release(slot);
      }
    }
    throw lastError ?? new Error('describe: no server available');
  }

  /** Wait for a free slot on the first server, in operator order, that is
   * not in `exclude`, is below its own concurrency, and whose breaker admits
   * the call. */
  private async acquire(exclude: ReadonlySet<string>): Promise<PoolSlot> {
    for (;;) {
      // Operator order decides, so the default server (entry 0) takes work
      // while it has a free slot and the later servers absorb the overflow.
      // Sorting by headroom instead would silently prefer a big secondary
      // box over the default one, which is not what the list means.
      const candidates = this.slots.filter((slot) => !exclude.has(slot.server.url));
      const pick = candidates.find((slot) => hasCapacity(slot) && this.admits(slot));
      if (pick) {
        pick.inFlight += 1;
        return pick;
      }
      await this.park(candidates);
    }
  }

  /** Whether the server's breaker lets this call through. Half-open admits
   * exactly one probe at a time — `CircuitBreaker.allowRequest` alone would
   * let a whole batch pile onto a box that has not yet proven it is back. */
  private admits(slot: PoolSlot): boolean {
    if (!slot.breaker.allowRequest()) return false;
    return slot.breaker.snapshot().state !== 'half-open' || slot.inFlight === 0;
  }

  /**
   * Block until something that could change the admission verdict happens:
   * a slot is released (capacity freed, or a probe finished and closed its
   * breaker), or the soonest open breaker among servers that DO have
   * capacity reaches the end of its cool-down.
   */
  private park(candidates: readonly PoolSlot[]): Promise<void> {
    const woken = new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
    const reopenDelays = candidates
      .filter((slot) => hasCapacity(slot))
      .map((slot) => this.reopenDelayMs(slot))
      .filter((ms): ms is number => ms !== null);
    if (reopenDelays.length === 0) return woken;
    // Whichever fires first wins; the loser is a no-op (a stale waiter
    // resolving an already-settled promise on the next release, or a
    // cleared timer).
    let timer: ReturnType<typeof setTimeout> | null = null;
    const cooledDown = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, Math.min(...reopenDelays));
    });
    return Promise.race([woken, cooledDown]).finally(() => {
      if (timer !== null) clearTimeout(timer);
    });
  }

  /** Milliseconds until an OPEN breaker allows its probe; `null` when the
   * server is not waiting on a cool-down (closed, or half-open with the
   * probe already in flight — a release will wake the waiter then). */
  private reopenDelayMs(slot: PoolSlot): number | null {
    const { state, openedAt } = slot.breaker.snapshot();
    if (state !== 'open' || openedAt === null) return null;
    return Math.max(0, openedAt + this.openDurationMs - this.now());
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

function hasCapacity(slot: PoolSlot): boolean {
  return slot.inFlight < slot.server.concurrency;
}
