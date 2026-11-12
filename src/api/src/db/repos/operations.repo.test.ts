/**
 * Operator one-shots share the `jobs` table with user jobs but not their lane:
 * each lane's relay queries see only their own kinds, user jobs keep running
 * strictly one at a time in creation order whatever operations do, and the
 * insert refuses a second active operation of a kind (per folder, for scans).
 */

import { describe, expect, test } from 'bun:test';
import { ObjectId } from '../object-id.ts';
import { createTestDatabase, testSqliteDb } from '../sqlite/test-sqlite.test-helpers.ts';
import type { OperationKind } from '../schema.ts';
import type { SqliteDb } from './db-handle.ts';
import {
  claimJob,
  completeJob,
  createJob,
  getJob,
  heldJobIds,
  JobConflictError,
  listJobs,
  markJobDispatched,
  nextJobId,
  requestCancel,
} from './jobs.repo.ts';
import { activeOperationId, heldOperationIds, nextOperationId } from './operations.repo.ts';

const at = (ms: number) => () => new Date(ms);
const hex = (job: { _id: ObjectId }) => job._id.toHexString();

const userJob = (db: SqliteDb, ms: number) =>
  createJob({ kind: 'cloud_backup_restore', payload: { n: ms } }, at(ms), undefined, db);

const operation = (
  db: SqliteDb,
  kind: OperationKind,
  ms: number,
  payload: Record<string, unknown> = {},
) => createJob({ kind, payload }, at(ms), undefined, db);

async function drainUserJobs(db: SqliteDb): Promise<string[]> {
  const id = await nextJobId(db);
  if (id === null) return [];
  await markJobDispatched(id, db);
  await claimJob(new ObjectId(id), 'w', at(0), db);
  await completeJob(new ObjectId(id), {}, at(0), 'w', db);
  return [id, ...(await drainUserJobs(db))];
}

describe('the two lanes over one table', () => {
  test('each lane relays and holds only its own kinds', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const scan = await operation(db, 'folder_scan', 1_000, { folderId: 'a'.repeat(24) });
    const job = await userJob(db, 2_000);

    expect(await nextJobId(db)).toBe(hex(job));
    expect(await nextOperationId(db)).toBe(hex(scan));

    await markJobDispatched(hex(scan), db);
    await markJobDispatched(hex(job), db);

    expect(await heldJobIds(db)).toEqual([hex(job)]);
    expect(await heldOperationIds(db)).toEqual([hex(scan)]);
    expect(await nextJobId(db)).toBeNull();
    expect(await nextOperationId(db)).toBeNull();
  });

  test('a held operation never holds a user job back, and user jobs still go one at a time in order', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const cluster = await operation(db, 'people_cluster', 500);
    await markJobDispatched(hex(cluster), db);
    await claimJob(cluster._id, 'op', at(600), db);
    const jobs = [await userJob(db, 3_000), await userJob(db, 1_000), await userJob(db, 2_000)];

    expect(await drainUserJobs(db)).toEqual([jobs[1], jobs[2], jobs[0]].map(hex));
    expect(await heldOperationIds(db)).toEqual([hex(cluster)]);
  });

  test('operations of different kinds and folders are relayed side by side', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const reconcile = await operation(db, 'mirror_reconcile', 1_000);
    const scanA = await operation(db, 'folder_scan', 2_000, { folderId: 'a'.repeat(24) });
    const scanB = await operation(db, 'folder_scan', 3_000, { folderId: 'b'.repeat(24) });

    const relayed: string[] = [];
    for (let id = await nextOperationId(db); id !== null; id = await nextOperationId(db)) {
      relayed.push(id);
      await markJobDispatched(id, db);
    }

    expect(relayed).toEqual([reconcile, scanA, scanB].map(hex));
    expect(await heldOperationIds(db)).toEqual(relayed);
  });
});

describe('one active operation per kind and folder', () => {
  test('a second reconcile or clustering is refused while the first is queued or running', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const reconcile = await operation(db, 'mirror_reconcile', 0);
    const cluster = await operation(db, 'people_cluster', 0);

    await expect(operation(db, 'mirror_reconcile', 1)).rejects.toBeInstanceOf(JobConflictError);
    await claimJob(cluster._id, 'w', at(1), db);
    await expect(operation(db, 'people_cluster', 2)).rejects.toBeInstanceOf(JobConflictError);

    expect(await activeOperationId('mirror_reconcile', null, db)).toBe(hex(reconcile));
    expect(await activeOperationId('people_cluster', null, db)).toBe(hex(cluster));
    expect(await listJobs({}, db)).toHaveLength(2);
  });

  test('scans are exclusive per folder, not across folders', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const folderA = 'a'.repeat(24);
    const scanA = await operation(db, 'folder_scan', 0, { folderId: folderA });

    await expect(operation(db, 'folder_scan', 1, { folderId: folderA })).rejects.toBeInstanceOf(
      JobConflictError,
    );
    await operation(db, 'folder_scan', 2, { folderId: 'b'.repeat(24) });

    expect(await activeOperationId('folder_scan', folderA, db)).toBe(hex(scanA));
    expect(await activeOperationId('folder_scan', 'c'.repeat(24), db)).toBeNull();
  });

  test('a finished operation leaves room for the next', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const first = await operation(db, 'mirror_reconcile', 0);
    await claimJob(first._id, 'w', at(1), db);
    await completeJob(first._id, {}, at(2), 'w', db);

    const second = await operation(db, 'mirror_reconcile', 3);

    expect(await activeOperationId('mirror_reconcile', null, db)).toBe(hex(second));
  });

  test('cancelling an operation not yet handed over ends it at once and frees its slot', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const cancelled = await operation(db, 'mirror_reconcile', 0);

    await requestCancel(cancelled._id, at(1), db);

    expect((await getJob(cancelled._id, db))?.status).toBe('cancelled');
    expect(await nextOperationId(db)).toBeNull();
    const next = await operation(db, 'mirror_reconcile', 2);
    expect(await activeOperationId('mirror_reconcile', null, db)).toBe(hex(next));
  });

  test('a running operation whose cancel is pending is neither joined nor waited on', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const folderId = 'a'.repeat(24);
    const stopping = await operation(db, 'folder_scan', 0, { folderId });
    await markJobDispatched(hex(stopping), db);
    await claimJob(stopping._id, 'w', at(1), db);

    await requestCancel(stopping._id, at(2), db);

    expect((await getJob(stopping._id, db))?.status).toBe('running');
    expect(await activeOperationId('folder_scan', folderId, db)).toBeNull();
    const next = await operation(db, 'folder_scan', 3, { folderId });
    expect(await activeOperationId('folder_scan', folderId, db)).toBe(hex(next));
  });

  test('a user job keeps its queued state on cancel, for its runner to settle', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const job = await userJob(db, 0);

    await requestCancel(job._id, at(1), db);

    expect(await getJob(job._id, db)).toMatchObject({ status: 'queued', cancel_requested: true });
  });
});
