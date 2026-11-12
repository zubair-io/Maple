/**
 * One job, one attempt, no Temporal: what `executeJob` writes when a handler
 * returns, cancels or throws, how it keeps the engine and the row informed
 * under a handler that reports nothing, and what an attempt does once the
 * engine has moved on from it.
 *
 * The renewal tests drive real timers, because a renewal that fires while the
 * handler is awaiting something is the behaviour being checked.
 */

import { describe, expect, test } from 'bun:test';
import { ObjectId } from '../db/object-id.ts';
import type { JobHandler, JobHandlerContext } from './handlers/index.ts';
import { claimJob, createJob, getJob, requestCancel } from './jobs.repo.ts';
import { executeJob } from './execute-job.ts';
import { AttemptSuperseded, UnknownRowError } from '../temporal/activity-attempt.ts';
import { recordedAttempt as attemptNamed } from '../temporal/recorded-attempt.test-helpers.ts';
import { createLiveTestDatabase } from '../db/sqlite/test-sqlite.test-helpers.ts';

const EXPORT_PAYLOAD = { assetIds: [], outputDir: '/tmp', quality: 80 };

async function queueExportJob() {
  return createJob({ kind: 'batch_jpeg_export', payload: EXPORT_PAYLOAD });
}

const exportHandlers = (run: JobHandler['run']) => ({ batch_jpeg_export: { run } });

