/**
 * The jobs queue, driven through the seam the runner and the routes import
 * (#3787): create, claim, lease, progress, cancellation and the three terminal
 * transitions.
 *
 * Tested through `job-runner/jobs.repo.ts` rather than through the SQLite module
 * it re-exports, because the seam is what every caller holds and because its own
 * `createJob` is the one function that is not a pass-through.
 *
 * Which job runs next is Temporal's decision, so a claim names its job. What is
 * left to prove here is that a later attempt takes a running job over and that a
 * finished one is never claimed again.
 *
 * The one thing deliberately not here is the "only one settings batch per
 * library" fence — it is reached by a different route and lives in
 * `jobs.repo.fence.test.ts`.
 */

import { describe, expect, test } from 'bun:test';
import { ObjectId } from '../db/object-id.ts';
import {
  claimJob,
  completeJob,
  createJob,
  failJob,
  getJob,
  isCancelRequested,
  JobConflictError,
  jobConflictMessage,
  listJobs,
  markCancelled,
  requestCancel,
  updateProgress,
} from './jobs.repo.ts';
import { createLiveTestDatabase, run } from '../db/sqlite/test-sqlite.test-helpers.ts';

const EXPORT_PAYLOAD = { assetIds: ['a'], outputDir: '/tmp', quality: 80 };

/** A fixed clock, for the timestamps a lease assertion has to name exactly. */
function at(iso: string): () => Date {
  return () => new Date(iso);
}

/** One queued export job, optionally stamped with a chosen creation time. */
async function newExportJob(createdAt?: string, payload: Record<string, unknown> = EXPORT_PAYLOAD) {
  return createJob(
    { kind: 'batch_jpeg_export', payload },
    createdAt === undefined ? undefined : at(createdAt),
  );
}

describe('createJob', () => {
  test('writes a queued job with every default already in place', async () => {
    using _live = await createLiveTestDatabase();

    const created = await createJob(
      { kind: 'batch_jpeg_export', payload: EXPORT_PAYLOAD },
      at('2026-04-01T10:00:00.000Z'),
    );

    expect(created._id).toBeInstanceOf(ObjectId);
    expect(created.kind).toBe('batch_jpeg_export');
    expect(created.status).toBe('queued');
    expect(created.payload).toEqual(EXPORT_PAYLOAD);
    expect(created.progress).toEqual({ current: 0, total: 0 });
    expect(created.result).toBeNull();
    expect(created.error).toBeNull();
    expect(created.locked_by).toBeNull();
    expect(created.cancel_requested).toBe(false);
    expect(created.created_at).toBe('2026-04-01T10:00:00.000Z');
    expect(created.updated_at).toBe('2026-04-01T10:00:00.000Z');
    // A job that never checkpointed and locks no library carries neither key,
    // exactly as the document did when those fields were absent subdocuments.
    expect('checkpoint' in created).toBe(false);
    expect('batch_scopes' in created).toBe(false);
  });

  test('stores the payload in `params` and the progress in two columns', async () => {
    using live = await createLiveTestDatabase();
    const created = await newExportJob();

    const row = live.db
      .query(`SELECT params, ledger, progress_current, progress_total FROM jobs WHERE id = ?`)
      .get(created._id.toHexString()) as {
      params: string;
      ledger: string | null;
      progress_current: number;
      progress_total: number;
    };

    expect(JSON.parse(row.params)).toEqual(EXPORT_PAYLOAD);
    expect(row.ledger).toBeNull();
    expect(row.progress_current).toBe(0);
    expect(row.progress_total).toBe(0);
  });

  test('replaying a request id returns the stored job instead of a second one', async () => {
    using _live = await createLiveTestDatabase();
    const requestId = new ObjectId().toHexString();

    const first = await createJob({
      kind: 'batch_jpeg_export',
      payload: EXPORT_PAYLOAD,
      requestId,
    });
    const replay = await createJob({
      kind: 'batch_jpeg_export',
      payload: EXPORT_PAYLOAD,
      requestId,
    });

    expect(replay._id.toHexString()).toBe(first._id.toHexString());
    expect(replay.created_at).toBe(first.created_at);
    expect((await listJobs({})).length).toBe(1);
  });

  test('refuses a request id that already belongs to a different job', async () => {
    using _live = await createLiveTestDatabase();
    const requestId = new ObjectId().toHexString();
    await createJob({ kind: 'batch_jpeg_export', payload: EXPORT_PAYLOAD, requestId });

    const clash = createJob({
      kind: 'batch_jpeg_export',
      payload: { ...EXPORT_PAYLOAD, quality: 95 },
      requestId,
    });
    await expect(clash).rejects.toThrow(JobConflictError);
    await expect(clash).rejects.toThrow('already belongs to a different job');
  });
});

