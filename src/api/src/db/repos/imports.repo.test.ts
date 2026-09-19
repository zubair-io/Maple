/**
 * Creating, reading and listing imports, and the per-file rows underneath them.
 *
 * The claim, the progress bookkeeping and the terminal transitions are in
 * `imports.claim.test.ts`; this file covers the half that writes the work out
 * and reads it back. Two things here are not type-checkable and are the reason
 * the file exists: that an import and its file rows land together or not at
 * all, and that a file list larger than one insert batch still comes back in
 * `idx` order with nothing dropped.
 */

import { describe, expect, test } from 'bun:test';
import { ObjectId } from '../object-id.ts';
import {
  assetExistsForHash,
  createImport,
  getImport,
  getImportFiles,
  listImports,
  setImportFiles,
} from './imports.repo.ts';
import {
  createTestDatabase,
  insertAsset,
  insertFolder,
  run,
  testSqliteDb,
} from '../sqlite/test-sqlite.test-helpers.ts';
import type { ImportFileEntry } from '../schema.ts';

function entry(overrides: Partial<ImportFileEntry> = {}): ImportFileEntry {
  return {
    src: '/inbox/IMG_1.dng',
    dest: '2026/04/IMG_1.dng',
    size: 4096,
    mtime: 1_700_000_000_000,
    kind: 'image',
    state: 'pending',
    error: null,
    ...overrides,
  };
}

/** `count` distinct entries, numbered so order is observable. */
function entries(count: number): ImportFileEntry[] {
  return Array.from({ length: count }, (_unused, i) =>
    entry({ src: `/inbox/IMG_${i}.dng`, dest: `2026/04/IMG_${i}.dng`, size: i }),
  );
}

describe('createImport', () => {
  test('writes a pending import and its file rows in position order', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const library = new ObjectId(insertFolder(handle.db));

    const created = await createImport(
      {
        source_root: '/inbox',
        library_id: library,
        library_root: '/libraries/main',
        files: [entry(), entry({ src: '/inbox/IMG_1.xmp', kind: 'sidecar' })],
      },
      () => new Date('2026-04-01T10:00:00.000Z'),
      db,
    );

    expect(created.status).toBe('pending');
    expect(created.progress).toEqual({ current: 0, total: 2 });
    expect(created.counts).toEqual({ copied: 0, skipped: 0, failed: 0 });
    expect(created.scan_pending).toBe(false);
    expect(created.cancel_requested).toBe(false);
    expect(created.locked_by).toBeNull();
    expect(created.lease_expires_at).toBeNull();
    expect(created.created_at).toBe('2026-04-01T10:00:00.000Z');
    expect(created.library_id.toHexString()).toBe(library.toHexString());
    // The inline `files` array is legacy-only and has no column; an absent key
    // is the honest answer, not an empty array.
    expect('files' in created).toBe(false);

    const stored = await getImport(created._id, db);
    expect(stored).toEqual(created);

    const files = await getImportFiles(created._id, db);
    expect(files.map((file) => file.idx)).toEqual([0, 1]);
    expect(files[1]!.kind).toBe('sidecar');
    expect(files[0]!.state).toBe('pending');
  });

  test('honours the Auto Import flag', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const library = new ObjectId(insertFolder(handle.db));

    const created = await createImport(
      {
        source_root: '/inbox',
        library_id: library,
        library_root: '/libraries/main',
        files: [],
        scan_pending: true,
      },
      undefined,
      db,
    );

    expect(created.scan_pending).toBe(true);
    expect(created.progress.total).toBe(0);
    expect(await getImportFiles(created._id, db)).toEqual([]);
  });

  test('writes a file list larger than one insert batch, in order and complete', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const library = new ObjectId(insertFolder(handle.db));

    const created = await createImport(
      {
        source_root: '/inbox',
        library_id: library,
        library_root: '/libraries/main',
        files: entries(2_500),
      },
      undefined,
      db,
    );

    const files = await getImportFiles(created._id, db);
    expect(files).toHaveLength(2_500);
    expect(files.map((file) => file.idx)).toEqual(files.map((_unused, i) => i));
    expect(files[2_499]!.src).toBe('/inbox/IMG_2499.dng');
  });

  test('leaves no import behind when a file row cannot be written', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const library = new ObjectId(insertFolder(handle.db));

    // `kind` is constrained to image/sidecar/movie, so this entry aborts the
    // transaction — and with it the import row, which the Mongo version had to
    // delete by hand afterwards and could fail to.
    const bogus = entry({ kind: 'document' as ImportFileEntry['kind'] });

    await expect(
      createImport(
        {
          source_root: '/inbox',
          library_id: library,
          library_root: '/libraries/main',
          files: [entry(), bogus],
        },
        undefined,
        db,
      ),
    ).rejects.toThrow(/CHECK constraint failed/);

    const rows = handle.db.query(`SELECT COUNT(*) AS n FROM imports`).get() as { n: number };
    const fileRows = handle.db.query(`SELECT COUNT(*) AS n FROM import_files`).get() as {
      n: number;
    };
    expect(rows.n).toBe(0);
    expect(fileRows.n).toBe(0);
  });

  test('refuses an import into a library that does not exist', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);

    await expect(
      createImport(
        {
          source_root: '/inbox',
          library_id: new ObjectId(),
          library_root: '/libraries/gone',
          files: [],
        },
        undefined,
        db,
      ),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/);
  });
});