describe('executeJob', () => {
  test('claims the job, runs its handler and records the result', async () => {
    using _live = await createLiveTestDatabase();
    const job = await queueExportJob();

    const outcome = await executeJob(job._id.toHexString(), attemptNamed('a1'), {
      handlers: exportHandlers(async () => ({ kind: 'done', result: { ok: true } })),
    });

    expect(outcome).toEqual({ outcome: 'done' });
    const after = (await getJob(job._id))!;
    expect(after.status).toBe('done');
    expect(after.result).toEqual({ ok: true });
    expect(after.locked_by).toBeNull();
    expect(after.lease_expires_at).toBeNull();
  });

  test('progress reaches both the row and the engine heartbeat', async () => {
    using _live = await createLiveTestDatabase();
    const job = await queueExportJob();
    const attempt = attemptNamed('a1');
    let observedDuringRun = { current: -1, total: -1 };

    await executeJob(job._id.toHexString(), attempt, {
      handlers: exportHandlers(async (_payload, ctx: JobHandlerContext) => {
        await ctx.reportProgress(1, 3);
        await ctx.reportProgress(2, 3);
        observedDuringRun = (await getJob(ctx.jobId))!.progress;
        await ctx.reportProgress(3, 3);
        return { kind: 'done', result: { count: 3 } };
      }),
    });

    expect(observedDuringRun).toEqual({ current: 2, total: 3 });
    expect((await getJob(job._id))!.progress).toEqual({ current: 3, total: 3 });
    expect(attempt.beats).toEqual([
      { current: 0, total: 0 },
      { current: 1, total: 3 },
      { current: 2, total: 3 },
      { current: 3, total: 3 },
    ]);
  });

  test('a cancel requested through the API ends the job as cancelled', async () => {
    using _live = await createLiveTestDatabase();
    const job = await queueExportJob();

    const outcome = await executeJob(job._id.toHexString(), attemptNamed('a1'), {
      handlers: exportHandlers(async (_payload, ctx: JobHandlerContext) => {
        await ctx.reportProgress(0, 5);
        await requestCancel(ctx.jobId);
        if (await ctx.shouldCancel()) return { kind: 'cancelled', result: { partial: true } };
        return { kind: 'done', result: {} };
      }),
    });

    expect(outcome).toEqual({ outcome: 'cancelled' });
    const after = (await getJob(job._id))!;
    expect(after.status).toBe('cancelled');
    expect(after.result).toEqual({ partial: true });
    expect(after.locked_by).toBeNull();
  });

  test('a cancel requested through Temporal ends the job as cancelled too', async () => {
    using _live = await createLiveTestDatabase();
    const job = await queueExportJob();
    const attempt = attemptNamed('a1');

    const outcome = await executeJob(job._id.toHexString(), attempt, {
      handlers: exportHandlers(async (_payload, ctx: JobHandlerContext) => {
        attempt.stop = 'cancel';
        if (await ctx.shouldCancel()) return { kind: 'cancelled', result: { partial: true } };
        return { kind: 'done', result: {} };
      }),
    });

    expect(outcome).toEqual({ outcome: 'cancelled' });
    expect((await getJob(job._id))!.status).toBe('cancelled');
  });

  test('a thrown handler fails the job with its message', async () => {
    using _live = await createLiveTestDatabase();
    const job = await queueExportJob();

    const outcome = await executeJob(job._id.toHexString(), attemptNamed('a1'), {
      handlers: exportHandlers(async () => {
        throw new Error('boom');
      }),
    });

    expect(outcome).toEqual({ outcome: 'failed', error: 'boom' });
    const after = (await getJob(job._id))!;
    expect(after.status).toBe('failed');
    expect(after.error).toBe('boom');
    expect(after.locked_by).toBeNull();
  });

  test('a kind with no handler fails instead of being retried forever', async () => {
    using _live = await createLiveTestDatabase();
    const job = await queueExportJob();

    const run = await executeJob(job._id.toHexString(), attemptNamed('a1'), { handlers: {} });

    expect(run.outcome).toBe('failed');
    expect((await getJob(job._id))!.error).toContain('no handler registered');
  });

  test('a redelivery for a finished job runs nothing and reports how it finished', async () => {
    using _live = await createLiveTestDatabase();
    const job = await queueExportJob();
    let runs = 0;
    const handlers = exportHandlers(async () => {
      runs += 1;
      throw new Error('disk full');
    });

    await executeJob(job._id.toHexString(), attemptNamed('a1'), { handlers });
    const again = await executeJob(job._id.toHexString(), attemptNamed('a2'), { handlers });

    expect(again).toEqual({ outcome: 'failed', error: 'disk full' });
    expect(runs).toBe(1);
  });

  test('asking about cancel heartbeats, so a quiet handler still hears a Temporal cancel', async () => {
    using _live = await createLiveTestDatabase();
    const job = await queueExportJob();
    const attempt = attemptNamed('quiet');

    await executeJob(job._id.toHexString(), attempt, {
      handlers: exportHandlers(async (_payload, ctx) => {
        const before = attempt.beats.length;
        await ctx.shouldCancel();
        expect(attempt.beats.length).toBe(before + 1);
        return { kind: 'done', result: {} };
      }),
    });
  });

  test('a job this database has never seen is an error, not a quiet skip', async () => {
    using _live = await createLiveTestDatabase();

    const run = executeJob(new ObjectId().toHexString(), attemptNamed('a1'), { handlers: {} });

    await expect(run).rejects.toBeInstanceOf(UnknownRowError);
    await expect(run).rejects.toThrow('its own Temporal namespace');
  });

  test('a silent handler still renews the row and heartbeats on a timer', async () => {
    using _live = await createLiveTestDatabase();
    const job = await queueExportJob();
    const attempt = attemptNamed('long-render');
    let leaseMidRun: string | null = null;

    const outcome = await executeJob(job._id.toHexString(), attempt, {
      leaseMs: 300,
      handlers: exportHandlers(async () => {
        const claimedUntil = (await getJob(job._id))!.lease_expires_at!;
        await new Promise((resolve) => setTimeout(resolve, 450));
        leaseMidRun = (await getJob(job._id))!.lease_expires_at;
        expect(Date.parse(leaseMidRun!)).toBeGreaterThan(Date.parse(claimedUntil));
        return { kind: 'done', result: {} };
      }),
    });

    expect(outcome).toEqual({ outcome: 'done' });
    expect(leaseMidRun).not.toBeNull();
    expect(attempt.beats.length).toBeGreaterThan(2);
  });

  test('an attempt whose job was taken over cannot publish or finish it', async () => {
    using _live = await createLiveTestDatabase();
    const job = await queueExportJob();

    const outcome = await executeJob(job._id.toHexString(), attemptNamed('old-render'), {
      leaseMs: 150,
      handlers: exportHandlers(async (_payload, ctx) => {
        await claimJob(job._id, 'new-render', 60_000);
        await new Promise((resolve) => setTimeout(resolve, 250));
        await ctx.saveCheckpoint!({ wouldPublish: true });
        throw new Error('Publication guard was bypassed');
      }),
    });

    expect(outcome.outcome).toBe('failed');
    const after = (await getJob(job._id))!;
    expect(after.status).toBe('running');
    expect(after.locked_by).toBe('new-render');
    expect(after.checkpoint).toBeUndefined();
  });

  test('an attempt paused or reset in Temporal stops without touching the row', async () => {
    using _live = await createLiveTestDatabase();
    const job = await queueExportJob();
    const attempt = attemptNamed('paused');

    const run = executeJob(job._id.toHexString(), attempt, {
      handlers: exportHandlers(async (_payload, ctx) => {
        attempt.stop = 'superseded';
        await ctx.reportProgress(1, 2);
        return { kind: 'done', result: {} };
      }),
    });

    await expect(run).rejects.toBeInstanceOf(AttemptSuperseded);
    const after = (await getJob(job._id))!;
    expect(after.status).toBe('running');
    expect(after.locked_by).toBe('paused');
    expect(after.progress).toEqual({ current: 0, total: 0 });
  });
});
