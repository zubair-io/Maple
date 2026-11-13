/**
 * The import queue: the relay's view of it (which import goes to Temporal
 * next, which ones Temporal holds), claiming one by id, lease renewal,
 * per-file progress, cancellation and the three terminal transitions.
 *
 * The progress writes matter because a file row that vanished underneath the
 * worker must not let the import-level counters advance.
 */

import { describe, expect, test } from 'bun:test';
import { ObjectId } from '../object-id.ts';
import {
  cancelUnfinishedImport,
  claimImport,
  completeImport,
  createImport,
  failImport,
  getImport,
  getImportFiles,
  heldImportIds,
  isImportCancelRequested,
  markImportCancelled,
  markImportDispatched,
  nextImportId,
  requestImportCancel,
  updateImportProgress,
} from './imports.repo.ts';
import {
  createTestDatabase,
  insertFolder,
  run,
  testSqliteDb,
} from '../sqlite/test-sqlite.test-helpers.ts';
import type { ImportFileEntry } from '../schema.ts';
import type { SqliteDb } from './db-handle.ts';

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

const AT = () => new Date('2026-04-03T00:00:00.000Z');

describe('claimImport', () => {
  test('claims the import it is given, by id, and records the attempt holding it', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const library = new ObjectId(insertFolder(handle.db));
    await newImport(db, library, 0, '2026-04-01T10:00:00.000Z');
    const newer = await newImport(db, library, 2, '2026-04-02T10:00:00.000Z');

    const claimed = await claimImport(newer, 'attempt-1', AT, db);

    expect(claimed!._id.toHexString()).toBe(newer.toHexString());
    expect(claimed!.source_root).toBe('/inbox');
    expect(claimed!.library_id.toHexString()).toBe(library.toHexString());
    expect(claimed!.scan_pending).toBe(false);
    const after = (await getImport(newer, db))!;
    expect(after.status).toBe('running');
    expect(after.locked_by).toBe('attempt-1');
    expect(after.updated_at).toBe(AT().toISOString());
  });

  test('a later attempt takes over a running import', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const library = new ObjectId(insertFolder(handle.db));
    const id = await newImport(db, library);
    run(
      handle.db,
      `UPDATE imports SET status = 'running', locked_by = 'import-worker-1-abc' WHERE id = ?`,
      id.toHexString(),
    );

    expect(await claimImport(id, 'attempt-2', AT, db)).not.toBeNull();
    expect((await getImport(id, db))!.locked_by).toBe('attempt-2');
  });

  test('a finished import, or one that never existed, is not claimed', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const library = new ObjectId(insertFolder(handle.db));
    const id = await newImport(db, library);
    await completeImport(id, { copied: 0, skipped: 0, failed: 0 }, undefined, db);

    expect(await claimImport(id, 'attempt-1', undefined, db)).toBeNull();
    expect(await claimImport(new ObjectId(), 'attempt-1', undefined, db)).toBeNull();
    expect((await getImport(id, db))!.status).toBe('done');
  });
});

