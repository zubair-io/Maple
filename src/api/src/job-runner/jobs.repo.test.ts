/**
 * The jobs queue, driven through the seam the runner and the routes import
 * (#3787): create, claim, lease, progress, cancellation and the three terminal
 * transitions.
 *
 * Tested through `job-runner/jobs.repo.ts` rather than through the SQLite module
 * it re-exports, because the seam is what every caller holds and because its own
 * `createJob` is the one function that is not a pass-through.
 *
 * The claim is the mechanism that carries the weight, and it is new at the
 * cutover: MongoDB's `findOneAndUpdate` picked a winner inside the server, while
 * here a candidate read takes the oldest claimable rows and an `UPDATE` repeats
 * the claimable predicate in its own `WHERE`, so the row count decides. The
 * rival-worker test fails if that `WHERE` is ever weakened.
 *
 * The one thing deliberately not here is the "only one settings batch per
 * library" fence — it is reached by a different route and lives in
 * `jobs.repo.fence.test.ts`.
 */

import { describe, expect, test } from 'bun:test';
import { ObjectId } from 'mongodb';
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
import type { SqlParams } from '../db/sqlite/protocol.ts';
import type { SqliteDb } from '../db/sqlite/repos/db-handle.ts';

const EXPORT_PAYLOAD = { assetIds: ['a'], outputDir: '/tmp', quality: 80 };
const CANDIDATE_QUERY = 'ORDER BY created_at, id LIMIT 8';

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

/**
 * The same handle, except that a rival worker claims the ids the first candidate
 * read returned before this caller can act on them.
 */
function withRivalWorker(db: SqliteDb, claim: (ids: string[]) => void): SqliteDb {
  let fired = false;
  return {
    ...db,
    read: async <T>(sql: string, params?: SqlParams): Promise<T[]> => {
      const rows = await db.read<T>(sql, params);
      if (!fired && sql.includes(CANDIDATE_QUERY)) {
        fired = true;
        claim((rows as Array<{ id: string }>).map((row) => row.id));
      }
      return rows;
    },
  };
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
    expect(created.lease_expires_at).toBeNull();
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
  test('claims the oldest queued job and leaves nothing for the next worker', async () => {
    using _live = await createLiveTestDatabase();
    const older = await newExportJob('2026-04-01T10:00:00.000Z');
    const newer = await newExportJob('2026-04-02T10:00:00.000Z');

    const first = await claimJob('worker-1', 60_000, at('2026-04-03T00:00:00.000Z'));
    expect(first!._id.toHexString()).toBe(older._id.toHexString());
    expect(first!.kind).toBe('batch_jpeg_export');
    expect(first!.payload).toEqual(EXPORT_PAYLOAD);
    expect(first!.progress).toEqual({ current: 0, total: 0 });

    const claimed = (await getJob(older._id))!;
    expect(claimed.status).toBe('running');
    expect(claimed.locked_by).toBe('worker-1');
    expect(claimed.lease_expires_at).toBe('2026-04-03T00:01:00.000Z');

    const second = await claimJob('worker-2', 60_000, at('2026-04-03T00:00:00.000Z'));
    expect(second!._id.toHexString()).toBe(newer._id.toHexString());
    expect(await claimJob('worker-3', 60_000, at('2026-04-03T00:00:00.000Z'))).toBeNull();
  });

  test('only one of two concurrent claims wins the same job', async () => {
    using _live = await createLiveTestDatabase();
    await newExportJob();

    const [a, b] = await Promise.all([claimJob('worker-A', 60_000), claimJob('worker-B', 60_000)]);

    expect([a, b].filter((claim) => claim !== null).length).toBe(1);
  });

  test('skips a job a rival worker claimed after the candidate read', async () => {
    using live = await createLiveTestDatabase();
    const older = await newExportJob('2026-04-01T10:00:00.000Z');
    const newer = await newExportJob('2026-04-02T10:00:00.000Z');

    const stolen: string[] = [];
    const racy = withRivalWorker(live.handle, (ids) => {
      const first = ids[0];
      if (first === undefined) return;
      stolen.push(first);
      run(
        live.db,
        `UPDATE jobs SET status = 'running', locked_by = 'rival',
            lease_expires_at = '2099-01-01T00:00:00.000Z' WHERE id = ?`,
        first,
      );
    });

    const claimed = await claimJob('worker-1', 60_000, undefined, racy);

    expect(stolen).toEqual([older._id.toHexString()]);
    expect(claimed!._id.toHexString()).toBe(newer._id.toHexString());
    expect((await getJob(older._id))!.locked_by).toBe('rival');
  });

  test('leaves a running job alone until its lease lapses, then reclaims it', async () => {
    using _live = await createLiveTestDatabase();
    const created = await newExportJob();

    expect(await claimJob('dead-worker', 10, at('2026-01-01T00:00:00.000Z'))).not.toBeNull();
    expect(await claimJob('live-worker', 60_000, at('2026-01-01T00:00:00.005Z'))).toBeNull();

    const retaken = await claimJob('live-worker', 60_000, at('2026-01-01T00:00:01.000Z'));
    expect(retaken!._id.toHexString()).toBe(created._id.toHexString());
    expect((await getJob(created._id))!.locked_by).toBe('live-worker');
  });

  test('never reclaims a running job that recorded no lease at all', async () => {
    using live = await createLiveTestDatabase();
    const created = await newExportJob();
    run(
      live.db,
      `UPDATE jobs SET status = 'running', locked_by = 'ghost', lease_expires_at = NULL
        WHERE id = ?`,
      created._id.toHexString(),
    );

    expect(await claimJob('worker-1', 60_000)).toBeNull();
  });
});

