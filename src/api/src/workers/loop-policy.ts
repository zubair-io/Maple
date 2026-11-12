/**
 * Pure timing and sizing policy for the stage runner (#674): how long a failed
 * asset waits before its next attempt, and how many rows one claim takes.
 *
 * The cadence of the stage itself is not here. Temporal schedules it: the stage
 * lane checks for work about once a second, and a slice that throws is retried
 * with Temporal's own backoff (`stage-workflow.ts`).
 */

/**
 * Per-asset retry backoff (ms), indexed by the attempt that just failed and
 * saturating at the last entry.
 *
 * This paces a single ASSET's retries, and until #2729 it did not
 * exist: a failed attempt was simply eligible again on the next tick, so
 * consecutive attempts landed milliseconds apart. That made the attempt budget
 * worthless against exactly the failures it exists for — a provider restart, a
 * poisoned connection pool (#2728), a model load — because every attempt
 * sampled the same instant. With prod's `describe.maxAttempts: 2`, a blip
 * lasting one second permanently dead-lettered the asset, and "Retry dead"
 * re-ran into the same wall twice more.
 *
 * The ladder is minutes, not seconds, because the failures worth surviving are
 * process restarts and model loads. The first step is still short enough that
 * a genuinely broken provider dead-letters promptly rather than holding a
 * backlog open for hours.
 */
export const RETRY_BACKOFF_MS = [30_000, 120_000, 300_000, 900_000];

/**
 * When an asset whose `attemptNo` just failed becomes claimable again.
 *
 * Jitter is ±20%, applied because stage failures arrive correlated: when a
 * provider goes down, every in-flight asset fails within the same second, and
 * an unjittered ladder would march the whole batch back at the same instant
 * and knock the provider over again as it comes up.
 */
export function retryDelayMs(attemptNo: number, random: () => number = Math.random): number {
  const idx = Math.min(Math.max(attemptNo, 1) - 1, RETRY_BACKOFF_MS.length - 1);
  const base = RETRY_BACKOFF_MS[idx]!;
  return Math.round(base * (0.8 + random() * 0.4));
}

/**
 * Claim batch size, derived from concurrency rather than configured. A slice
 * claims batch after batch until one comes back empty, so batch size barely
 * affects throughput (just DB round-trip efficiency); it is fixed at 5× the
 * worker-pool size.
 */
export function deriveBatchSize(concurrency: number): number {
  return 5 * concurrency;
}
