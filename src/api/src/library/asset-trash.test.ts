/**
 * Integration tests for `trashAssetById` / `restoreAssetById` (#2630),
 * covering two rounds of the #2695 review:
 *
 *   1. The plain "first non-deleted" location pick is unsafe when an
 *      earlier entry is missing-tagged but not deleted — it targets the
 *      stale/offline copy instead of the live one (same bug class fixed
 *      for `relocateAsset` via `activeFileInfo`).
 *   2. A follow-up round caught that the FIRST fix was incomplete: the
 *      selector (`activeFileInfo`) picked the right entry, but the
 *      no-`opts.entry` derivation of `libraryId`/`assetFolderId` still came
 *      from the asset's globally-primary library — a SEPARATE computation
 *      that can disagree with `activeFileInfo` when no entry is
 *      simultaneously live AND not-missing-tagged. The fix
 *      (`resolveEntrySpec`) collapses both onto ONE entry-resolution call so
 *      the library used for the file move, the DB repoint and the
 *      folder-root lookup can never disagree with the entry actually acted
 *      on again.
 *
 * The tests below construct that exact divergence with TWO distinct
 * libraries on TWO distinct roots, and assert the file physically lands
 * under the SECONDARY library's root — and that nothing at all appears
 * under the other one — rather than merely that some downstream event
 * references the right id, which wouldn't have caught the incompleteness.
 *
 * Real temp directories + real files, and one real SQLite database per test
 * (#3787) installed as the process-wide handle so the module's own
 * repository calls reach it. No external service, so nothing to skip on.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { ObjectId } from '../db/object-id.ts';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createLiveTestDatabase,
  insertAsset,
  insertFolder,
  insertLocation,
  run,
} from '../db/sqlite/test-sqlite.test-helpers.ts';
import { invalidateLibraryRoots } from '../indexer/libraries.cache.ts';
import { trashAssetById, restoreAssetById } from './asset-trash.ts';

/** A residual watcher tag: the entry is not deleted, but its file has not
 * been seen lately. What makes the naive "first non-deleted" pick wrong. */
const MISSING_SINCE = '2026-02-01T00:00:00.000Z';

let root: string;
/** A SECOND library root, for the cross-library tests. Registered in
 * `folders` (the schema's foreign key requires it) but deliberately left
 * empty on disk: a regression that derived the library from the retired
 * entry would move bytes under here, and the tests assert it stays empty. */
let otherRoot: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'asset-trash-'));
  otherRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'asset-trash-other-'));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(otherRoot, { recursive: true, force: true });
});

async function write(rel: string, content: string): Promise<string> {
  const abs = path.join(root, ...rel.split('/'));
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
  return abs;
}
async function exists(rel: string): Promise<boolean> {
  try {
    await fs.stat(path.join(root, ...rel.split('/')));
    return true;
  } catch {
    return false;
  }
}
async function read(rel: string): Promise<string> {
  return fs.readFile(path.join(root, ...rel.split('/')), 'utf8');
}

/** Register one library root and return its id, dropping the roots cache so
 * the next read picks the new row up. */
function registerLibrary(db: Database, dir: string, slug: string): ObjectId {
  const id = insertFolder(db, { path: dir, slug });
  invalidateLibraryRoots();
  return new ObjectId(id);
}

interface LocationEntry {
  libraryId: string;
  path: string;
  filename: string;
  deletedAt?: string | null;
  missingSince?: string | null;
}

/** One asset with the given locations, in array order. */
function seedAsset(
  db: Database,
  entries: readonly LocationEntry[],
  overrides: { deletedAt?: string; originalPath?: string; deletedReason?: string } = {},
): ObjectId {
  const id = insertAsset(db, { deletedAt: overrides.deletedAt ?? null });
  entries.forEach((entry, ordinal) => insertLocation(db, { assetId: id, ordinal, ...entry }));
  if (overrides.originalPath !== undefined) {
    run(db, `UPDATE assets SET original_path = ? WHERE id = ?`, overrides.originalPath, id);
  }
  if (overrides.deletedReason !== undefined) {
    run(db, `UPDATE assets SET deleted_reason = ? WHERE id = ?`, overrides.deletedReason, id);
  }
  return new ObjectId(id);
}

/** The `asset_locations` rows behind what used to be `doc.fileinfo[]`, in
 * the same array order. */
interface LocationRow {
  library_id: string;
  path: string;
  filename: string;
  deleted_at: string | null;
  missing_since: string | null;
}

function locations(db: Database, id: ObjectId): LocationRow[] {
  return db
    .query(
      `SELECT library_id, path, filename, deleted_at, missing_since
         FROM asset_locations WHERE asset_id = ? ORDER BY ordinal`,
    )
    .all(id.toHexString()) as LocationRow[];
}

