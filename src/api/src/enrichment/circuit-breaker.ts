/**
 * Three-state circuit breaker (closed → open → half-open → closed).
 *
 * Closed = healthy; calls flow through.
 * Open = the worker is paused; the loop sleeps but doesn't call Nominatim.
 *   Triggered after `failureThreshold` consecutive retryable failures.
 *   Auto-transitions to half-open after `openDurationMs`.
 * Half-open = a single probe call is allowed. On success, the breaker closes.
 *   On failure, it goes straight back to open (no further probes until the
 *   next `openDurationMs` elapses).
 *
 * Why a breaker matters here: Nominatim runs on a different host (per
 * §4.1). A brief outage that throws 5xx for a minute would otherwise burn
 * every pending asset's `attempts` counter and dead-letter the entire
 * backlog. The breaker pauses the worker until Nominatim is healthy again.
 *
 * Spec: `docs/indexer-enrichment.md` §4.5.
 */

import { child as childLogger } from "../log.ts";

const defaultLog = childLogger("enrichment:circuit-breaker");

export type CircuitState = "closed" | "open" | "half-open";

export interface CircuitBreakerConfig {
  /** Consecutive retryable failures before opening. Default 10. */
  failureThreshold?: number;
  /** How long the breaker stays open before allowing one probe. Default 60s. */
  openDurationMs?: number;
  /** Time source. Override in tests. */
  now?: () => number;
  /** Logger. Defaults to the `enrichment:circuit-breaker` child logger. */
  log?: (msg: string) => void;
}

export class CircuitBreaker {
  private readonly failureThreshold: number;
  private readonly openDurationMs: number;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;

  private state: CircuitState = "closed";
  private consecutiveFailures = 0;
  private openedAt: number | null = null;

  constructor(config: CircuitBreakerConfig = {}) {
    this.failureThreshold = config.failureThreshold ?? 10;
    this.openDurationMs = config.openDurationMs ?? 60_000;
    this.now = config.now ?? (() => Date.now());
    this.log = config.log ?? ((msg) => defaultLog.info(msg));
  }

  /**
   * Whether the worker may currently call Nominatim. Side-effecting:
   * promotes `open` → `half-open` once `openDurationMs` has elapsed, so
   * the next call slips through as a probe.
   */
  allowRequest(): boolean {
    if (this.state === "closed") return true;
    if (this.state === "half-open") return true;
    // open: maybe time to probe?
    if (this.openedAt !== null && this.now() - this.openedAt >= this.openDurationMs) {
      this.transition("half-open");
      return true;
    }
    return false;
  }

  /** Record a successful call. Closes the breaker if it was probing. */
  recordSuccess(): void {
    this.consecutiveFailures = 0;
    if (this.state !== "closed") {
      this.transition("closed");
    }
  }

  /**
   * Record a retryable failure. Increments the consecutive counter and
   * opens the breaker once `failureThreshold` is hit. A failure during
   * the half-open probe sends the breaker straight back to open with a
   * fresh `openedAt` so the cool-down restarts.
   */
  recordFailure(): void {
    if (this.state === "half-open") {
      this.openedAt = this.now();
      this.transition("open");
      return;
    }
    this.consecutiveFailures++;
    if (this.state === "closed" && this.consecutiveFailures >= this.failureThreshold) {
      this.openedAt = this.now();
      this.transition("open");
    }
  }

  /** Read-only snapshot for status routes / tests. */
  snapshot(): {
    state: CircuitState;
    consecutiveFailures: number;
    openedAt: number | null;
  } {
    return {
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      openedAt: this.openedAt,
    };
  }

  private transition(next: CircuitState): void {
    const prev = this.state;
    if (prev === next) return;
    this.state = next;
    this.log(
      JSON.stringify({
        component: "circuit-breaker",
        transition: `${prev}->${next}`,
        consecutiveFailures: this.consecutiveFailures,
        at: this.now(),
      }),
    );
  }
}
