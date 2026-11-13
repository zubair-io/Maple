/**
 * The jobs repository, against rows.
 *
 * Three mechanisms here are new rather than ported, and they are what these
 * tests are mostly about.
 *
 * The **claim** is a read of candidates followed by a compare-and-swap that
 * repeats the claimable predicate, standing in for a `findOneAndUpdate` that
 * matched and wrote in one server-side step.
 *
 * The **active-batch fence** — only one settings batch per library — was a
 * UNIQUE partial index that a startup call had to remember to create; it is now
 * a `WHERE NOT EXISTS` inside the insert, so a conflict arrives as a row count
 * of zero rather than as a driver error.
 *
 * The **ledger entry patch** replaces a dotted `checkpoint.entries.N` `$set`
 * with `json_set` over one array element, and has to fall back to writing the
 * whole ledger when the stored array cannot hold the index yet.
 */

import { describe, expect, test } from 'bun:test';
import { ObjectId } from '../object-id.ts';
import { createTestDatabase, testSqliteDb } from '../sqlite/test-sqlite.test-helpers.ts';
import { newObjectIdHex } from '../object-id.ts';
import type { SqliteDb } from './db-handle.ts';
import {
  cancelUnfinishedJob,
  claimJob,
  completeJob,
  createJob,
  failJob,
  getJob,
  heldJobIds,
  isCancelRequested,
  JobConflictError,
  jobConflictMessage,
  listJobs,
  markCancelled,
  markJobDispatched,
  nextJobId,
  requestCancel,
  resumeBatchJob,
  saveJobCheckpoint,
  updateProgress,
} from './jobs.repo.ts';

const at = (ms: number) => () => new Date(ms);

/** A queued `cloud_backup_restore`, a kind with no scopes, no fence and no resume. */
async function restoreJob(db: SqliteDb, ms = 0) {
  return createJob(
    { kind: 'cloud_backup_restore', payload: { assetIds: ['a', 'b'] } },
    at(ms),
    undefined,
    db,
  );
}

/** A queued settings batch locking `scopes`. */
async function batch(db: SqliteDb, scopes: string[], ms = 0) {
  return createJob({ kind: 'batch_adjustment_sync', payload: { targets: [] } }, at(ms), scopes, db);
}

describe('createJob', () => {
  test('writes the defaults, and reads back as the document shape', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);

    const job = await restoreJob(db, 1_000);

    expect(job.status).toBe('queued');
    expect(job.payload).toEqual({ assetIds: ['a', 'b'] });
    expect(job.progress).toEqual({ current: 0, total: 0 });
    expect(job.result).toBeNull();
    expect(job.cancel_requested).toBe(false);
    expect(job.created_at).toBe(new Date(1_000).toISOString());
    // Absent rather than null, as they were on the document.
    expect('checkpoint' in job).toBe(false);
    expect('batch_scopes' in job).toBe(false);

    // The columns the document's field names do not match.
    const row = handle.db
      .query(`SELECT params, ledger, progress_current, progress_total FROM jobs WHERE id = ?`)
      .get(job._id.toHexString());
    expect(row).toEqual({
      params: '{"assetIds":["a","b"]}',
      ledger: null,
      progress_current: 0,
      progress_total: 0,
    });
  });

  test('a replayed request id returns the stored job instead of a second one', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const requestId = newObjectIdHex();
    const input = { kind: 'pano_stitch' as const, payload: { assetIds: ['a'] }, requestId };

    const first = await createJob(input, at(0), undefined, db);
    const second = await createJob(input, at(5_000), undefined, db);

    expect(second._id.toHexString()).toBe(first._id.toHexString());
    expect(second.created_at).toBe(first.created_at);
    expect(handle.db.query(`SELECT COUNT(*) AS n FROM jobs`).get()).toEqual({ n: 1 });
  });

  test('the same request id with a different payload is a caller error', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const requestId = newObjectIdHex();

    await createJob(
      { kind: 'pano_stitch', payload: { assetIds: ['a'] }, requestId },
      at(0),
      undefined,
      db,
    );

    const attempt = createJob(
      { kind: 'pano_stitch', payload: { assetIds: ['b'] }, requestId },
      at(0),
      undefined,
      db,
    );
    await expect(attempt).rejects.toThrow(JobConflictError);
  });
});

