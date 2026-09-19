/**
 * Integration tests for recursive folder trash + restore (#2630).
 *
 * Real temp directories + real files (no mocks for the filesystem or sidecar
 * layer), and one real SQLite database per test (#3787), installed as the
 * process-wide handle so the orchestrator's own repository calls reach it.
 * Nothing external, so nothing to skip on.
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
import { __resetChangeFolderPathCacheForTests } from '../db/sqlite/repos/changes.repo.ts';
import { listTrashedBefore } from '../db/sqlite/repos/assets.sweeps.ts';
import { invalidateLibraryRoots } from '../indexer/libraries.cache.ts';
import { trashFolderRecursive, restoreFolderRecursive } from './folder-trash.ts';

let root: string;
/** A SECOND library root for the multi-location test. Registered (the
 * `asset_locations.library_id` foreign key wants a real `folders` row) and
 * deliberately never written to, so "still empty" is an assertion that this
 * library was never used to resolve anything. */
let otherRoot: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'folder-trash-'));
  otherRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'folder-trash-other-'));
  // The change feed caches each library's root path per process, keyed on the
  // library id. Every test mints its own id so a stale entry cannot be read,
  // but dropping it keeps that independent of how ids are minted.
  __resetChangeFolderPathCacheForTests();
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

/** One live asset located at `relDir`/`filename` under `libraryId`. */
function seedAsset(db: Database, libraryId: ObjectId, relDir: string, filename: string): ObjectId {
  const id = insertAsset(db);
  insertLocation(db, {
    assetId: id,
    libraryId: libraryId.toHexString(),
    path: relDir,
    filename,
  });
  return new ObjectId(id);
}

interface LocationRow {
  library_id: string;
  path: string;
  filename: string;
}

function locations(db: Database, id: ObjectId): LocationRow[] {
  return db
    .query(
      `SELECT library_id, path, filename FROM asset_locations
        WHERE asset_id = ? ORDER BY ordinal`,
    )
    .all(id.toHexString()) as LocationRow[];
}

function assetRow(
  db: Database,
  id: ObjectId,
): { deleted_at: string | null; original_path: string | null } | null {
  return db
    .query(`SELECT deleted_at, original_path FROM assets WHERE id = ?`)
    .get(id.toHexString()) as { deleted_at: string | null; original_path: string | null } | null;
}

