/**
 * The import queue: claiming, lease renewal, per-file progress, cancellation
 * and the three terminal transitions.
 *
 * The claim is the part of this port that could not copy its mechanism.
 * MongoDB's `findOneAndUpdate` picks a winner inside the server; here the
 * winner is decided by the row count of an `UPDATE` that repeats the claimable
 * predicate, and the last test in the claim block fails if that `WHERE` clause
 * is weakened. The progress writes matter for the same reason from the other
 * direction: a file row that vanished underneath the worker must not let the
 * import-level counters advance.
 */

import { describe, expect, test } from 'bun:test';
import { ObjectId } from '../../object-id.ts';
import {
  claimImport,
  completeImport,
  createImport,
  failImport,
  getImport,
  getImportFiles,
  isImportCancelRequested,
  markImportCancelled,
  renewImportLease,
  requestImportCancel,
  updateImportProgress,
} from './imports.repo.ts';
import {
  createTestDatabase,
  insertFolder,
  run,
  testSqliteDb,
} from '../test-sqlite.test-helpers.ts';
import type { ImportFileEntry } from '../../schema.ts';
import type { SqlParams } from '../protocol.ts';
import type { SqliteDb } from './db-handle.ts';

const CANDIDATE_QUERY = 'ORDER BY created_at, id LIMIT 8';

function entries(count: number): ImportFileEntry[] {
  return Array.from({ length: count }, (_unused, i) => ({
    src: `/inbox/IMG_${i}.dng`,
    dest: `2026/04/IMG_${i}.dng`,
    size: 4096,
    mtime: 1_700_000_000_000,
    kind: 'image' as const,
    state: 'pending' as const,
    error: null,
  }));
}

async function newImport(
  db: SqliteDb,
  library: ObjectId,
  fileCount = 0,
  createdAt?: string,
): Promise<ObjectId> {
  const created = await createImport(
    {
      source_root: '/inbox',
      library_id: library,
      library_root: '/libraries/main',
      files: entries(fileCount),
    },
    createdAt === undefined ? undefined : () => new Date(createdAt),
    db,
  );
  return created._id;
}