describe('the active-batch fence', () => {
  test('a second batch sharing a library root is refused', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    await batch(db, ['/srv/one', '/srv/two']);

    let caught: unknown;
    try {
      await batch(db, ['/srv/two']);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(JobConflictError);
    expect(jobConflictMessage(caught)).toContain('Another settings batch is active');
    expect(handle.db.query(`SELECT COUNT(*) AS n FROM jobs`).get()).toEqual({ n: 1 });
  });

  test('disjoint roots run concurrently, and a job with no scopes fences nothing', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);

    await batch(db, ['/srv/one']);
    await batch(db, ['/srv/two']);
    // An empty scope list locks no library, so it neither fences nor is fenced.
    await batch(db, []);
    // Neither does a job of a kind that never holds a library exclusively.
    await restoreJob(db);

    expect(handle.db.query(`SELECT COUNT(*) AS n FROM jobs`).get()).toEqual({ n: 4 });
  });

  test('a finished batch releases its roots', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const first = await batch(db, ['/srv/one']);
    await completeJob(first._id, { ok: true }, at(0), undefined, db);

    const second = await batch(db, ['/srv/one']);
    expect(second.batch_scopes).toEqual(['/srv/one']);
  });
});

describe('claimJob', () => {
  test('marks the named job running under the attempt that claimed it', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const older = await restoreJob(db, 1_000);
    const newer = await restoreJob(db, 2_000);

    const claimed = await claimJob(newer._id, 'worker-1', at(3_000), db);

    expect(claimed?._id.toHexString()).toBe(newer._id.toHexString());
    expect(claimed?.payload).toEqual({ assetIds: ['a', 'b'] });
    const stored = await getJob(newer._id, db);
    expect(stored?.status).toBe('running');
    expect(stored?.locked_by).toBe('worker-1');
    expect(stored?.updated_at).toBe(new Date(3_000).toISOString());
    expect((await getJob(older._id, db))?.status).toBe('queued');
  });

  test('a later attempt takes a running job over and is handed its ledger', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const job = await restoreJob(db, 0);
    await claimJob(job._id, 'worker-1', at(0), db);
    await saveJobCheckpoint(job._id, 'worker-1', { applied: 2 }, at(0), undefined, db);

    const retaken = await claimJob(job._id, 'worker-2', at(1), db);

    expect(retaken?.checkpoint).toEqual({ applied: 2 });
    expect((await getJob(job._id, db))?.locked_by).toBe('worker-2');
  });

  test('a finished or unknown job is not claimable', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const job = await restoreJob(db, 0);
    await completeJob(job._id, { ok: true }, at(0), undefined, db);

    expect(await claimJob(job._id, 'worker-1', at(1), db)).toBeNull();
    expect(await claimJob(new ObjectId(), 'worker-1', at(1), db)).toBeNull();
    expect((await getJob(job._id, db))?.status).toBe('done');
  });
});

describe('the relay queries', () => {
  const hex = (job: { _id: ObjectId }) => job._id.toHexString();

  test('the next job is the oldest queued one, and only once nothing is held', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const older = await batch(db, ['/srv/one'], 1_000);
    const newer = await restoreJob(db, 2_000);

    expect(await nextJobId(db)).toBe(hex(older));
    expect(await heldJobIds(db)).toEqual([]);

    await markJobDispatched(hex(older), db);
    expect(await nextJobId(db)).toBeNull();
    expect(await heldJobIds(db)).toEqual([hex(older)]);

    await claimJob(older._id, 'worker-1', at(3_000), db);
    expect(await nextJobId(db)).toBeNull();
    expect(await heldJobIds(db)).toEqual([hex(older)]);

    await failJob(older._id, 'boom', at(4_000), 'worker-1', db);
    expect(await nextJobId(db)).toBe(hex(newer));
    expect(await heldJobIds(db)).toEqual([]);
  });

  test('a resumed job goes back in line by its creation time', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const older = await batch(db, ['/srv/one'], 1_000);
    const newer = await restoreJob(db, 2_000);
    await failJob(older._id, 'boom', at(3_000), undefined, db);
    expect(await nextJobId(db)).toBe(hex(newer));

    expect(await resumeBatchJob(older._id, db)).toBe(true);

    expect(await nextJobId(db)).toBe(hex(older));
  });

  test('marking never overwrites the attempt that already claimed the job', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const job = await restoreJob(db, 0);
    await claimJob(job._id, 'worker-1', at(0), db);

    await markJobDispatched(hex(job), db);

    expect((await getJob(job._id, db))?.locked_by).toBe('worker-1');
  });

  test('cancelling an unfinished job closes it and leaves a finished one alone', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const [waiting, running, done] = await Promise.all([
      restoreJob(db, 1),
      restoreJob(db, 2),
      restoreJob(db, 3),
    ]);
    await claimJob(running._id, 'worker-1', at(4), db);
    await completeJob(done._id, { ok: true }, at(4), undefined, db);

    await Promise.all(
      [waiting, running, done].map((job) => cancelUnfinishedJob(job._id, at(5), db)),
    );

    const stored = await Promise.all([waiting, running, done].map((job) => getJob(job._id, db)));
    expect(stored.map((job) => job?.status)).toEqual(['cancelled', 'cancelled', 'done']);
    expect(stored[1]?.locked_by).toBeNull();
    expect(stored[2]?.result).toEqual({ ok: true });
  });
});