describe('trashFolderRecursive / restoreFolderRecursive — nested-tree round trip', () => {
  test('trash + restore a >=3-level nested tree, sidecars intact, siblings untouched', async () => {
    using live = await createLiveTestDatabase();
    const folderId = registerLibrary(live.db, root, 'folder-trash-test');

    // Nested tree under photos/2024/vacation (3 levels deep at its deepest:
    // vacation/, vacation/beach/), each RAW paired with an XMP sidecar.
    await write('photos/2024/vacation/IMG_1.dng', 'pixels-1');
    await write('photos/2024/vacation/IMG_1.xmp', 'edits-1');
    await write('photos/2024/vacation/beach/IMG_2.dng', 'pixels-2');
    await write('photos/2024/vacation/beach/IMG_2.xmp', 'edits-2');
    // A sibling OUTSIDE the trashed subtree — must survive untouched.
    await write('photos/2024/other.dng', 'pixels-other');

    const id1 = seedAsset(live.db, folderId, 'photos/2024/vacation', 'IMG_1.dng');
    const id2 = seedAsset(live.db, folderId, 'photos/2024/vacation/beach', 'IMG_2.dng');
    const idOther = seedAsset(live.db, folderId, 'photos/2024', 'other.dng');

    const trashSummary = await trashFolderRecursive(folderId, root, 'photos/2024/vacation');
    expect(trashSummary.total).toBe(2);
    expect(trashSummary.succeeded).toBe(2);
    expect(trashSummary.failed).toBe(0);

    // Both nested assets moved into .maple/trash/<rel>, sidecars followed.
    expect(await exists('photos/2024/vacation/IMG_1.dng')).toBe(false);
    expect(await exists('photos/2024/vacation/IMG_1.xmp')).toBe(false);
    expect(await read('.maple/trash/photos/2024/vacation/IMG_1.dng')).toBe('pixels-1');
    expect(await read('.maple/trash/photos/2024/vacation/IMG_1.xmp')).toBe('edits-1');
    expect(await exists('photos/2024/vacation/beach/IMG_2.dng')).toBe(false);
    expect(await read('.maple/trash/photos/2024/vacation/beach/IMG_2.dng')).toBe('pixels-2');
    expect(await read('.maple/trash/photos/2024/vacation/beach/IMG_2.xmp')).toBe('edits-2');

    // Sibling untouched.
    expect(await read('photos/2024/other.dng')).toBe('pixels-other');
    expect(assetRow(live.db, idOther)?.deleted_at).toBeNull();

    // Now-empty source subtree (vacation/, vacation/beach/) was cleaned up
    // best-effort; photos/2024 survives (still holds other.dng).
    expect(await exists('photos/2024/vacation')).toBe(false);
    expect(await exists('photos/2024')).toBe(true);

    // DB: both trashed assets tombstoned + repointed, original_path recorded.
    const row1 = assetRow(live.db, id1);
    expect(row1?.deleted_at).not.toBeNull();
    expect(row1?.original_path).toBe(path.join(root, 'photos/2024/vacation/IMG_1.dng'));
    expect(locations(live.db, id1)[0]!.path).toBe('.maple/trash/photos/2024/vacation');
    expect(assetRow(live.db, id2)?.deleted_at).not.toBeNull();
    expect(locations(live.db, id2)[0]!.path).toBe('.maple/trash/photos/2024/vacation/beach');

    // Restore reverses it, reconstructing the tree at the original paths.
    const restoreSummary = await restoreFolderRecursive(folderId, root, 'photos/2024/vacation');
    expect(restoreSummary.total).toBe(2);
    expect(restoreSummary.succeeded).toBe(2);
    expect(restoreSummary.failed).toBe(0);

    expect(await read('photos/2024/vacation/IMG_1.dng')).toBe('pixels-1');
    expect(await read('photos/2024/vacation/IMG_1.xmp')).toBe('edits-1');
    expect(await read('photos/2024/vacation/beach/IMG_2.dng')).toBe('pixels-2');
    expect(await read('photos/2024/vacation/beach/IMG_2.xmp')).toBe('edits-2');
    expect(await exists('.maple/trash/photos/2024/vacation/IMG_1.dng')).toBe(false);

    const restoredRow1 = assetRow(live.db, id1);
    expect(restoredRow1?.deleted_at).toBeNull();
    expect(restoredRow1?.original_path).toBeNull();
    expect(locations(live.db, id1)[0]!.path).toBe('photos/2024/vacation');
    expect(assetRow(live.db, id2)?.deleted_at).toBeNull();
    expect(locations(live.db, id2)[0]!.path).toBe('photos/2024/vacation/beach');

    // Sibling still untouched throughout.
    expect(await read('photos/2024/other.dng')).toBe('pixels-other');
  });

  test('a sibling directory whose name merely starts with the target is not matched', async () => {
    using live = await createLiveTestDatabase();
    const folderId = registerLibrary(live.db, root, 'folder-trash-test');
    await write('photos/IMG_1.dng', 'pixels-1');
    await write('photos2/IMG_2.dng', 'pixels-2');
    const id1 = seedAsset(live.db, folderId, 'photos', 'IMG_1.dng');
    const id2 = seedAsset(live.db, folderId, 'photos2', 'IMG_2.dng');

    const summary = await trashFolderRecursive(folderId, root, 'photos');
    expect(summary.total).toBe(1);
    expect(summary.items[0]!.assetId).toBe(id1.toHexString());

    expect(assetRow(live.db, id2)?.deleted_at).toBeNull();
    expect(await read('photos2/IMG_2.dng')).toBe('pixels-2');
  });
});

describe('trashFolderRecursive — partial-failure semantics', () => {
  test('one asset failing does not roll back the others, and is reported per-asset', async () => {
    using live = await createLiveTestDatabase();
    const folderId = registerLibrary(live.db, root, 'folder-trash-test');
    await write('sub/IMG_1.dng', 'pixels-1');
    // IMG_2's row is seeded but its on-disk file is deliberately NEVER
    // written — moveToTrash will fail to find the source, causing
    // trashAssetById to return `{ kind: 'error' }` for this one asset only.
    const id1 = seedAsset(live.db, folderId, 'sub', 'IMG_1.dng');
    const id2 = seedAsset(live.db, folderId, 'sub', 'IMG_2.dng');

    const summary = await trashFolderRecursive(folderId, root, 'sub');
    expect(summary.total).toBe(2);
    expect(summary.succeeded).toBe(1);
    expect(summary.failed).toBe(1);

    const ok = summary.items.find((i) => i.assetId === id1.toHexString());
    const failed = summary.items.find((i) => i.assetId === id2.toHexString());
    expect(ok?.ok).toBe(true);
    expect(failed?.ok).toBe(false);
    expect(failed?.error).toBeTruthy();

    // The succeeding asset's move was NOT rolled back because a sibling
    // failed — no-rollback partial-failure semantics.
    expect(await exists('.maple/trash/sub/IMG_1.dng')).toBe(true);
    expect(assetRow(live.db, id1)?.deleted_at).not.toBeNull();

    // The failed asset's row is untouched — still live, no original_path.
    expect(assetRow(live.db, id2)?.deleted_at).toBeNull();
  });
});