/**
 * The same handle, except that a rival worker claims the ids the first
 * candidate read returned before this caller can act on them.
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

describe('claimImport', () => {
  test('claims the oldest pending import and leaves nothing for the next worker', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const library = new ObjectId(insertFolder(handle.db));
    const older = await newImport(db, library, 2, '2026-04-01T10:00:00.000Z');
    const newer = await newImport(db, library, 0, '2026-04-02T10:00:00.000Z');

    const first = await claimImport(
      'worker-1',
      60_000,
      () => new Date('2026-04-03T00:00:00.000Z'),
      db,
    );
    expect(first!._id.toHexString()).toBe(older.toHexString());
    expect(first!.source_root).toBe('/inbox');
    expect(first!.library_id.toHexString()).toBe(library.toHexString());
    expect(first!.scan_pending).toBe(false);

    const claimed = (await getImport(older, db))!;
    expect(claimed.status).toBe('running');
    expect(claimed.locked_by).toBe('worker-1');
    expect(claimed.lease_expires_at).toBe('2026-04-03T00:01:00.000Z');

    const second = await claimImport(
      'worker-2',
      60_000,
      () => new Date('2026-04-03T00:00:00.000Z'),
      db,
    );
    expect(second!._id.toHexString()).toBe(newer.toHexString());
    expect(
      await claimImport('worker-3', 60_000, () => new Date('2026-04-03T00:00:00.000Z'), db),
    ).toBeNull();
  });

  test('leaves a running import alone until its lease lapses', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const library = new ObjectId(insertFolder(handle.db));
    const id = await newImport(db, library);

    await claimImport('worker-1', 60_000, () => new Date('2026-04-03T00:00:00.000Z'), db);
    expect(
      await claimImport('worker-2', 60_000, () => new Date('2026-04-03T00:00:30.000Z'), db),
    ).toBeNull();

    const retaken = await claimImport(
      'worker-2',
      60_000,
      () => new Date('2026-04-03T00:02:00.000Z'),
      db,
    );
    expect(retaken!._id.toHexString()).toBe(id.toHexString());
    expect((await getImport(id, db))!.locked_by).toBe('worker-2');
  });

  test('never reclaims a running import that recorded no lease at all', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const library = new ObjectId(insertFolder(handle.db));
    const id = await newImport(db, library);
    run(
      handle.db,
      `UPDATE imports SET status = 'running', locked_by = 'ghost', lease_expires_at = NULL
        WHERE id = ?`,
      id.toHexString(),
    );

    expect(await claimImport('worker-1', 60_000, undefined, db)).toBeNull();
  });

  test('skips an import a rival worker claimed after the candidate read', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const library = new ObjectId(insertFolder(handle.db));
    const older = await newImport(db, library, 0, '2026-04-01T10:00:00.000Z');
    const newer = await newImport(db, library, 0, '2026-04-02T10:00:00.000Z');

    const stolen: string[] = [];
    const racy = withRivalWorker(db, (ids) => {
      const first = ids[0];
      if (first === undefined) return;
      stolen.push(first);
      run(
        handle.db,
        `UPDATE imports SET status = 'running', locked_by = 'rival',
            lease_expires_at = '2099-01-01T00:00:00.000Z' WHERE id = ?`,
        first,
      );
    });

    const claimed = await claimImport('worker-1', 60_000, undefined, racy);

    expect(stolen).toEqual([older.toHexString()]);
    expect(claimed!._id.toHexString()).toBe(newer.toHexString());
    // The rival keeps its import.
    expect((await getImport(older, db))!.locked_by).toBe('rival');
  });

  test('returns null when a rival takes every candidate', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const library = new ObjectId(insertFolder(handle.db));
    await newImport(db, library, 0, '2026-04-01T10:00:00.000Z');
    await newImport(db, library, 0, '2026-04-02T10:00:00.000Z');

    const racy = withRivalWorker(db, (ids) => {
      for (const id of ids) {
        run(
          handle.db,
          `UPDATE imports SET status = 'running', locked_by = 'rival',
              lease_expires_at = '2099-01-01T00:00:00.000Z' WHERE id = ?`,
          id,
        );
      }
    });

    expect(await claimImport('worker-1', 60_000, undefined, racy)).toBeNull();
  });
});

describe('updateImportProgress and renewImportLease', () => {
  test('records one file outcome and the import-level tally together', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const library = new ObjectId(insertFolder(handle.db));
    const id = await newImport(db, library, 3);

    await updateImportProgress(
      id,
      {
        index: 1,
        state: 'copied',
        error: null,
        destRel: '2026/04/IMG_1-1.dng',
        current: 1,
        counts: { copied: 1, skipped: 0, failed: 0 },
      },
      60_000,
      () => new Date('2026-04-03T00:00:00.000Z'),
      db,
    );

    const files = await getImportFiles(id, db);
    expect(files[1]).toMatchObject({
      idx: 1,
      state: 'copied',
      dest: '2026/04/IMG_1-1.dng',
      error: null,
    });
    expect(files[0]!.state).toBe('pending');

    const after = (await getImport(id, db))!;
    expect(after.progress).toEqual({ current: 1, total: 3 });
    expect(after.counts).toEqual({ copied: 1, skipped: 0, failed: 0 });
    expect(after.lease_expires_at).toBe('2026-04-03T00:01:00.000Z');
  });

  test('records a failure with its message', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const library = new ObjectId(insertFolder(handle.db));
    const id = await newImport(db, library, 1);

    await updateImportProgress(
      id,
      {
        index: 0,
        state: 'failed',
        error: 'EACCES',
        destRel: '2026/04/IMG_0.dng',
        current: 1,
        counts: { copied: 0, skipped: 0, failed: 1 },
      },
      60_000,
      undefined,
      db,
    );

    expect((await getImportFiles(id, db))[0]).toMatchObject({ state: 'failed', error: 'EACCES' });
    expect((await getImport(id, db))!.counts.failed).toBe(1);
  });

  test('throws for a file row that is not there, and advances nothing', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const library = new ObjectId(insertFolder(handle.db));
    const id = await newImport(db, library, 1);
    const before = (await getImport(id, db))!;

    await expect(
      updateImportProgress(
        id,
        {
          index: 7,
          state: 'copied',
          error: null,
          destRel: '2026/04/ghost.dng',
          current: 1,
          counts: { copied: 1, skipped: 0, failed: 0 },
        },
        60_000,
        undefined,
        db,
      ),
    ).rejects.toThrow(/no import_files row/);

    const after = (await getImport(id, db))!;
    expect(after.progress).toEqual(before.progress);
    expect(after.counts).toEqual(before.counts);
    expect(after.lease_expires_at).toBe(before.lease_expires_at);
  });

  test('renews a lease only while the import is running', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const library = new ObjectId(insertFolder(handle.db));
    const id = await newImport(db, library);

    await renewImportLease(id, 60_000, () => new Date('2026-04-03T00:00:00.000Z'), db);
    expect((await getImport(id, db))!.lease_expires_at).toBeNull();

    await claimImport('worker-1', 1_000, () => new Date('2026-04-03T00:00:00.000Z'), db);
    await renewImportLease(id, 600_000, () => new Date('2026-04-03T00:00:10.000Z'), db);
    expect((await getImport(id, db))!.lease_expires_at).toBe('2026-04-03T00:10:10.000Z');
  });
});

describe('cancellation', () => {
  test('flags a pending or running import and reports the flag back', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const library = new ObjectId(insertFolder(handle.db));
    const id = await newImport(db, library);

    expect(await isImportCancelRequested(id, db)).toBe(false);
    expect(await requestImportCancel(id, () => new Date('2026-04-03T00:00:00.000Z'), db)).toBe(
      true,
    );
    expect(await isImportCancelRequested(id, db)).toBe(true);
    expect((await getImport(id, db))!.cancel_requested).toBe(true);
  });

  test('refuses an import that already finished, and an id that never existed', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const library = new ObjectId(insertFolder(handle.db));
    const id = await newImport(db, library);
    await completeImport(id, { copied: 0, skipped: 0, failed: 0 }, undefined, db);

    expect(await requestImportCancel(id, undefined, db)).toBe(false);
    expect(await requestImportCancel(new ObjectId(), undefined, db)).toBe(false);
    expect(await isImportCancelRequested(new ObjectId(), db)).toBe(false);
  });
});

describe('terminal transitions', () => {
  test('completing releases the claim, writes the counts and clears the error', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const library = new ObjectId(insertFolder(handle.db));
    const id = await newImport(db, library);
    await claimImport('worker-1', 60_000, undefined, db);
    run(handle.db, `UPDATE imports SET error = 'earlier failure' WHERE id = ?`, id.toHexString());

    await completeImport(
      id,
      { copied: 4, skipped: 1, failed: 0 },
      () => new Date('2026-04-03T01:00:00.000Z'),
      db,
    );

    const done = (await getImport(id, db))!;
    expect(done.status).toBe('done');
    expect(done.counts).toEqual({ copied: 4, skipped: 1, failed: 0 });
    expect(done.error).toBeNull();
    expect(done.locked_by).toBeNull();
    expect(done.lease_expires_at).toBeNull();
    expect(done.updated_at).toBe('2026-04-03T01:00:00.000Z');
  });

  test('failing records the message and releases the claim', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const library = new ObjectId(insertFolder(handle.db));
    const id = await newImport(db, library);
    await claimImport('worker-1', 60_000, undefined, db);

    await failImport(id, 'source root vanished', undefined, db);

    const failed = (await getImport(id, db))!;
    expect(failed.status).toBe('failed');
    expect(failed.error).toBe('source root vanished');
    expect(failed.locked_by).toBeNull();
    expect(failed.lease_expires_at).toBeNull();
  });

  test('cancelling keeps the tally of what had already been copied', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const library = new ObjectId(insertFolder(handle.db));
    const id = await newImport(db, library);
    await claimImport('worker-1', 60_000, undefined, db);

    await markImportCancelled(id, { copied: 2, skipped: 0, failed: 1 }, undefined, db);

    const cancelled = (await getImport(id, db))!;
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.counts).toEqual({ copied: 2, skipped: 0, failed: 1 });
    expect(cancelled.locked_by).toBeNull();
  });
});