describe('progress and terminal states', () => {
  test('a fenced progress write refuses a worker that lost the lease', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const job = await restoreJob(db, 0);
    await claimJob(job._id, 'worker-1', at(0), db);

    await updateProgress(job._id, { current: 1, total: 6 }, at(1_000), 'worker-1', db);
    expect((await getJob(job._id, db))?.progress).toEqual({ current: 1, total: 6 });

    const stale = updateProgress(job._id, { current: 2, total: 6 }, at(0), 'worker-2', db);
    await expect(stale).rejects.toThrow('claimed by another worker');
  });

  test('an unfenced progress write lands whoever holds the lease', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const job = await restoreJob(db, 0);

    await updateProgress(job._id, { current: 3, total: 3 }, at(0), undefined, db);
    expect((await getJob(job._id, db))?.progress).toEqual({ current: 3, total: 3 });
  });

  test('done, failed and cancelled each release the lock and keep their payload', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const [done, failed, cancelled] = await Promise.all([
      restoreJob(db, 1),
      restoreJob(db, 2),
      restoreJob(db, 3),
    ]);

    await completeJob(done._id, { outputAssetId: 'x' }, at(0), undefined, db);
    await failJob(failed._id, 'maple-cli exited 1', at(0), undefined, db);
    await markCancelled(cancelled._id, { stagesCompleted: 2 }, at(0), undefined, db);

    const stored = await Promise.all([
      getJob(done._id, db),
      getJob(failed._id, db),
      getJob(cancelled._id, db),
    ]);
    expect(stored.map((job) => job?.status)).toEqual(['done', 'failed', 'cancelled']);
    expect(stored.every((job) => job?.locked_by === null)).toBe(true);
    expect(stored[0]?.result).toEqual({ outputAssetId: 'x' });
    expect(stored[1]?.error).toBe('maple-cli exited 1');
    expect(stored[2]?.result).toEqual({ stagesCompleted: 2 });
  });

  test('cancellation is a flag the handler reads between steps', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const job = await restoreJob(db, 0);

    expect(await isCancelRequested(job._id, db)).toBe(false);
    expect(await requestCancel(job._id, at(0), db)).toBe(true);
    expect(await isCancelRequested(job._id, db)).toBe(true);
    expect(await requestCancel(new ObjectId(), at(0), db)).toBe(false);
  });
});

