/**
 * JobRunner — sibling subsystem to the indexer pipeline for user-triggered
 * long-running work. See `docs/workers-architecture.md` §9, §11.
 *
 * Loop shape mirrors the geocode worker: claim → dispatch → handle →
 * complete/fail/cancel, with a poll interval when no claim is available.
 *
 *     while (!shutdown) {
 *       const claim = await claimJob(...);
 *       if (!claim) { sleep(POLL_MS); continue; }
 *       try {
 *         const out = await this.runHandler(claim, handler);
 *         if (out.kind === "cancelled") await markCancelled(claim._id);
 *         else                          await completeJob(claim._id, out.result);
 *       } catch (err) {
 *         await failJob(claim._id, ...);
 *       }
 *     }
 *
 * Concurrency: one in-flight job per runner instance is fine for v1
 * (`batch_jpeg_export` saturates the FFI pool single-threadedly anyway —
 * see ffi-pool.ts). When other kinds arrive we can lift this into a small
 * worker pool, same shape.
 */

import { randomBytes } from 'node:crypto';
import { child as childLogger } from '../log.ts';
import {
  claimJob,
  completeJob,
  failJob,
  isCancelRequested,
  markCancelled,
  updateProgress,
  saveJobCheckpoint,
} from './jobs.repo.ts';
import { HANDLERS, type JobHandler, type JobHandlerContext } from './handlers/index.ts';

const POLL_MS_DEFAULT = 1_000;
const LEASE_MS_DEFAULT = 5 * 60 * 1_000;

const log = childLogger('job-runner');

export interface JobRunnerConfig {
  workerId?: string;
  pollMs?: number;
  leaseMs?: number;
  /** Override handler dispatch (tests). Defaults to `HANDLERS`. */
  handlers?: Record<string, JobHandler>;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

/** Per-tick result, mirrored on `GeocodeWorker.TickResult` so tests can
 * step the loop deterministically without observing log output. */
export type RunnerTickResult =
  | { kind: 'no-claim' }
  | { kind: 'completed'; jobId: string }
  | { kind: 'cancelled'; jobId: string }
  | { kind: 'failed'; jobId: string; error: string };

export class JobRunner {
  private readonly workerId: string;
  private readonly pollMs: number;
  private readonly leaseMs: number;
  private readonly handlers: Record<string, JobHandler>;
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;

  private shuttingDown = false;
  private loopPromise: Promise<void> | null = null;

