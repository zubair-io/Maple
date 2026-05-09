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
 *         const out = await handler.run(claim.payload, ctx);
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

import { ObjectId } from "mongodb";
import { child as childLogger } from "../log.ts";
import {
  claimJob,
  completeJob,
  failJob,
  isCancelRequested,
  markCancelled,
  updateProgress,
} from "./jobs.repo.ts";
import {
  HANDLERS,
  type JobHandler,
  type JobHandlerContext,
} from "./handlers/index.ts";

const POLL_MS_DEFAULT = 1_000;
const LEASE_MS_DEFAULT = 5 * 60 * 1_000;

const log = childLogger("job-runner");

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
  | { kind: "no-claim" }
  | { kind: "completed"; jobId: string }
  | { kind: "cancelled"; jobId: string }
  | { kind: "failed"; jobId: string; error: string };

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
      config.workerId ??
      `job-runner-${process.pid}-${Math.random().toString(16).slice(2, 8)}`;
    this.pollMs = config.pollMs ?? POLL_MS_DEFAULT;
    this.leaseMs = config.leaseMs ?? LEASE_MS_DEFAULT;
    this.handlers = config.handlers ?? HANDLERS;
    this.now = config.now ?? (() => new Date());
    this.sleep =
      config.sleep ??
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** Start the loop. Returns immediately; the loop runs in the background. */
  start(): void {
    if (this.loopPromise) return;
    this.shuttingDown = false;
    this.loopPromise = this.runLoop().catch((err) => {
      log.error(
        { err: err instanceof Error ? err.message : String(err) },
        "loop crashed",
      );
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
    if (!claim) return { kind: "no-claim" };

    const handler = this.handlers[claim.kind];
    if (!handler) {
      const msg = `no handler registered for kind: ${claim.kind}`;
      await failJob(claim._id, msg, this.now);
      return { kind: "failed", jobId: claim._id.toHexString(), error: msg };
    }

    const ctx: JobHandlerContext = {
      jobId: claim._id,
      reportProgress: async (current, total) => {
        await updateProgress(
          claim._id,
          { current, total },
          this.leaseMs,
          this.now,
        );
      },
      shouldCancel: async () => isCancelRequested(claim._id),
    };

    try {
      const out = await handler.run(claim.payload, ctx);
      if (out.kind === "cancelled") {
        await markCancelled(claim._id, out.result ?? null, this.now);
        return { kind: "cancelled", jobId: claim._id.toHexString() };
      }
      await completeJob(claim._id, out.result, this.now);
      return { kind: "completed", jobId: claim._id.toHexString() };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await failJob(claim._id, message, this.now);
      return {
        kind: "failed",
        jobId: claim._id.toHexString(),
        error: message,
      };
    }
  }

  private async runLoop(): Promise<void> {
    while (!this.shuttingDown) {
      let result: RunnerTickResult;
      try {
        result = await this.tick();
      } catch (err) {
        // Defensive — `tick()` already catches handler errors. If we land
        // here it's a Mongo problem (claim/findOneAndUpdate) and the right
        // move is to back off and try again rather than crashing the loop.
        log.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "tick error",
        );
        result = { kind: "no-claim" };
      }
      if (result.kind === "no-claim") {
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
  log.info("started");
  return _singleton;
}

/** Stop the process-wide JobRunner. Safe to call when not started. */
export async function stopJobRunner(): Promise<void> {
  if (!_singleton) return;
  log.info("stopping");
  await _singleton.stop();
  _singleton = null;
  log.info("stopped");
}

/** Test/diagnostic helper. */
export function getJobRunner(): JobRunner | null {
  return _singleton;
}

/** Test reset. */
export function _resetJobRunnerForTests(): void {
  _singleton = null;
}

// ObjectId import retained for explicit re-export to ease wiring elsewhere.
export { ObjectId };