describe('getImport and listImports', () => {
  test('getImport answers null for an id nothing ever minted', async () => {
    using handle = await createTestDatabase();
    expect(await getImport(new ObjectId(), testSqliteDb(handle.db))).toBeNull();
  });

  test('lists newest first, optionally scoped to one status', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const library = new ObjectId(insertFolder(handle.db));
    const base = {
      source_root: '/inbox',
      library_id: library,
      library_root: '/libraries/main',
      files: [],
    };

    const older = await createImport(base, () => new Date('2026-04-01T10:00:00.000Z'), db);
    const newer = await createImport(base, () => new Date('2026-04-02T10:00:00.000Z'), db);
    run(handle.db, `UPDATE imports SET status = 'done' WHERE id = ?`, older._id.toHexString());

    const all = await listImports({}, db);
    expect(all.map((row) => row._id.toHexString())).toEqual([
      newer._id.toHexString(),
      older._id.toHexString(),
    ]);
    expect((await listImports({ status: 'done' }, db)).map((row) => row._id.toHexString())).toEqual(
      [older._id.toHexString()],
    );
    expect(await listImports({ status: 'cancelled' }, db)).toEqual([]);
  });

  test('clamps the page size to between one and two hundred', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const library = new ObjectId(insertFolder(handle.db));
    const base = {
      source_root: '/inbox',
      library_id: library,
      library_root: '/libraries/main',
      files: [],
    };
    await createImport(base, undefined, db);
    await createImport(base, undefined, db);

    expect(await listImports({ limit: 1 }, db)).toHaveLength(1);
    expect(await listImports({ limit: 0 }, db)).toHaveLength(1);
    expect(await listImports({ limit: -5 }, db)).toHaveLength(1);
    expect(await listImports({ limit: 5_000 }, db)).toHaveLength(2);
  });
});

describe('setImportFiles', () => {
  test('replaces a prior scan wholesale and restarts the progress counter', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const library = new ObjectId(insertFolder(handle.db));

    const created = await createImport(
      {
        source_root: '/inbox',
        library_id: library,
        library_root: '/libraries/main',
        files: entries(3),
        scan_pending: true,
      },
      undefined,
      db,
    );
    run(
      handle.db,
      `UPDATE imports SET progress_current = 3, status = 'running' WHERE id = ?`,
      created._id.toHexString(),
    );

    await setImportFiles(
      created._id,
      [entry({ src: '/inbox/only.dng', dest: '2026/05/only.dng' })],
      60_000,
      () => new Date('2026-05-01T00:00:00.000Z'),
      db,
    );

    const after = (await getImport(created._id, db))!;
    expect(after.scan_pending).toBe(false);
    expect(after.progress).toEqual({ current: 0, total: 1 });
    expect(after.lease_expires_at).toBe('2026-05-01T00:01:00.000Z');
    expect(after.updated_at).toBe('2026-05-01T00:00:00.000Z');

    const files = await getImportFiles(created._id, db);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ idx: 0, src: '/inbox/only.dng' });
  });

  test('an empty scan result clears the rows and zeroes the total', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const library = new ObjectId(insertFolder(handle.db));

    const created = await createImport(
      {
        source_root: '/inbox',
        library_id: library,
        library_root: '/libraries/main',
        files: entries(2),
        scan_pending: true,
      },
      undefined,
      db,
    );
    await setImportFiles(created._id, [], 60_000, undefined, db);

    expect((await getImport(created._id, db))!.progress.total).toBe(0);
    expect(await getImportFiles(created._id, db)).toEqual([]);
  });

  test('deleting an import takes its file rows with it', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const library = new ObjectId(insertFolder(handle.db));

    const created = await createImport(
      {
        source_root: '/inbox',
        library_id: library,
        library_root: '/libraries/main',
        files: entries(4),
      },
      undefined,
      db,
    );
    run(handle.db, `DELETE FROM imports WHERE id = ?`, created._id.toHexString());

    expect(await getImportFiles(created._id, db)).toEqual([]);
  });
});

describe('assetExistsForHash', () => {
  test('answers on either dedup key, and only for a real match', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const byMapleId = insertAsset(handle.db);
    const bySha = insertAsset(handle.db);
    run(
      handle.db,
      `UPDATE assets SET maple_id = 'maple-1', sha1_head = 'sha-1' WHERE id = ?`,
      byMapleId,
    );
    run(handle.db, `UPDATE assets SET sha1_head = 'sha-2' WHERE id = ?`, bySha);

    expect(await assetExistsForHash('maple-1', 'no-such-sha', db)).toBe(true);
    expect(await assetExistsForHash('no-such-maple-id', 'sha-2', db)).toBe(true);
    expect(await assetExistsForHash('no-such-maple-id', 'no-such-sha', db)).toBe(false);
  });

  test('an empty maple id never matches a skeleton row that has none', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const skeleton = insertAsset(handle.db);

    // A skeleton row carries no dedup key at all. The empty string is not an
    // alternative spelling of that — the schema's CHECK refuses it outright —
    // so the row this probe must not match is the NULL one.
    run(handle.db, `UPDATE assets SET maple_id = NULL WHERE id = ?`, skeleton);

    expect(await assetExistsForHash('', 'no-such-sha', db)).toBe(false);
  });
});
