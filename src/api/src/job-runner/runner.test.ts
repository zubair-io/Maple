/**
 * The JobRunner's claim → dispatch → finish loop, one `tick()` at a time.
 *
 * The handler is always a stub: what is under test is the runner's bookkeeping —
 * which job it picks up, what it writes when the handler returns, cancels or
 * throws, and how it keeps a lease alive under a handler that does no reporting
 * of its own — not the work a real handler would do.
 *
 * Each test installs its own SQLite database as the process-wide handle, because
 * `tick()` reaches the repository with no override to pass one down. Nothing is
 * shared between tests and nothing has to be cleared between them (#3787).
 *
 * The last two tests are the lease pair, and they are the reason this file drives
 * real timers rather than a fake clock. A renewal that fires while the handler is
 * awaiting something is the behaviour being checked, so the runner's own
 * `setInterval` has to actually run: one test proves a long handler keeps its
 * claim, and the other proves that once the claim is gone the handler's writes
 * are refused rather than landing on a job another worker now owns.
 */

import { describe, expect, test } from 'bun:test';
import type { JobHandler, JobHandlerContext } from './handlers/index.ts';
import { claimJob, createJob, getJob, requestCancel } from './jobs.repo.ts';
import { JobRunner } from './runner.ts';
import { createLiveTestDatabase, run } from '../db/sqlite/test-sqlite.test-helpers.ts';

const EXPORT_PAYLOAD = { assetIds: [], outputDir: '/tmp', quality: 80 };

/** One queued export job for the runner to find. */
async function queueExportJob() {
  return createJob({ kind: 'batch_jpeg_export', payload: EXPORT_PAYLOAD });
}

/** A runner whose only handler is `handle`, registered for `batch_jpeg_export`. */
function exportRunner(handle: JobHandler['run']): JobRunner {
  return new JobRunner({ handlers: { batch_jpeg_export: { run: handle } }, pollMs: 5 });
}

describe('JobRunner', () => {
  test('picks up a queued job and completes it', async () => {
    using _live = await createLiveTestDatabase();
    const job = await queueExportJob();
    const runner = exportRunner(async () => ({ kind: 'done', result: { ok: true } }));

    const tick = await runner.tick();
    expect(tick.kind).toBe('completed');
    expect(tick.kind === 'completed' && tick.jobId).toBe(job._id.toHexString());

    const after = (await getJob(job._id))!;
    expect(after.status).toBe('done');
    expect(after.result).toEqual({ ok: true });
    expect(after.locked_by).toBeNull();
    expect(after.lease_expires_at).toBeNull();
  });

  test('reports progress through ctx.reportProgress', async () => {
    using _live = await createLiveTestDatabase();
    const job = await queueExportJob();

    let observedDuringRun = { current: -1, total: -1 };
    const runner = exportRunner(async (_payload, ctx: JobHandlerContext) => {
      await ctx.reportProgress(0, 3);
      await ctx.reportProgress(1, 3);
      await ctx.reportProgress(2, 3);
      observedDuringRun = (await getJob(ctx.jobId))!.progress;
      await ctx.reportProgress(3, 3);
      return { kind: 'done', result: { count: 3 } };
    });

    await runner.tick();

    expect(observedDuringRun).toEqual({ current: 2, total: 3 });
    const after = (await getJob(job._id))!;
    expect(after.progress).toEqual({ current: 3, total: 3 });
    expect(after.status).toBe('done');
  });

  test('cancellation observed mid-run flips status to cancelled', async () => {
    using _live = await createLiveTestDatabase();
    const job = await queueExportJob();

    // Stands in for a batch loop: report a step, then notice the flag the route
    // flipped underneath it and stop with whatever it had finished.
    const runner = exportRunner(async (_payload, ctx: JobHandlerContext) => {
      await ctx.reportProgress(0, 5);
      await requestCancel(ctx.jobId);
      if (await ctx.shouldCancel()) return { kind: 'cancelled', result: { partial: true } };
      return { kind: 'done', result: {} };
    });

    const tick = await runner.tick();
    expect(tick.kind).toBe('cancelled');

    const after = (await getJob(job._id))!;
    expect(after.status).toBe('cancelled');
    expect(after.result).toEqual({ partial: true });
    expect(after.locked_by).toBeNull();
  });

  test('returns no-claim when there is nothing queued', async () => {
    using _live = await createLiveTestDatabase();
    const runner = new JobRunner({ handlers: {} });

    expect((await runner.tick()).kind).toBe('no-claim');
  });

  test('fails the job when the handler throws', async () => {
    using _live = await createLiveTestDatabase();
    const job = await queueExportJob();
    const runner = exportRunner(async () => {
      throw new Error('boom');
    });

    const tick = await runner.tick();
    expect(tick.kind).toBe('failed');

    const after = (await getJob(job._id))!;
    expect(after.status).toBe('failed');
    expect(after.error).toBe('boom');
    expect(after.locked_by).toBeNull();
  });

  test('fails the job when no handler is registered for its kind', async () => {
    using _live = await createLiveTestDatabase();
    const job = await queueExportJob();
    const runner = new JobRunner({ handlers: {} });

    const tick = await runner.tick();
    expect(tick.kind === 'failed' && tick.error).toContain('no handler registered');
    expect((await getJob(job._id))!.status).toBe('failed');
  });

  test('renews the lease while a handler waits without reporting photo progress', async () => {
    using _live = await createLiveTestDatabase();
    const job = await createJob({ kind: 'batch_recipe_export', payload: {} });
    const runner = new JobRunner({
      workerId: 'long-render',
      leaseMs: 300,
      handlers: {
        batch_recipe_export: {
          async run() {
            await new Promise((resolve) => setTimeout(resolve, 850));
            // A lease that lapsed would let this competitor take the job away.
            expect(await claimJob('competitor', 300)).toBeNull();
            expect((await getJob(job._id))?.locked_by).toBe('long-render');
            return { kind: 'done', result: {} };
          },
        },
      },
    });

    expect((await runner.tick()).kind).toBe('completed');
  });

  test('fences publication after a long handler loses its lease', async () => {
    using live = await createLiveTestDatabase();
    const job = await createJob({ kind: 'batch_recipe_export', payload: {} });
    const runner = new JobRunner({
      workerId: 'old-render',
      leaseMs: 150,
      handlers: {
        batch_recipe_export: {
          async run(_payload, ctx) {
            // Another worker takes the claim while this handler is still busy.
            run(
              live.db,
              `UPDATE jobs SET locked_by = 'new-render' WHERE id = ?`,
              job._id.toHexString(),
            );
            await new Promise((resolve) => setTimeout(resolve, 250));
            await ctx.saveCheckpoint!({ wouldPublish: true });
            throw new Error('Publication guard was bypassed');
          },
        },
      },
    });

    const tick = await runner.tick();
    expect(tick.kind).toBe('failed');
    expect(tick.kind === 'failed' && tick.error).toContain('lease was claimed');
    expect((await getJob(job._id))?.checkpoint).toBeUndefined();
    expect((await getJob(job._id))?.locked_by).toBe('new-render');
  });
});
