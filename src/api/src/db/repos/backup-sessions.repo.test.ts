/**
 * `backup_sessions` behaviour through the repository.
 *
 * The upsert carries three Mongo operators at once, and each has a case here:
 * the counters accumulate (`$inc`) rather than being overwritten, the progress
 * timestamp is rewritten every call (`$set`), the start time is not
 * (`$setOnInsert`), and a progress ping that omits the device's declared total
 * leaves the stored one alone.
 */

import { describe, expect, test } from 'bun:test';
import { newObjectIdHex } from '../object-id.ts';
import {
  createTestDatabase,
  insertFolder,
  run,
  testSqliteDb,
} from '../sqlite/test-sqlite.test-helpers.ts';
import { backupSessionsRepo } from './backup-sessions.repo.ts';
import { toObjectId } from './values.ts';

const DEVICE = 'iphone-17-pro';

describe('upsertProgress', () => {
  test('creates the row on first contact', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const libraryId = toObjectId(insertFolder(handle.db));

    await backupSessionsRepo.upsertProgress(
      { libraryId, deviceId: DEVICE, uploadedDelta: 3, failedDelta: 1, totalCount: 100 },
      db,
    );

    const session = await backupSessionsRepo.findOne({ libraryId, deviceId: DEVICE }, db);
    expect(session?.uploaded_count).toBe(3);
    expect(session?.failed_count).toBe(1);
    expect(session?.total_count).toBe(100);
    expect(session?.started_at).toBeInstanceOf(Date);
    expect(session?.last_progress_at).toBeInstanceOf(Date);
  });

  test('accumulates the counters instead of replacing them', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const libraryId = toObjectId(insertFolder(handle.db));

    await backupSessionsRepo.upsertProgress(
      { libraryId, deviceId: DEVICE, uploadedDelta: 3, failedDelta: 1 },
      db,
    );
    await backupSessionsRepo.upsertProgress(
      { libraryId, deviceId: DEVICE, uploadedDelta: 4, failedDelta: 2 },
      db,
    );

    const session = await backupSessionsRepo.findOne({ libraryId, deviceId: DEVICE }, db);
    expect(session?.uploaded_count).toBe(7);
    expect(session?.failed_count).toBe(3);
  });

  test('keeps started_at from the first ping and moves last_progress_at', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const libraryId = toObjectId(insertFolder(handle.db));

    await backupSessionsRepo.upsertProgress(
      { libraryId, deviceId: DEVICE, uploadedDelta: 1, failedDelta: 0 },
      db,
    );
    // Pin both timestamps into the past so "insert-only" is distinguishable
    // from "rewritten in the same millisecond".
    run(
      handle.db,
      `UPDATE backup_sessions SET started_at = ?, last_progress_at = ? WHERE device_id = ?`,
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
      DEVICE,
    );
    await backupSessionsRepo.upsertProgress(
      { libraryId, deviceId: DEVICE, uploadedDelta: 1, failedDelta: 0 },
      db,
    );

    const session = await backupSessionsRepo.findOne({ libraryId, deviceId: DEVICE }, db);
    expect(session?.started_at.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(session!.last_progress_at.getTime()).toBeGreaterThan(session!.started_at.getTime());
  });

  test('leaves the stored total alone when a ping does not carry one', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const libraryId = toObjectId(insertFolder(handle.db));

    await backupSessionsRepo.upsertProgress(
      { libraryId, deviceId: DEVICE, uploadedDelta: 1, failedDelta: 0, totalCount: 500 },
      db,
    );
    await backupSessionsRepo.upsertProgress(
      { libraryId, deviceId: DEVICE, uploadedDelta: 1, failedDelta: 0 },
      db,
    );

    const session = await backupSessionsRepo.findOne({ libraryId, deviceId: DEVICE }, db);
    expect(session?.total_count).toBe(500);
  });

  test('updates the total when a later ping revises it', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const libraryId = toObjectId(insertFolder(handle.db));

    await backupSessionsRepo.upsertProgress(
      { libraryId, deviceId: DEVICE, uploadedDelta: 0, failedDelta: 0, totalCount: 500 },
      db,
    );
    await backupSessionsRepo.upsertProgress(
      { libraryId, deviceId: DEVICE, uploadedDelta: 0, failedDelta: 0, totalCount: 480 },
      db,
    );

    const session = await backupSessionsRepo.findOne({ libraryId, deviceId: DEVICE }, db);
    expect(session?.total_count).toBe(480);
  });

  test('keeps one row per (library, device) pair', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const one = toObjectId(insertFolder(handle.db, { path: '/libraries/one', slug: 'one' }));
    const two = toObjectId(insertFolder(handle.db, { path: '/libraries/two', slug: 'two' }));

    await backupSessionsRepo.upsertProgress(
      { libraryId: one, deviceId: DEVICE, uploadedDelta: 1, failedDelta: 0 },
      db,
    );
    await backupSessionsRepo.upsertProgress(
      { libraryId: two, deviceId: DEVICE, uploadedDelta: 5, failedDelta: 0 },
      db,
    );
    await backupSessionsRepo.upsertProgress(
      { libraryId: one, deviceId: 'ipad', uploadedDelta: 9, failedDelta: 0 },
      db,
    );

    const rows = await db.read<{ n: number }>(`SELECT COUNT(*) AS n FROM backup_sessions`);
    expect(rows[0]?.n).toBe(3);
    expect(
      (await backupSessionsRepo.findOne({ libraryId: one, deviceId: DEVICE }, db))?.uploaded_count,
    ).toBe(1);
    expect(
      (await backupSessionsRepo.findOne({ libraryId: two, deviceId: DEVICE }, db))?.uploaded_count,
    ).toBe(5);
  });

  test('rejects negative deltas before touching the database', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const libraryId = toObjectId(insertFolder(handle.db));

    await expect(
      backupSessionsRepo.upsertProgress(
        { libraryId, deviceId: DEVICE, uploadedDelta: -1, failedDelta: 0 },
        db,
      ),
    ).rejects.toThrow('deltas must be >= 0');
    expect(await backupSessionsRepo.findOne({ libraryId, deviceId: DEVICE }, db)).toBeNull();
  });

  test('refuses progress for a library that is not registered', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    await expect(
      backupSessionsRepo.upsertProgress(
        {
          libraryId: toObjectId(newObjectIdHex()),
          deviceId: DEVICE,
          uploadedDelta: 1,
          failedDelta: 0,
        },
        db,
      ),
    ).rejects.toThrow();
  });
});

describe('findOne', () => {
  test('returns null for a device that has never reported', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const libraryId = toObjectId(insertFolder(handle.db));
    expect(await backupSessionsRepo.findOne({ libraryId, deviceId: 'unknown' }, db)).toBeNull();
  });

  test('carries the ids back as ObjectIds', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const folderId = insertFolder(handle.db);
    const libraryId = toObjectId(folderId);

    await backupSessionsRepo.upsertProgress(
      { libraryId, deviceId: DEVICE, uploadedDelta: 1, failedDelta: 0 },
      db,
    );
    const session = await backupSessionsRepo.findOne({ libraryId, deviceId: DEVICE }, db);
    expect(session?.library_id.toHexString()).toBe(folderId);
    expect(session?._id.toHexString()).toHaveLength(24);
  });
});