describe('the relay queue', () => {
  test('offers the oldest pending import, and nothing more while one is held', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const library = new ObjectId(insertFolder(handle.db));
    const newer = await newImport(db, library, 0, '2026-04-02T10:00:00.000Z');
    const older = await newImport(db, library, 0, '2026-04-01T10:00:00.000Z');

    expect(await nextImportId(db)).toBe(older.toHexString());
    expect(await heldImportIds(db)).toEqual([]);

    await markImportDispatched(older.toHexString(), db);

    expect((await getImport(older, db))!.locked_by).toBe('temporal');
    expect(await nextImportId(db)).toBeNull();
    expect(await heldImportIds(db)).toEqual([older.toHexString()]);

    await claimImport(older, 'attempt-1', undefined, db);
    expect(await nextImportId(db)).toBeNull();
    expect(await heldImportIds(db)).toEqual([older.toHexString()]);

    await completeImport(older, { copied: 0, skipped: 0, failed: 0 }, undefined, db);
    expect(await heldImportIds(db)).toEqual([]);
    expect(await nextImportId(db)).toBe(newer.toHexString());
  });

  test('marking dispatched leaves an import its activity already claimed alone', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const library = new ObjectId(insertFolder(handle.db));
    const id = await newImport(db, library);
    await claimImport(id, 'attempt-1', undefined, db);

    await markImportDispatched(id.toHexString(), db);

    expect((await getImport(id, db))!.locked_by).toBe('attempt-1');
  });

  test('an import left running by the old runner counts as held', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const library = new ObjectId(insertFolder(handle.db));
    const running = await newImport(db, library, 0, '2026-04-02T10:00:00.000Z');
    await newImport(db, library, 0, '2026-04-01T10:00:00.000Z');
    run(
      handle.db,
      `UPDATE imports SET status = 'running', locked_by = 'import-worker-1-abc' WHERE id = ?`,
      running.toHexString(),
    );

    expect(await heldImportIds(db)).toEqual([running.toHexString()]);
    expect(await nextImportId(db)).toBeNull();
  });

  test('cancelling an unfinished import releases it and lets the next one through', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const library = new ObjectId(insertFolder(handle.db));
    const stopped = await newImport(db, library, 0, '2026-04-01T10:00:00.000Z');
    const next = await newImport(db, library, 0, '2026-04-02T10:00:00.000Z');
    await claimImport(stopped, 'attempt-1', undefined, db);

    await cancelUnfinishedImport(stopped, AT, db);

    const after = (await getImport(stopped, db))!;
    expect(after.status).toBe('cancelled');
    expect(after.cancel_requested).toBe(true);
    expect(after.locked_by).toBeNull();
    expect(await nextImportId(db)).toBe(next.toHexString());
  });

  test('cancelling leaves a finished import as it finished', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const library = new ObjectId(insertFolder(handle.db));
    const id = await newImport(db, library);
    await failImport(id, 'disk full', undefined, db);

    await cancelUnfinishedImport(id, undefined, db);

    expect((await getImport(id, db))!.status).toBe('failed');
  });
});

describe('updateImportProgress', () => {
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
    expect(after.updated_at).toBe('2026-04-03T00:00:00.000Z');
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
        undefined,
        db,
      ),
    ).rejects.toThrow(/no import_files row/);

    const after = (await getImport(id, db))!;
    expect(after.progress).toEqual(before.progress);
    expect(after.counts).toEqual(before.counts);
    expect(after.updated_at).toBe(before.updated_at);
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
    await claimImport(id, 'worker-1', undefined, db);
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
    expect(done.updated_at).toBe('2026-04-03T01:00:00.000Z');
  });

  test('failing records the message and releases the claim', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const library = new ObjectId(insertFolder(handle.db));
    const id = await newImport(db, library);
    await claimImport(id, 'worker-1', undefined, db);

    await failImport(id, 'source root vanished', undefined, db);

    const failed = (await getImport(id, db))!;
    expect(failed.status).toBe('failed');
    expect(failed.error).toBe('source root vanished');
    expect(failed.locked_by).toBeNull();
  });

  test('cancelling keeps the tally of what had already been copied', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const library = new ObjectId(insertFolder(handle.db));
    const id = await newImport(db, library);
    await claimImport(id, 'worker-1', undefined, db);

    await markImportCancelled(id, { copied: 2, skipped: 0, failed: 1 }, undefined, db);

    const cancelled = (await getImport(id, db))!;
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.counts).toEqual({ copied: 2, skipped: 0, failed: 1 });
    expect(cancelled.locked_by).toBeNull();
  });

  test('a late finish leaves an import its workflow already stopped as cancelled', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const library = new ObjectId(insertFolder(handle.db));
    const id = await newImport(db, library);
    await claimImport(id, 'worker-1', undefined, db);
    await cancelUnfinishedImport(id, undefined, db);

    await completeImport(id, { copied: 1, skipped: 0, failed: 0 }, undefined, db);
    await failImport(id, 'late', undefined, db);

    const after = (await getImport(id, db))!;
    expect(after.status).toBe('cancelled');
    expect(after.error).toBeNull();
  });
});