describe('jobConflictMessage', () => {
  test('names a conflict and stays silent about anything else', () => {
    expect(jobConflictMessage(new JobConflictError('busy'))).toBe('busy');
    expect(jobConflictMessage(new Error('disk full'))).toBeUndefined();
    expect(jobConflictMessage('not an error at all')).toBeUndefined();
  });
});

describe('claimJob', () => {
  test('claims the named job and hands back what its handler needs', async () => {
    using _live = await createLiveTestDatabase();
    const older = await newExportJob('2026-04-01T10:00:00.000Z');
    const newer = await newExportJob('2026-04-02T10:00:00.000Z');

    const claim = await claimJob(newer._id, 'worker-1', at('2026-04-03T00:00:00.000Z'));
    expect(claim!._id.toHexString()).toBe(newer._id.toHexString());
    expect(claim!.kind).toBe('batch_jpeg_export');
    expect(claim!.payload).toEqual(EXPORT_PAYLOAD);
    expect(claim!.progress).toEqual({ current: 0, total: 0 });

    const claimed = (await getJob(newer._id))!;
    expect(claimed.status).toBe('running');
    expect(claimed.locked_by).toBe('worker-1');
    expect(claimed.updated_at).toBe('2026-04-03T00:00:00.000Z');
    expect((await getJob(older._id))!.status).toBe('queued');
  });

  test('a later attempt takes over a job its predecessor left running', async () => {
    using _live = await createLiveTestDatabase();
    const created = await newExportJob();

    expect(await claimJob(created._id, 'dead-attempt')).not.toBeNull();
    const retaken = await claimJob(created._id, 'live-attempt');

    expect(retaken!._id.toHexString()).toBe(created._id.toHexString());
    expect((await getJob(created._id))!.locked_by).toBe('live-attempt');
  });

  test('refuses a job that already finished', async () => {
    using _live = await createLiveTestDatabase();
    const created = await newExportJob();
    await failJob(created._id, 'boom');

    expect(await claimJob(created._id, 'worker-1')).toBeNull();
    expect((await getJob(created._id))!.status).toBe('failed');
  });
});

describe('updateProgress', () => {
  test('advances the counters and stamps the write', async () => {
    using _live = await createLiveTestDatabase();
    const created = await newExportJob();
    await claimJob(created._id, 'worker-1', at('2026-04-03T00:00:00.000Z'));

    await updateProgress(created._id, { current: 1, total: 5 }, at('2026-04-03T00:00:20.000Z'));

    const mid = (await getJob(created._id))!;
    expect(mid.progress).toEqual({ current: 1, total: 5 });
    expect(mid.updated_at).toBe('2026-04-03T00:00:20.000Z');
  });

  test('throws when the named worker no longer holds the claim', async () => {
    using live = await createLiveTestDatabase();
    const created = await newExportJob();
    await claimJob(created._id, 'worker-1');
    run(live.db, `UPDATE jobs SET locked_by = 'worker-2' WHERE id = ?`, created._id.toHexString());

    await expect(
      updateProgress(created._id, { current: 1, total: 5 }, undefined, 'worker-1'),
    ).rejects.toThrow('lease was claimed by another worker');
    expect((await getJob(created._id))!.progress).toEqual({ current: 0, total: 0 });
  });
});