describe('updateProgress', () => {
  test('advances the counters and renews the lease', async () => {
    using _live = await createLiveTestDatabase();
    const created = await newExportJob();
    await claimJob('worker-1', 60_000, at('2026-04-03T00:00:00.000Z'));

    await updateProgress(
      created._id,
      { current: 1, total: 5 },
      60_000,
      at('2026-04-03T00:00:20.000Z'),
    );

    const mid = (await getJob(created._id))!;
    expect(mid.progress).toEqual({ current: 1, total: 5 });
    expect(mid.lease_expires_at).toBe('2026-04-03T00:01:20.000Z');
    expect(mid.updated_at).toBe('2026-04-03T00:00:20.000Z');
  });

  test('throws when the named worker no longer holds the claim', async () => {
    using live = await createLiveTestDatabase();
    const created = await newExportJob();
    await claimJob('worker-1', 60_000);
    run(live.db, `UPDATE jobs SET locked_by = 'worker-2' WHERE id = ?`, created._id.toHexString());

    await expect(
      updateProgress(created._id, { current: 1, total: 5 }, 60_000, undefined, 'worker-1'),
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
    await claimJob('worker-1', 60_000);

    await markCancelled(created._id, { partial: true });

    const cancelled = (await getJob(created._id))!;
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.result).toEqual({ partial: true });
    expect(cancelled.locked_by).toBeNull();
    expect(cancelled.lease_expires_at).toBeNull();
  });
});

describe('terminal transitions', () => {
  test('completeJob writes the result, clears the error and releases the claim', async () => {
    using live = await createLiveTestDatabase();
    const created = await newExportJob();
    await claimJob('worker-1', 60_000);
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
    expect(done.lease_expires_at).toBeNull();
    expect(done.updated_at).toBe('2026-04-03T01:00:00.000Z');
  });

  test('failJob records the message and releases the claim', async () => {
    using _live = await createLiveTestDatabase();
    const created = await newExportJob();
    await claimJob('worker-1', 60_000);

    await failJob(created._id, 'boom');

    const failed = (await getJob(created._id))!;
    expect(failed.status).toBe('failed');
    expect(failed.error).toBe('boom');
    expect(failed.locked_by).toBeNull();
    expect(failed.lease_expires_at).toBeNull();
  });
});

describe('listJobs', () => {
  test('filters by status, newest first', async () => {
    using _live = await createLiveTestDatabase();
    const a = await newExportJob('2026-04-01T10:00:00.000Z');
    const b = await newExportJob('2026-04-02T10:00:00.000Z');
    await claimJob('w', 60_000);
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
