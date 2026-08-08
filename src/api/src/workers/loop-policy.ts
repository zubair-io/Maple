/**
 * Poll-loop timing policy for the in-process stage runner (#674).
 *
 * Extracted from `run-stage.ts` so the loop's cadence contract — global idle
 * interval, re-poll-immediately-on-full-batch, exponential backoff on error —
 * is a small, pure, unit-testable module independent of the DB-bound runner.
 */

/**
 * Idle cadence for every stage's poll loop. There is no longer a per-stage
 * `pollIntervalMs` knob — a stage that came back with a non-full batch (i.e.
 * caught up) sleeps this long before its next claim. A stage with a backlog
 * re-polls immediately, so this only governs the idle case.
 */
export const POLL_INTERVAL_MS = 1000;

/** Exponential backoff (ms) applied after consecutive poll-tick errors,
 * saturating at the last entry so a failing stage never hot-loops. */
export const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];

/**
 * Per-asset retry backoff (ms), indexed by the attempt that just failed and
 * saturating at the last entry.
 *
 * Distinct from `BACKOFF_MS` above, which paces the poll LOOP after tick
 * errors. This one paces a single ASSET's retries, and until #2729 it did not
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
 * Claim batch size, derived from concurrency rather than configured. With the
 * re-poll-immediately-on-full-batch loop, batch size barely affects throughput
 * (just DB round-trip efficiency), so we fix it at 5× the worker-pool size.
 */
export function deriveBatchSize(concurrency: number): number {
  return 5 * concurrency;
}

/**
 * Decide how long the poll loop should sleep before its next tick.
 *
 *   - On error: exponential backoff, indexed by the consecutive-error count
 *     (saturating at the last `BACKOFF_MS` entry). This path overrides
 *     everything — a failing stage must not hot-loop.
 *   - On a FULL batch (claimed === derived batch size, not paused): re-poll
 *     immediately (`0`) so a backlog drains as fast as the pool allows. This
 *     is the critical pairing with the global 1s cadence: without it,
 *     throughput would cap at ~batchSize/sec.
 *   - Otherwise (not full / paused / idle): the global idle cadence.
 *
 * Pure + exported so the loop's timing contract is unit-testable without a DB.
 */
export function nextPollDelay(args: {
  claimed: number;
  concurrency: number;
  paused: boolean;
  consecutiveErrors: number;
}): number {
  if (args.consecutiveErrors > 0) {
    const idx = Math.min(args.consecutiveErrors - 1, BACKOFF_MS.length - 1);
    return BACKOFF_MS[idx]!;
  }
  if (!args.paused && args.claimed >= deriveBatchSize(args.concurrency)) {
    return 0;
  }
  return POLL_INTERVAL_MS;
}
