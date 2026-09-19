/**
 * `imports/retry.ts` — the two behaviours the repository's own suites leave
 * uncovered.
 *
 * `retryImport` moved to `db/sqlite/repos/imports.retry.ts` at the cutover
 * (#3787), and `imports.retry.test.ts` beside it covers the retryable guard,
 * the split between re-scanning and per-file recovery, and the refusal to
 * resurrect a file whose destination could never be validated. Re-asserting any
 * of that here would be a second copy to keep in step, so what survives is only
 * what that suite does not reach:
 *
 *  - **How deep a destination may be.** `destIsSafe` validates every directory
 *    segment rather than counting them, because a nearby-asset match copies an
 *    existing folder path of arbitrary depth. The repository suite only
 *    exercises the shallow shapes — a three-segment default layout and a bare
 *    filename — so neither half of that rule is pinned there: that extra depth
 *    is fine on its own, and that a hidden directory is not fine at any depth.
 *  - **What a worker actually sees after the re-scan branch.** The repository
 *    suite asserts the import comes back `pending` with `scan_pending` set; the
 *    behaviour that matters to the worker is that the *claim* carries the flag,
 *    since a claim without it copies an empty file list instead of re-walking
 *    the source (#800).
 */

import { describe, expect, test } from 'bun:test';
import { ObjectId } from 'mongodb';
import { claimImport, createImport, failImport, getImport, getImportFiles } from './repo.ts';
import { retryImport } from './retry.ts';
import { file, seedLibrary } from './imports-test-db.fixtures.ts';
import { createTestDatabase, testSqliteDb } from '../db/sqlite/test-sqlite.test-helpers.ts';
import type { ImportFileEntry } from '../db/schema.ts';

/** A file that failed on the first run, destined for `dest`. */
function failedAt(dest: string): ImportFileEntry {
  const src = dest.slice(dest.lastIndexOf('/') + 1);
  return { ...file(src), dest, state: 'failed', error: 'transient' };
}

describe('retryImport — how deep a recoverable destination may be', () => {
  test('re-queues every failure whose segments are all safe, at any depth', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const lib = seedLibrary(handle.db);

    const created = await createImport(
      {
        source_root: '/srv/in',
        library_id: lib.id,
        library_root: lib.root,
        files: [
          // The three-segment default layout.
          failedAt('2024/03/ok.dng'),
          // Deeper than the default, which a misc/shot-folder default or a
          // nearby-asset match legitimately produces — every segment is safe,
          // so the whole destination is.
          failedAt('2024/03/sub/nested.dng'),
          // A hidden directory buried in an otherwise-fine path. Depth does not
          // exempt a segment from validation, so this one can never be copied.
          failedAt('2024/03/.hidden/hidden.dng'),
        ],
      },
      undefined,
      db,
    );
    await failImport(created._id, 'three files failed', undefined, db);

    expect(await retryImport(created._id, undefined, db)).toBe(true);

    const files = await getImportFiles(created._id, db);
    expect(files.map((entry) => entry.state)).toEqual(['pending', 'pending', 'failed']);
    // The recomputed tally still reports the one file that stays broken.
    expect((await getImport(created._id, db))!.counts.failed).toBe(1);
  });
});

describe('retryImport — what the next worker claims', () => {
  test('a re-scanned import is claimed with scan_pending set', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const lib = seedLibrary(handle.db);

    // A scan-level / Auto Import failure: the deferred scan rejected an unsafe
    // temp name and bailed before writing any file row.
    const fileless = await createImport(
      {
        source_root: '/srv/photos/Unsorted',
        library_id: lib.id,
        library_root: lib.root,
        files: [],
        scan_pending: true,
      },
      undefined,
      db,
    );
    await failImport(fileless._id, 'unsafe filename: ".LrTmp-abc.mp4"', undefined, db);

    expect(await retryImport(fileless._id, undefined, db)).toBe(true);

    const claim = await claimImport('w-rescan', 60_000, undefined, db);
    expect(claim!._id.toHexString()).toBe(fileless._id.toHexString());
    // Without the flag on the claim the worker copies the empty file list
    // instead of re-walking `source_root`.
    expect(claim!.scan_pending).toBe(true);
    expect(claim!.library_root).toBe(lib.root);
  });
});