describe('saveJobCheckpoint', () => {
  const ledger = { entries: [{ n: 0 }, { n: 1 }], applied: 0, failed: 0, remaining: 2 };

  /** A running job held by `worker-1`. */
  async function running(db: SqliteDb) {
    const job = await restoreJob(db, 0);
    await claimJob(job._id, 'worker-1', at(0), db);
    return job;
  }

  test('writes the whole ledger and stamps the write', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const job = await running(db);

    await saveJobCheckpoint(job._id, 'worker-1', ledger, at(5_000), undefined, db);

    const stored = await getJob(job._id, db);
    expect(stored?.checkpoint).toEqual(ledger);
    expect(stored?.updated_at).toBe(new Date(5_000).toISOString());
  });

  test('an entry write patches one element and the three counters', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const job = await running(db);
    await saveJobCheckpoint(job._id, 'worker-1', ledger, at(0), undefined, db);

    const advanced = {
      entries: [{ n: 0 }, { n: 1, done: true }],
      applied: 1,
      failed: 0,
      remaining: 1,
    };
    await saveJobCheckpoint(job._id, 'worker-1', advanced, at(0), 1, db);

    expect((await getJob(job._id, db))?.checkpoint).toEqual(advanced);
  });

  test('an entry write falls back to the whole ledger when nothing is stored yet', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const job = await running(db);

    await saveJobCheckpoint(job._id, 'worker-1', ledger, at(0), 1, db);

    expect((await getJob(job._id, db))?.checkpoint).toEqual(ledger);
  });

  test('an index outside the caller’s own array is a programming error', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const job = await running(db);

    await expect(saveJobCheckpoint(job._id, 'worker-1', ledger, at(0), 7, db)).rejects.toThrow(
      'Invalid batch checkpoint entry',
    );
  });

  test('a worker that lost the lease cannot overwrite the ledger', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const job = await running(db);

    await expect(
      saveJobCheckpoint(job._id, 'worker-2', ledger, at(0), undefined, db),
    ).rejects.toThrow('claimed by another worker');
  });
});

describe('resumeBatchJob', () => {
  test('re-queues a failed batch, keeping its ledger and clearing its error', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const job = await batch(db, ['/srv/one']);
    await claimJob(job._id, 'worker-1', at(0), db);
    await saveJobCheckpoint(job._id, 'worker-1', { applied: 1 }, at(0), undefined, db);
    await failJob(job._id, 'boom', at(0), undefined, db);

    expect(await resumeBatchJob(job._id, db)).toBe(true);

    const stored = await getJob(job._id, db);
    expect(stored?.status).toBe('queued');
    expect(stored?.error).toBeNull();
    expect(stored?.result).toBeNull();
    expect(stored?.locked_by).toBeNull();
    expect(stored?.cancel_requested).toBe(false);
    expect(stored?.checkpoint).toEqual({ applied: 1 });
  });

  test('refuses a job that is not a terminal batch', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const queued = await batch(db, ['/srv/one']);
    expect(await resumeBatchJob(queued._id, db)).toBe(false);

    const pan = await restoreJob(db, 1);
    await failJob(pan._id, 'boom', at(0), undefined, db);
    expect(await resumeBatchJob(pan._id, db)).toBe(false);
  });

  test('refuses to re-queue into a library another batch already holds', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const first = await batch(db, ['/srv/one'], 1);
    await failJob(first._id, 'boom', at(0), undefined, db);
    const rival = await batch(db, ['/srv/one'], 2);

    // Resuming makes the job active again, so it faces the same fence a fresh
    // batch would.
    expect(await resumeBatchJob(first._id, db)).toBe(false);
    expect((await getJob(first._id, db))?.status).toBe('failed');

    await markCancelled(rival._id, null, at(0), undefined, db);
    expect(await resumeBatchJob(first._id, db)).toBe(true);
  });
});

describe('listJobs', () => {
  test('filters by status and kind, newest first, and caps the limit', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const queued = await restoreJob(db, 1_000);
    const older = await restoreJob(db, 2_000);
    const running = await restoreJob(db, 3_000);
    await claimJob(queued._id, 'worker-1', at(4_000), db);
    const batchJob = await batch(db, ['/srv/one'], 5_000);

    expect((await listJobs({ status: 'queued' }, db)).map((job) => job._id.toHexString())).toEqual([
      batchJob._id.toHexString(),
      running._id.toHexString(),
      older._id.toHexString(),
    ]);
    expect((await listJobs({ kind: 'batch_adjustment_sync' }, db)).length).toBe(1);
    expect((await listJobs({ statuses: ['running', 'queued'] }, db)).length).toBe(4);
    expect((await listJobs({ limit: 1 }, db)).length).toBe(1);
    expect((await listJobs({ status: 'running' }, db))[0]?._id.toHexString()).toBe(
      queued._id.toHexString(),
    );
  });
});
