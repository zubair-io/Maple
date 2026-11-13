/**
 * An import is written only by the attempt that holds it. Once a later
 * delivery has claimed the row, the earlier attempt's progress, publish
 * markers, file list and terminal writes change nothing.
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
  clearImportFilePublishing,
  getImportPublishingDests,
  markImportFilePublishing,
} from './imports.publishing.ts';
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

  test('a replaced attempt cannot mark or unmark a file for publishing, and the holder can', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const id = await takenOver(db, new ObjectId(insertFolder(handle.db)));
    const landing = { index: 1, destRel: '2026/04/B-1.dng' };

    await expect(
      markImportFilePublishing(id, { ...landing, holder: 'first' }, db),
    ).rejects.toBeInstanceOf(ImportTakenOver);
    expect([...(await getImportPublishingDests(id, db))]).toEqual([]);

    await markImportFilePublishing(id, { ...landing, holder: 'second' }, db);
    expect([...(await getImportPublishingDests(id, db))]).toEqual([[1, '2026/04/B-1.dng']]);
    expect((await getImportFiles(id, db))[1]).toMatchObject({
      state: 'pending',
      dest: '2026/04/B.dng',
    });

    await expect(
      clearImportFilePublishing(id, { index: 1, holder: 'first' }, db),
    ).rejects.toBeInstanceOf(ImportTakenOver);
    expect((await getImportPublishingDests(id, db)).size).toBe(1);

    await clearImportFilePublishing(id, { index: 1, holder: 'second' }, db);
    expect((await getImportPublishingDests(id, db)).size).toBe(0);
  });

  test('the holder hears about a marker for a file row that is not there', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const id = await takenOver(db, new ObjectId(insertFolder(handle.db)));

    await expect(
      markImportFilePublishing(id, { index: 7, destRel: '2026/04/C.dng', holder: 'second' }, db),
    ).rejects.toThrow('no import_files row');
  });

  test('a file outcome keeps the marker, and moves the sidecars that follow a renamed image with it or not at all', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const id = await takenOver(db, new ObjectId(insertFolder(handle.db)));
    const sidecarDests = [{ index: 1, destRel: '2026/04/landed-0.xmp' }];
    await markImportFilePublishing(
      id,
      { index: 0, destRel: '2026/04/landed-0.dng', holder: 'second' },
      db,
    );

    await expect(
      updateImportProgress(id, { ...copied(0, 'first'), sidecarDests }, undefined, db),
    ).rejects.toBeInstanceOf(ImportTakenOver);
    expect((await getImportFiles(id, db)).map((file) => file.dest)).toEqual([
      '2026/04/A.dng',
      '2026/04/B.dng',
    ]);

    await updateImportProgress(id, { ...copied(0, 'second'), sidecarDests }, undefined, db);
    expect((await getImportFiles(id, db)).map((file) => [file.state, file.dest])).toEqual([
      ['copied', '2026/04/landed-0.dng'],
      ['pending', '2026/04/landed-0.xmp'],
    ]);
    expect([...(await getImportPublishingDests(id, db))]).toEqual([[0, '2026/04/landed-0.dng']]);
  });

  test('a file outcome sets or clears the marker in the same write, and leaves it alone when told nothing', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const id = await takenOver(db, new ObjectId(insertFolder(handle.db)));
    const markers = async () => [...(await getImportPublishingDests(id, db))];
    await markImportFilePublishing(
      id,
      { index: 0, destRel: '2026/04/A-1.dng', holder: 'second' },
      db,
    );

    await updateImportProgress(id, copied(0, 'second'), undefined, db);
    expect(await markers()).toEqual([[0, '2026/04/A-1.dng']]);

    await expect(
      updateImportProgress(id, { ...copied(0, 'first'), publishingDest: null }, undefined, db),
    ).rejects.toBeInstanceOf(ImportTakenOver);
    expect(await markers()).toEqual([[0, '2026/04/A-1.dng']]);

    const failed = { ...copied(0, 'second'), state: 'failed' as const, error: 'EIO' };
    await updateImportProgress(id, { ...failed, publishingDest: '2026/04/A.dng' }, undefined, db);
    expect(await markers()).toEqual([[0, '2026/04/A.dng']]);

    await updateImportProgress(id, { ...failed, publishingDest: null }, undefined, db);
    expect(await markers()).toEqual([]);
  });
});