describe('trashFolderRecursive — multi-location change-feed correctness (#2695 review)', () => {
  test('folder-trashing a secondary location emits a change event for THAT location, not the primary', async () => {
    using live = await createLiveTestDatabase();
    const folderId = registerLibrary(live.db, root, 'folder-trash-test');
    // A different library on its own root — stands in for the asset's
    // globally-primary location, which this operation must NOT touch or
    // reference. Nothing is ever written under it: if the fix regresses and
    // the change event (or the folder lookup for it) falls back to this
    // library, the change row shows a null relative_path instead of the
    // correct one under `root`.
    const primaryLibraryId = registerLibrary(live.db, otherRoot, 'folder-trash-primary');
    await write('sub/IMG.dng', 'pixels');
    const id = new ObjectId(insertAsset(live.db));
    insertLocation(live.db, {
      assetId: id.toHexString(),
      libraryId: primaryLibraryId.toHexString(),
      ordinal: 0,
      path: '',
      filename: 'IMG.dng',
    });
    insertLocation(live.db, {
      assetId: id.toHexString(),
      libraryId: folderId.toHexString(),
      ordinal: 1,
      path: 'sub',
      filename: 'IMG.dng',
    });

    const summary = await trashFolderRecursive(folderId, root, 'sub');
    expect(summary.succeeded).toBe(1);

    const change = live.db
      .query(
        `SELECT folder_id, relative_path FROM asset_changes
          WHERE asset_id = ? AND kind = 'delete' ORDER BY cursor DESC LIMIT 1`,
      )
      .get(id.toHexString()) as { folder_id: string; relative_path: string | null } | null;
    expect(change).toBeTruthy();
    expect(change!.folder_id).toBe(folderId.toHexString());
    expect(change!.folder_id).not.toBe(primaryLibraryId.toHexString());
    // Resolved against `folderId`'s (our test folder's) root — proves the
    // relative_path lookup used the SECONDARY location's library, not the
    // primary one, whose root holds nothing and would have produced null.
    expect(change!.relative_path).toBe('sub/IMG.dng');
    expect(await fs.readdir(otherRoot)).toEqual([]);

    // The primary entry is completely untouched — only the secondary
    // (folderId) location was ever a candidate for this folder-trash.
    const primaryEntry = locations(live.db, id).find(
      (row) => row.library_id === primaryLibraryId.toHexString(),
    );
    expect(primaryEntry?.path).toBe('');
    expect(primaryEntry?.filename).toBe('IMG.dng');
  });
});

describe('folder-trashed assets are covered by the existing trash retention sweep', () => {
  // This asserts one half of the end-to-end purge (`runTrashGcOnce` in
  // `workers/trash-gc.ts`): the sweep's candidate query, which is what decides
  // whether a folder-trashed asset is covered at all. It reads
  // the asset's own `deleted_at` and nothing else — no notion of "this came
  // from a folder trash" — which is the claim this test exists to pin. The
  // unlink-and-delete half stays covered by `workers/trash-gc.test.ts`.
  test('the retention query picks up a folder-trashed asset once it is past the window, and not before', async () => {
    using live = await createLiveTestDatabase();
    const folderId = registerLibrary(live.db, root, 'folder-trash-test');
    await write('sub/IMG_1.dng', 'pixels-1');
    const id1 = seedAsset(live.db, folderId, 'sub', 'IMG_1.dng');

    const summary = await trashFolderRecursive(folderId, root, 'sub');
    expect(summary.succeeded).toBe(1);
    expect(await exists('.maple/trash/sub/IMG_1.dng')).toBe(true);

    // Fresh in the trash: inside the retention window, so not a candidate.
    const cutoffIso = new Date(Date.now() - 30 * 86_400_000).toISOString();
    expect(await listTrashedBefore(cutoffIso)).toEqual([]);

    // Backdate deleted_at past the retention window — exactly what
    // `trashAssetById`/`markSoftDeleted` stamped above, only older.
    const oldIso = new Date(Date.now() - 40 * 86_400_000).toISOString();
    run(live.db, `UPDATE assets SET deleted_at = ? WHERE id = ?`, oldIso, id1.toHexString());

    const candidates = await listTrashedBefore(cutoffIso);
    expect(candidates.map((c) => c._id.toHexString())).toEqual([id1.toHexString()]);
    // The location the sweep would unlink is the trashed copy, not the
    // original path the file left.
    expect(candidates[0]!.fileinfo[0]!.path).toBe('.maple/trash/sub');
    expect(candidates[0]!.deleted_reason).toBeNull();
  });
});
