/**
 * `mirror_reconcile` — the operator's "Reconcile now": one scan (find what is
 * missing or stale on the mirrors and queue it), then copy passes until the
 * queue is drained. Live progress rides in the row's ledger, throttled, and
 * the final snapshot is its result; `GET /api/mirror/status` reads either
 * (`workers/mirror/reconcile-progress.ts`). A restart mid-run runs it again
 * from the scan, which only queues what is still missing.
 *
 * The scheduled `mirror-scan` and `mirror-copy` passes keep running beside it.
 * Both sides enqueue through the same idempotent upsert and copy only rows
 * they hold a `mirror_queue` lease on, so no file is copied twice and neither
 * undoes the other's work.
 */

import { loadMirrorConfig } from '../../fs/mirror-config.ts';
import { mirrorQueueCounts } from '../../fs/mirror-queue.repo.ts';
import { isMirroringActive } from '../../fs/mirror-registry.ts';
import { child as childLogger } from '../../log.ts';
import { runMirrorCopyOnce } from '../../workers/mirror/copy.ts';
import {
  COPIED_LOG_CAP,
  ERROR_LOG_CAP,
  idleReconcile,
  RECONCILE_KEY,
  type MirrorReconcileProgress,
} from '../../workers/mirror/reconcile-progress.ts';
import { runMirrorScanOnce } from '../../workers/mirror/scan.ts';
import type { JobHandler, JobHandlerContext, JobHandlerResult } from './index.ts';

const log = childLogger('mirror:reconcile');

const COPY_BATCH = 50;
/** Safety net against an unbounded drain. */
const MAX_COPY_PASSES = 100_000;
/** Between polls while the scheduled copy pass holds the remaining leases. */
const IDLE_WAIT_MS = 1_000;
/** About twenty seconds without the queue shrinking hands the rest to the scheduled pass. */
const MAX_IDLE_WAITS = 20;
/** The settings pages poll status about this often while a reconcile runs. */
const SAVE_EVERY_MS = 1_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The live snapshot and its publication. The scan reports progress
 * synchronously, so a timer saves it; a failed save (the attempt was
 * superseded) is raised at the run's next step.
 */
class ReconcileRun {
  readonly progress: MirrorReconcileProgress = {
    ...idleReconcile(),
    phase: 'scanning',
    startedAt: new Date().toISOString(),
  };
  private saving: Promise<void> | null = null;
  private failure: unknown = null;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(private readonly ctx: JobHandlerContext) {
    this.timer = setInterval(() => {
      if (this.saving === null) void this.save();
    }, SAVE_EVERY_MS);
  }

  private async write(): Promise<void> {
    const snapshot = structuredClone(this.progress);
    await this.ctx.saveCheckpoint?.({ [RECONCILE_KEY]: snapshot });
  }

  /** Never rejects: a failure is kept for {@link checkpoint}. */
  save(): Promise<void> {
    this.saving = this.write()
      .catch((error: unknown) => {
        this.failure ??= error;
      })
      .finally(() => {
        this.saving = null;
      });
    return this.saving;
  }

  /** Raises a save that failed since the last step. */
  async step(): Promise<void> {
    await this.saving;
    if (this.failure !== null) throw this.failure;
  }

  /** Publishes now, at a phase boundary. */
  async checkpoint(): Promise<void> {
    await this.step();
    await this.save();
    await this.step();
  }

  async close(): Promise<void> {
    clearInterval(this.timer);
    await this.saving;
  }

  recordError(path: string, error: string): void {
    this.progress.errorLog = [
      ...this.progress.errorLog,
      { path, error, at: new Date().toISOString() },
    ].slice(-ERROR_LOG_CAP);
    log.error({ path, err: error }, 'reconcile: file error');
  }

  recordCopied(path: string): void {
    this.progress.copiedLog = [path, ...this.progress.copiedLog].slice(0, COPIED_LOG_CAP);
  }

  finished(): Record<string, unknown> {
    return {
      [RECONCILE_KEY]: {
        ...this.progress,
        phase: 'idle',
        currentPath: null,
        finishedAt: new Date().toISOString(),
      },
    };
  }
}

