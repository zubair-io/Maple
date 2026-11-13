/**
 * An import is written only by the attempt that holds it. Once a later
 * delivery has claimed the row, the earlier attempt's progress, file list and
 * terminal writes change nothing.
 */

import { describe, expect, test } from 'bun:test';
import { ObjectId } from '../object-id.ts';
import {
  claimImport,
  completeImport,
  createImport,
  failImport,
  getImport,
  getImportFiles,
  ImportTakenOver,
  markImportCancelled,
  setImportFiles,
  updateImportProgress,
} from './imports.repo.ts';
import {
  createTestDatabase,
  insertFolder,
  testSqliteDb,
} from '../sqlite/test-sqlite.test-helpers.ts';
import type { ImportFileEntry } from '../schema.ts';
import type { SqliteDb } from './db-handle.ts';

const entry = (name: string): ImportFileEntry => ({
  src: `/inbox/${name}`,
  dest: `2026/04/${name}`,
  size: 4096,
  mtime: 1_700_000_000_000,
  kind: 'image',
  state: 'pending',
  error: null,
});

const copied = (index: number, holder: string) => ({
  index,
  state: 'copied' as const,
  error: null,
  destRel: `2026/04/landed-${index}.dng`,
  current: index + 1,
  counts: { copied: index + 1, skipped: 0, failed: 0 },
  holder,
});

/** An import of two files that `first` claimed and `second` then took over. */
async function takenOver(db: SqliteDb, library: ObjectId): Promise<ObjectId> {
  const created = await createImport(
    {
      source_root: '/inbox',
      library_id: library,
      library_root: '/libraries/main',
      files: [entry('A.dng'), entry('B.dng')],
    },
    undefined,
    db,
  );
  await claimImport(created._id, 'first', undefined, db);
  await claimImport(created._id, 'second', undefined, db);
  return created._id;
}

describe('writes fenced to the attempt holding an import', () => {
  test('a replaced attempt records no file outcome, and the holder still can', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const id = await takenOver(db, new ObjectId(insertFolder(handle.db)));

    await expect(
      updateImportProgress(id, copied(0, 'first'), undefined, db),
    ).rejects.toBeInstanceOf(ImportTakenOver);
    expect((await getImportFiles(id, db)).map((file) => file.state)).toEqual([
      'pending',
      'pending',
    ]);
    expect((await getImport(id, db))!.progress.current).toBe(0);

    await updateImportProgress(id, copied(0, 'second'), undefined, db);
    expect((await getImportFiles(id, db))[0]).toMatchObject({
      state: 'copied',
      dest: '2026/04/landed-0.dng',
    });
    expect((await getImport(id, db))!.counts.copied).toBe(1);
  });

  test('the holder still hears about a file row that is not there', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const id = await takenOver(db, new ObjectId(insertFolder(handle.db)));

    await expect(updateImportProgress(id, copied(7, 'second'), undefined, db)).rejects.toThrow(
      'no import_files row',
    );
  });

  test('a replaced attempt cannot finish, fail or cancel the import', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const id = await takenOver(db, new ObjectId(insertFolder(handle.db)));
    const counts = { copied: 2, skipped: 0, failed: 0 };

    await completeImport(id, counts, undefined, db, 'first');
    await failImport(id, 'late failure', undefined, db, 'first');
    await markImportCancelled(id, counts, undefined, db, 'first');

    const held = (await getImport(id, db))!;
    expect(held.status).toBe('running');
    expect(held.locked_by).toBe('second');
    expect(held.counts.copied).toBe(0);

    await completeImport(id, counts, undefined, db, 'second');
    expect((await getImport(id, db))!.status).toBe('done');
  });

  test('a replaced attempt cannot swap the file list, and the holder can', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const id = await takenOver(db, new ObjectId(insertFolder(handle.db)));

    await expect(
      setImportFiles(id, [entry('C.dng')], undefined, db, 'first'),
    ).rejects.toBeInstanceOf(ImportTakenOver);
    expect((await getImportFiles(id, db)).map((file) => file.src)).toEqual([
      '/inbox/A.dng',
      '/inbox/B.dng',
    ]);

    await setImportFiles(id, [entry('C.dng')], undefined, db, 'second');
    expect((await getImportFiles(id, db)).map((file) => file.src)).toEqual(['/inbox/C.dng']);
    expect((await getImport(id, db))!.progress.total).toBe(1);
  });
});
