/**
 * Retrying an import.
 *
 * Three behaviours carry the weight: the guard that decides which imports are
 * retryable at all, the split between re-scanning and per-file recovery, and
 * the refusal to resurrect a file whose destination could never be validated.
 * The last one is a safety property — a retry that copied to an unvalidated
 * path would write outside the library layout — so it is checked from both
 * sides.
 */

import { describe, expect, test } from 'bun:test';
import { ObjectId } from 'mongodb';
import { createImport, getImport, getImportFiles } from './imports.repo.ts';
import { retryImport } from './imports.retry.ts';
import {
  createTestDatabase,
  insertFolder,
  run,
  testSqliteDb,
} from '../test-sqlite.test-helpers.ts';
import type { ImportFileEntry } from '../../schema.ts';
import type { SqliteDb } from './db-handle.ts';

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

async function seedImport(
  db: SqliteDb,
  library: ObjectId,
  files: ImportFileEntry[],
): Promise<ObjectId> {
  const created = await createImport(
    {
      source_root: '/inbox',
      library_id: library,
      library_root: '/libraries/main',
      files,
    },
    () => new Date('2026-04-01T10:00:00.000Z'),
    db,
  );
  return created._id;
}

/** Puts an import into a terminal state with the given tally. */
function finish(
  handleDb: Parameters<typeof run>[0],
  id: ObjectId,
  status: 'failed' | 'done' | 'running',
  counts: { copied: number; skipped: number; failed: number },
  error: string | null = null,
): void {
  run(
    handleDb,
    `UPDATE imports SET status = ?, count_copied = ?, count_skipped = ?, count_failed = ?,
        error = ?, locked_by = 'worker-1', lease_expires_at = '2099-01-01T00:00:00.000Z',
        cancel_requested = 1
      WHERE id = ?`,
    status,
    counts.copied,
    counts.skipped,
    counts.failed,
    error,
    id.toHexString(),
  );
}

describe('retryImport — the guard', () => {
  test('refuses an import that is not terminal-with-failures, and an unknown id', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const library = new ObjectId(insertFolder(handle.db));

    const pending = await seedImport(db, library, [entry()]);
    expect(await retryImport(pending, undefined, db)).toBe(false);

    const clean = await seedImport(db, library, [entry({ state: 'copied' })]);
    finish(handle.db, clean, 'done', { copied: 1, skipped: 0, failed: 0 });
    expect(await retryImport(clean, undefined, db)).toBe(false);

    expect(await retryImport(new ObjectId(), undefined, db)).toBe(false);
  });

  test('accepts a done import that copied some files and failed others', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const library = new ObjectId(insertFolder(handle.db));

    const id = await seedImport(db, library, [
      entry({ state: 'copied' }),
      entry({ src: '/inbox/IMG_2.dng', dest: '2026/04/IMG_2.dng', state: 'failed', error: 'EIO' }),
    ]);
    finish(handle.db, id, 'done', { copied: 1, skipped: 0, failed: 1 });

    expect(await retryImport(id, () => new Date('2026-04-05T00:00:00.000Z'), db)).toBe(true);

    const after = (await getImport(id, db))!;
    expect(after.status).toBe('pending');
    expect(after.counts).toEqual({ copied: 1, skipped: 0, failed: 0 });
    expect(after.error).toBeNull();
    expect(after.locked_by).toBeNull();
    expect(after.lease_expires_at).toBeNull();
    expect(after.cancel_requested).toBe(false);
    expect(after.scan_pending).toBe(false);
    expect(after.updated_at).toBe('2026-04-05T00:00:00.000Z');

    const files = await getImportFiles(id, db);
    // The copied file is left alone; only the failure is re-queued.
    expect(files.map((file) => file.state)).toEqual(['copied', 'pending']);
    expect(files[1]!.error).toBeNull();
  });
});

describe('retryImport — the two recovery shapes', () => {
  test('a failed import with no file rows is re-queued for a fresh scan', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const library = new ObjectId(insertFolder(handle.db));

    const id = await seedImport(db, library, []);
    finish(handle.db, id, 'failed', { copied: 0, skipped: 0, failed: 0 }, 'scan threw');

    expect(await retryImport(id, undefined, db)).toBe(true);

    const after = (await getImport(id, db))!;
    expect(after.status).toBe('pending');
    expect(after.scan_pending).toBe(true);
    expect(after.error).toBeNull();
  });

  test('an import with file rows never re-scans, so copied states survive', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const library = new ObjectId(insertFolder(handle.db));

    const id = await seedImport(db, library, [
      entry({ state: 'copied' }),
      entry({ src: '/inbox/IMG_2.dng', dest: '2026/04/IMG_2.dng', state: 'failed', error: 'EIO' }),
      entry({ src: '/inbox/IMG_3.dng', dest: '2026/04/IMG_3.dng', state: 'skipped_duplicate' }),
    ]);
    finish(handle.db, id, 'failed', { copied: 1, skipped: 1, failed: 1 }, 'one file failed');

    expect(await retryImport(id, undefined, db)).toBe(true);

    const after = (await getImport(id, db))!;
    expect(after.scan_pending).toBe(false);
    expect(after.counts).toEqual({ copied: 1, skipped: 1, failed: 0 });
    expect((await getImportFiles(id, db)).map((file) => file.state)).toEqual([
      'copied',
      'pending',
      'skipped_duplicate',
    ]);
  });
});

describe('retryImport — unrecoverable destinations', () => {
  test('leaves a file whose destination could never be validated failed', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const library = new ObjectId(insertFolder(handle.db));

    const id = await seedImport(db, library, [
      entry({ dest: '2026/04/IMG_1.dng', state: 'failed', error: 'EIO' }),
      entry({
        src: '/inbox/bad.dng',
        // A backslash filename can never pass `destRelPath`, so a re-run must
        // not copy to it.
        dest: '2026/04/bad\\name.dng',
        state: 'failed',
        error: 'unsafe dest',
      }),
    ]);
    finish(handle.db, id, 'failed', { copied: 0, skipped: 0, failed: 2 });

    expect(await retryImport(id, undefined, db)).toBe(true);

    // The recomputed failure count reports the file that stays broken.
    expect((await getImport(id, db))!.counts.failed).toBe(1);
    expect((await getImportFiles(id, db)).map((file) => file.state)).toEqual(['pending', 'failed']);
  });

  test('refuses outright when every failure is unrecoverable', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const library = new ObjectId(insertFolder(handle.db));

    const id = await seedImport(db, library, [
      // No directory segment at all: `destIsSafe` rejects it.
      entry({ dest: 'loose.dng', state: 'failed', error: 'unsafe dest' }),
    ]);
    finish(handle.db, id, 'failed', { copied: 0, skipped: 0, failed: 1 }, 'all unsafe');

    expect(await retryImport(id, undefined, db)).toBe(false);

    const after = (await getImport(id, db))!;
    expect(after.status).toBe('failed');
    expect(after.error).toBe('all unsafe');
    expect((await getImportFiles(id, db))[0]!.state).toBe('failed');
  });

  test('a done import whose only failure is unrecoverable is not retryable either', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const library = new ObjectId(insertFolder(handle.db));

    const id = await seedImport(db, library, [
      entry({ state: 'copied' }),
      entry({ src: '/inbox/x.dng', dest: 'x.dng', state: 'failed', error: 'unsafe dest' }),
    ]);
    finish(handle.db, id, 'done', { copied: 1, skipped: 0, failed: 1 });

    expect(await retryImport(id, undefined, db)).toBe(false);
    expect((await getImport(id, db))!.status).toBe('done');
  });
});