async function scanStage(run: ReconcileRun): Promise<void> {
  log.info('reconcile: scanning started');
  const scan = await runMirrorScanOnce({
    onProgress: (snapshot) => {
      run.progress.scan = {
        ...run.progress.scan,
        scanned: snapshot.scanned,
        toCopy: snapshot.enqueued,
        upToDate: snapshot.upToDate,
      };
      run.progress.currentPath = snapshot.currentPath;
    },
  });
  run.progress.scan = {
    scanned: scan.scanned,
    toCopy: scan.enqueued,
    upToDate: scan.upToDate,
    errors: scan.errors,
  };
  log.info(run.progress.scan, 'reconcile: scan complete');
}

interface Drain {
  readonly total: number;
  readonly baselineDead: number;
  readonly idleWaits: number;
  readonly lastPending: number;
}

/** One copy pass; the state for the next one, or null when copying is over. */
async function copyPass(run: ReconcileRun, drain: Drain): Promise<Drain | null> {
  const pass = await runMirrorCopyOnce({
    batchSize: COPY_BATCH,
    onProgress: (snapshot) => {
      run.progress.currentPath = snapshot.currentPath;
    },
    onCopied: (path) => run.recordCopied(path),
    onError: (failure) => run.recordError(failure.path, failure.error),
  });
  const counts = await mirrorQueueCounts();
  const dead = Math.max(0, counts.dead - drain.baselineDead);
  run.progress.copy = {
    total: drain.total,
    remaining: counts.pending,
    errors: dead,
    copied: Math.max(0, drain.total - counts.pending - dead),
  };
  if (counts.pending === 0) return null;
  // Rows remain that this pass could not claim: the scheduled copy pass holds
  // them. Wait for them rather than stopping while the queue still drains, and
  // give up only after a stall with no progress, leaving the rest to it.
  const stalled = pass.claimed === 0 && counts.pending >= drain.lastPending;
  const next = {
    ...drain,
    idleWaits: stalled ? drain.idleWaits + 1 : 0,
    lastPending: counts.pending,
  };
  if (next.idleWaits >= MAX_IDLE_WAITS) {
    log.info(
      { remaining: counts.pending },
      'reconcile: handing the remaining leased rows to the scheduled copy pass',
    );
    return null;
  }
  if (pass.claimed === 0) await sleep(IDLE_WAIT_MS);
  return next;
}

/** Copy passes until the queue drains or stalls; false when cancelled first. */
async function copyPasses(
  run: ReconcileRun,
  ctx: JobHandlerContext,
  drain: Drain,
  passesLeft: number,
): Promise<boolean> {
  if (passesLeft === 0) return true;
  await run.step();
  if (await ctx.shouldCancel()) return false;
  const next = await copyPass(run, drain);
  return next === null ? true : copyPasses(run, ctx, next, passesLeft - 1);
}

async function copyStage(run: ReconcileRun, ctx: JobHandlerContext): Promise<boolean> {
  run.progress.phase = 'copying';
  run.progress.currentPath = null;
  const atStart = await mirrorQueueCounts();
  const drain: Drain = {
    total: atStart.pending,
    baselineDead: atStart.dead,
    idleWaits: 0,
    lastPending: atStart.pending,
  };
  run.progress.copy = { total: drain.total, copied: 0, remaining: drain.total, errors: 0 };
  log.info({ toCopy: drain.total }, 'reconcile: copying started');
  const completed = await copyPasses(run, ctx, drain, MAX_COPY_PASSES);
  if (completed) log.info(run.progress.copy, 'reconcile: copy complete');
  return completed;
}

async function reconcile(run: ReconcileRun, ctx: JobHandlerContext): Promise<JobHandlerResult> {
  await run.checkpoint();
  await scanStage(run);
  await run.checkpoint();
  if (await ctx.shouldCancel()) return { kind: 'cancelled', result: run.finished() };
  const completed = await copyStage(run, ctx);
  await run.checkpoint();
  return { kind: completed ? 'done' : 'cancelled', result: run.finished() };
}

export const mirrorReconcileHandler: JobHandler = {
  async run(_payload, ctx) {
    await loadMirrorConfig();
    const run = new ReconcileRun(ctx);
    try {
      if (!isMirroringActive()) return { kind: 'done', result: run.finished() };
      const outcome = await reconcile(run, ctx);
      log.info({ scan: run.progress.scan, copy: run.progress.copy }, 'reconcile: done');
      return outcome;
    } catch (error) {
      log.error(
        { err: error instanceof Error ? error.message : String(error) },
        'reconcile failed',
      );
      throw error;
    } finally {
      await run.close();
    }
  },
};
