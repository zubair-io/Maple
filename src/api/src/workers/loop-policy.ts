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