function assetRow(
  db: Database,
  id: ObjectId,
): { deleted_at: string | null; original_path: string | null } {
  return db
    .query(`SELECT deleted_at, original_path FROM assets WHERE id = ?`)
    .get(id.toHexString()) as { deleted_at: string | null; original_path: string | null };
}

describe('trashAssetById / restoreAssetById — multi-location selector', () => {
  test('trash: targets the live entry, not a missing-tagged one (same library)', async () => {
    using live = await createLiveTestDatabase();
    const libraryId = registerLibrary(live.db, root, 'asset-trash-test');
    await write('live/IMG_9.dng', 'pixels');
    // Same shape as relocate-asset.test.ts's regression fixture: the FIRST
    // entry is missing-tagged (stale/offline location), the SECOND is live.
    // The plain "first non-deleted" pick would target the stale one.
    const id = seedAsset(live.db, [
      {
        libraryId: libraryId.toHexString(),
        path: 'stale',
        filename: 'IMG_9.dng',
        missingSince: MISSING_SINCE,
      },
      { libraryId: libraryId.toHexString(), path: 'live', filename: 'IMG_9.dng' },
    ]);

    const outcome = await trashAssetById(id);
    expect(outcome.kind).toBe('ok');

    // The LIVE copy moved to trash; the stale-tagged entry's (nonexistent)
    // file was never touched.
    expect(await exists('live/IMG_9.dng')).toBe(false);
    expect(await read('.maple/trash/live/IMG_9.dng')).toBe('pixels');

    expect(assetRow(live.db, id).deleted_at).not.toBeNull();
    const rows = locations(live.db, id);
    expect(rows.find((row) => row.path === 'stale')).toBeTruthy(); // untouched
    expect(rows.find((row) => row.path.startsWith('.maple/trash'))?.path).toBe('.maple/trash/live');
  });

  test('restore: targets the trashed (formerly-live) entry, not a missing-tagged one (same library)', async () => {
    using live = await createLiveTestDatabase();
    const libraryId = registerLibrary(live.db, root, 'asset-trash-test');
    await write('live/IMG_9.dng', 'pixels');
    const id = seedAsset(live.db, [
      {
        libraryId: libraryId.toHexString(),
        path: 'stale',
        filename: 'IMG_9.dng',
        missingSince: MISSING_SINCE,
      },
      { libraryId: libraryId.toHexString(), path: 'live', filename: 'IMG_9.dng' },
    ]);

    const trashOutcome = await trashAssetById(id);
    expect(trashOutcome.kind).toBe('ok');

    // The trashed entry is the only one that is both live and untagged now
    // (trash rewrote it and cleared its watcher tags), so restore must pick
    // it rather than falling back to the naive "first non-deleted" pick,
    // which would target the still-stale-tagged `stale` entry.
    const restoreOutcome = await restoreAssetById(id);
    expect(restoreOutcome.kind).toBe('ok');

    expect(await read('live/IMG_9.dng')).toBe('pixels');
    expect(assetRow(live.db, id).deleted_at).toBeNull();
    const rows = locations(live.db, id);
    expect(rows.find((row) => row.path === 'stale')).toBeTruthy(); // still untouched
    expect(rows.find((row) => row.path === 'live')).toBeTruthy();
  });
});