  constructor(config: JobRunnerConfig = {}) {
    this.workerId =
      config.workerId ?? `job-runner-${process.pid}-${randomBytes(8).toString('hex')}`;
    this.pollMs = config.pollMs ?? POLL_MS_DEFAULT;
    this.leaseMs = config.leaseMs ?? LEASE_MS_DEFAULT;
    this.handlers = config.handlers ?? HANDLERS;
    this.now = config.now ?? (() => new Date());
    // Existing lifecycle symmetry with imports/worker.ts is intentional; their
    // differently typed claims and recovery rules do not share a runner.
    // fallow-ignore-next-line code-duplication
    this.sleep = config.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** Start the loop. Returns immediately; the loop runs in the background. */
  start(): void {
    if (this.loopPromise) return;
    this.shuttingDown = false;
    this.loopPromise = this.runLoop().catch((err) => {
      log.error({ err: err instanceof Error ? err.message : String(err) }, 'loop crashed');
    });
  }

  /** Signal the loop to exit. Resolves once the current `tick()` completes. */
  async stop(): Promise<void> {
    this.shuttingDown = true;
    if (this.loopPromise) {
      await this.loopPromise;
      this.loopPromise = null;
    }
  }

  /** Single iteration. Exposed for tests so they don't have to drive
   * timers — production calls this on a poll interval. */
  async tick(): Promise<RunnerTickResult> {
    const claim = await claimJob(this.workerId, this.leaseMs, this.now);
    if (!claim) return { kind: 'no-claim' };

    const handler = this.handlers[claim.kind];
    if (!handler) {
      const msg = `no handler registered for kind: ${claim.kind}`;
      await failJob(claim._id, msg, this.now, this.workerId);
      return { kind: 'failed', jobId: claim._id.toHexString(), error: msg };
    }

    try {
      const out = await this.runHandler(claim, handler);
      if (out.kind === 'cancelled') {
        await markCancelled(claim._id, out.result ?? null, this.now, this.workerId);
        return { kind: 'cancelled', jobId: claim._id.toHexString() };
      }
      await completeJob(claim._id, out.result, this.now, this.workerId);
      return { kind: 'completed', jobId: claim._id.toHexString() };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await failJob(claim._id, message, this.now, this.workerId);
      return {
        kind: 'failed',
        jobId: claim._id.toHexString(),
        error: message,
      };
    }
  }

  /** Native renders can outlive one lease. Renew without waiting for per-photo progress. */
  private async runHandler(
    claim: NonNullable<Awaited<ReturnType<typeof claimJob>>>,
    handler: JobHandler,
  ) {
    let progress = claim.progress ?? { current: 0, total: 0 };
    let leaseError: Error | null = null;
    let renewal: Promise<void> | null = null;
    const check = () => {
      if (leaseError) throw new Error(leaseError.message, { cause: leaseError });
    };
    const renew = () => updateProgress(claim._id, progress, this.leaseMs, this.now, this.workerId);
    const timer = setInterval(
      () => {
        if (renewal || leaseError) return;
        renewal = renew()
          .catch((error: unknown) => {
            leaseError = error instanceof Error ? error : new Error(String(error));
          })
          .finally(() => {
            renewal = null;
          });
      },
      Math.max(1, Math.floor(this.leaseMs / 3)),
    );
    const ctx: JobHandlerContext = {
      jobId: claim._id,
      checkpoint: claim.checkpoint,
      saveCheckpoint: async (checkpoint) => {
        check();
        await saveJobCheckpoint(claim._id, this.workerId, checkpoint, this.leaseMs, this.now);
      },
      reportProgress: async (current, total) => {
        check();
        progress = { current, total };
        await renew();
      },
      shouldCancel: async () => {
        check();
        return isCancelRequested(claim._id);
      },
    };
    try {
      const result = await handler.run(claim.payload, ctx);
      check();
      return result;
    } finally {
      clearInterval(timer);
      await renewal;
      check();
    }
  }

  // Existing polling lifecycle mirrors imports/worker.ts; handlers and leases differ.
  // fallow-ignore-next-line code-duplication
  private async runLoop(): Promise<void> {
    while (!this.shuttingDown) {
      let result: RunnerTickResult;
      try {
        result = await this.tick();
      } catch (err) {
        // Defensive — `tick()` already catches handler errors. If we land
        // here it's a Mongo problem (claim/findOneAndUpdate) and the right
        // move is to back off and try again rather than crashing the loop.
        log.warn({ err: err instanceof Error ? err.message : String(err) }, 'tick error');
        result = { kind: 'no-claim' };
      }
      if (result.kind === 'no-claim') {
        await this.sleep(this.pollMs);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton glue (start/stop from src/index.ts)
// ---------------------------------------------------------------------------

let _singleton: JobRunner | null = null;

/** Start the process-wide JobRunner. Idempotent. */
export function startJobRunner(config?: JobRunnerConfig): JobRunner {
  if (_singleton) return _singleton;
  _singleton = new JobRunner(config);
  _singleton.start();
  log.info('started');
  return _singleton;
}

/** Stop the process-wide JobRunner. Safe to call when not started. */
export async function stopJobRunner(): Promise<void> {
  if (!_singleton) return;
  log.info('stopping');
  await _singleton.stop();
  _singleton = null;
  log.info('stopped');
}