describe('cancellation', () => {
  test('flags a job and reports the flag back', async () => {
    using _live = await createLiveTestDatabase();
    const created = await newExportJob();

    expect(await isCancelRequested(created._id)).toBe(false);
    expect(await requestCancel(created._id, at('2026-04-03T00:00:00.000Z'))).toBe(true);
    expect(await isCancelRequested(created._id)).toBe(true);

    const flagged = (await getJob(created._id))!;
    expect(flagged.cancel_requested).toBe(true);
    expect(flagged.updated_at).toBe('2026-04-03T00:00:00.000Z');
  });

  test('reports nothing for an id that never existed', async () => {
    using _live = await createLiveTestDatabase();
    expect(await requestCancel(new ObjectId())).toBe(false);
    expect(await isCancelRequested(new ObjectId())).toBe(false);
    expect(await getJob(new ObjectId())).toBeNull();
  });

  test('markCancelled keeps the partial result and releases the claim', async () => {
    using _live = await createLiveTestDatabase();
    const created = await newExportJob();
    await claimJob(created._id, 'worker-1');

    await markCancelled(created._id, { partial: true });

    const cancelled = (await getJob(created._id))!;
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.result).toEqual({ partial: true });
    expect(cancelled.locked_by).toBeNull();
  });
});

describe('terminal transitions', () => {
  test('completeJob writes the result, clears the error and releases the claim', async () => {
    using live = await createLiveTestDatabase();
    const created = await newExportJob();
    await claimJob(created._id, 'worker-1');
    run(
      live.db,
      `UPDATE jobs SET error = 'an earlier attempt failed' WHERE id = ?`,
      created._id.toHexString(),
    );

    await completeJob(created._id, { successCount: 5 }, at('2026-04-03T01:00:00.000Z'));

    const done = (await getJob(created._id))!;
    expect(done.status).toBe('done');
    expect(done.result).toEqual({ successCount: 5 });
    expect(done.error).toBeNull();
    expect(done.locked_by).toBeNull();
    expect(done.updated_at).toBe('2026-04-03T01:00:00.000Z');
  });

  test('failJob records the message and releases the claim', async () => {
    using _live = await createLiveTestDatabase();
    const created = await newExportJob();
    await claimJob(created._id, 'worker-1');

    await failJob(created._id, 'boom');

    const failed = (await getJob(created._id))!;
    expect(failed.status).toBe('failed');
    expect(failed.error).toBe('boom');
    expect(failed.locked_by).toBeNull();
  });
});

describe('listJobs', () => {
  test('filters by status, newest first', async () => {
    using _live = await createLiveTestDatabase();
    const a = await newExportJob('2026-04-01T10:00:00.000Z');
    const b = await newExportJob('2026-04-02T10:00:00.000Z');
    await claimJob(a._id, 'w');
    await completeJob(a._id, {});

    expect((await listJobs({ status: 'queued' })).map((j) => j._id.toHexString())).toEqual([
      b._id.toHexString(),
    ]);
    expect((await listJobs({ status: 'done' })).map((j) => j._id.toHexString())).toEqual([
      a._id.toHexString(),
    ]);
  });

  test('matches several statuses at once and narrows by kind', async () => {
    using live = await createLiveTestDatabase();
    const queued = await newExportJob('2026-04-01T10:00:00.000Z');
    const running = await newExportJob('2026-04-02T10:00:00.000Z');
    const other = await createJob({ kind: 'batch_recipe_export', payload: {} });
    run(
      live.db,
      `UPDATE jobs SET status = 'running', locked_by = 'w' WHERE id = ?`,
      running._id.toHexString(),
    );

    const active = await listJobs({ statuses: ['queued', 'running'], kind: 'batch_jpeg_export' });
    expect(active.map((j) => j._id.toHexString()).sort()).toEqual(
      [queued._id.toHexString(), running._id.toHexString()].sort(),
    );
    expect(
      (await listJobs({ kind: 'batch_recipe_export' })).map((j) => j._id.toHexString()),
    ).toEqual([other._id.toHexString()]);
    expect((await listJobs({ limit: 1 })).length).toBe(1);
  });
});