describe('trashAssetById / restoreAssetById — cross-library derivation (#2695 second review round)', () => {
  // The asset's globally-primary location and this module's own selector can
  // disagree specifically when NO entry is simultaneously live-and-not-
  // missing: the primary falls back to the literal first entry, while
  // `activeFileInfo` falls back to the first merely-live one. Putting the two
  // entries in DIFFERENT libraries, on different roots, makes a wrong
  // derivation observable as bytes landing under the wrong root rather than
  // as something that happens to still work by coincidence.
  //
  // `otherRoot` is registered (the `asset_locations.library_id` foreign key
  // requires a real `folders` row) but is never written to by these tests, so
  // every assertion that it is still empty is an assertion that the retired
  // entry's library was never used to resolve anything.

  test('trash: the file lands under the SECONDARY (active) library root, not the primary', async () => {
    using live = await createLiveTestDatabase();
    const libraryId = registerLibrary(live.db, root, 'asset-trash-test');
    const staleLibraryId = registerLibrary(live.db, otherRoot, 'asset-trash-stale');
    await write('sub/IMG.dng', 'pixels');
    const id = seedAsset(live.db, [
      // The retired entry in a DIFFERENT library, on its own root. A
      // derivation that regressed to "the asset's primary library" would
      // pick this one.
      {
        libraryId: staleLibraryId.toHexString(),
        path: 'old',
        filename: 'IMG.dng',
        deletedAt: '2020-01-01T00:00:00Z',
      },
      // The ACTUAL active entry, live but missing-tagged — `activeFileInfo`'s
      // fallback (first merely-live entry) correctly picks this one.
      {
        libraryId: libraryId.toHexString(),
        path: 'sub',
        filename: 'IMG.dng',
        missingSince: MISSING_SINCE,
      },
    ]);

    const outcome = await trashAssetById(id);
    expect(outcome.kind).toBe('ok');
    if (outcome.kind === 'ok') {
      expect(outcome.folderId.equals(libraryId)).toBe(true);
      expect(outcome.folderId.equals(staleLibraryId)).toBe(false);
    }

    // The file physically moved under `root` — the active entry's library
    // root — not merely that some event/return value claims so.
    expect(await exists('sub/IMG.dng')).toBe(false);
    expect(await read('.maple/trash/sub/IMG.dng')).toBe('pixels');
    expect(await fs.readdir(otherRoot)).toEqual([]);

    const rows = locations(live.db, id);
    expect(rows.find((row) => row.library_id === staleLibraryId.toHexString())?.path).toBe('old');
    expect(rows.find((row) => row.library_id === libraryId.toHexString())?.path).toBe(
      '.maple/trash/sub',
    );
  });

  test('restore: the file lands back under the SECONDARY (active) library root, not the primary', async () => {
    using live = await createLiveTestDatabase();
    const libraryId = registerLibrary(live.db, root, 'asset-trash-test');
    const staleLibraryId = registerLibrary(live.db, otherRoot, 'asset-trash-stale');
    await write('.maple/trash/sub/IMG.dng', 'pixels');
    const originalAbsPath = path.join(root, 'sub', 'IMG.dng');
    const id = seedAsset(
      live.db,
      [
        {
          libraryId: staleLibraryId.toHexString(),
          path: 'old',
          filename: 'IMG.dng',
          deletedAt: '2020-01-01T00:00:00Z',
        },
        // The already-trashed entry — seeded directly with a residual
        // `missing_since` (plausible: a watcher `removed` event could have
        // tagged it before it was trashed) so NEITHER entry is
        // simultaneously live-and-not-missing, forcing both selectors into
        // their fallback branches.
        {
          libraryId: libraryId.toHexString(),
          path: '.maple/trash/sub',
          filename: 'IMG.dng',
          missingSince: MISSING_SINCE,
        },
      ],
      { deletedAt: '2026-01-01T00:00:00Z', originalPath: originalAbsPath },
    );

    const outcome = await restoreAssetById(id);
    expect(outcome.kind).toBe('ok');
    if (outcome.kind === 'ok') {
      expect(outcome.folderId.equals(libraryId)).toBe(true);
      expect(outcome.folderId.equals(staleLibraryId)).toBe(false);
    }

    // The file physically landed back under `root`.
    expect(await exists('.maple/trash/sub/IMG.dng')).toBe(false);
    expect(await read('sub/IMG.dng')).toBe('pixels');
    expect(await fs.readdir(otherRoot)).toEqual([]);

    const rows = locations(live.db, id);
    expect(rows.find((row) => row.library_id === staleLibraryId.toHexString())?.path).toBe('old');
    expect(rows.find((row) => row.library_id === libraryId.toHexString())?.path).toBe('sub');
  });
});

describe('reaped rows (#2977)', () => {
  test('restore of a reaped asset fails cleanly without touching disk', async () => {
    using live = await createLiveTestDatabase();
    const libraryId = registerLibrary(live.db, root, 'asset-trash-test');
    // A reaped row: soft-deleted by the missing-reaper, no trashed copy.
    // The file quietly RETURNED to the stored path — restore must still
    // refuse (revive is discover's job) and must not move/unlink anything.
    await write('sub/back.dng', 'returned-bytes');
    const id = seedAsset(
      live.db,
      [
        {
          libraryId: libraryId.toHexString(),
          path: 'sub',
          filename: 'back.dng',
          missingSince: '2026-08-01T00:00:00.000Z',
        },
      ],
      { deletedAt: '2026-08-10T00:00:00.000Z', deletedReason: 'reaped' },
    );

    const outcome = await restoreAssetById(id);
    expect(outcome.kind).toBe('error');
    expect((outcome as { error?: string }).error).toContain('removed from disk');
    // Row untouched, file untouched.
    expect(assetRow(live.db, id).deleted_at).toBe('2026-08-10T00:00:00.000Z');
    expect(await read('sub/back.dng')).toBe('returned-bytes');
  });
});
