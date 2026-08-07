/**
 * Integration tests for recursive folder trash + restore (#2630).
 *
 * Real temp directories + real files (no mocks for the filesystem or
 * sidecar layer) AND a real MongoDB, following the same
 * connect-or-skip-gracefully pattern as `library/relocate-asset.test.ts`.
 * Skips (not fails) when Mongo is unreachable.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { MongoClient, ObjectId, type Db } from 'mongodb';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { closeDb } from '../db/client.ts';
import { invalidateLibraryRoots } from '../indexer/libraries.cache.ts';
import { trashFolderRecursive, restoreFolderRecursive } from './folder-trash.ts';
import { runTrashGcOnce } from '../workers/trash-gc.ts';

const MONGO_URI = process.env.MAPLE_MONGO_URI ?? 'mongodb://localhost:27017';
const TEST_DB = `maple_folder_trash_test_${process.pid}`;
const ORIGINAL_MONGO_DB = process.env.MAPLE_MONGO_DB;
const ORIGINAL_MONGO_URI = process.env.MAPLE_MONGO_URI;

let client: MongoClient | null = null;
let db: Db | null = null;
let root: string;
let folderId: ObjectId;

async function tryConnect(): Promise<MongoClient | null> {
  const c = new MongoClient(MONGO_URI, {
    serverSelectionTimeoutMS: 1_500,
    connectTimeoutMS: 1_500,
  });
  try {
    await c.connect();
    await c.db('admin').command({ ping: 1 });
    return c;
  } catch {
    try {
      await c.close();
    } catch {}
    return null;
  }
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'folder-trash-'));
  client = await tryConnect();
  if (!client) return;
  await closeDb();
  process.env.MAPLE_MONGO_URI = MONGO_URI;
  process.env.MAPLE_MONGO_DB = TEST_DB;
  db = client.db(TEST_DB);
  await db.dropDatabase();

  folderId = new ObjectId();
  await db.collection('folders').insertOne({
    _id: folderId,
    path: root,
    slug: 'folder-trash-test',
    label: 'folder-trash-test',
    last_scan: null,
    file_count: 0,
    created_at: new Date().toISOString(),
  } as never);
  invalidateLibraryRoots();
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

afterAll(async () => {
  if (db) await db.dropDatabase();
  if (client) await client.close();
  if (ORIGINAL_MONGO_DB === undefined) delete process.env.MAPLE_MONGO_DB;
  else process.env.MAPLE_MONGO_DB = ORIGINAL_MONGO_DB;
  if (ORIGINAL_MONGO_URI === undefined) delete process.env.MAPLE_MONGO_URI;
  else process.env.MAPLE_MONGO_URI = ORIGINAL_MONGO_URI;
  await closeDb();
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

/** Seed one asset doc whose fileinfo[0] points at `relDir`/`filename` under
 * the temp `root`, under `folderId`. */
async function seedAsset(
  d: Db,
  relDir: string,
  filename: string,
  extra: Record<string, unknown> = {},
): Promise<ObjectId> {
  const id = new ObjectId();
  await d.collection('assets').insertOne({
    _id: id,
    fileinfo: [{ path: relDir, filename, library_id: folderId, deleted_at: null }],
    size: 6,
    mtime: 1_700_000_000_000,
    rating: 0,
    flag: 0,
    color_label: '',
    indexed_at: '2026-01-01T00:00:00Z',
    has_xmp: false,
    deleted_at: null,
    maple_id: id.toHexString(),
    ...extra,
  } as never);
  return id;
}

type AssetRow = {
  fileinfo: Array<{ path: string; filename: string; library_id: ObjectId }>;
  deleted_at: string | null;
  original_path: string | null;
};

async function fetchAssetRow(d: Db, id: ObjectId): Promise<AssetRow> {
  return (await d.collection('assets').findOne({ _id: id })) as unknown as AssetRow;
}

describe('trashFolderRecursive / restoreFolderRecursive — nested-tree round trip', () => {
  test('trash + restore a >=3-level nested tree, sidecars intact, siblings untouched', async () => {
    if (!db) return;

    // Nested tree under photos/2024/vacation (3 levels deep at its deepest:
    // vacation/, vacation/beach/), each RAW paired with an XMP sidecar.
    await write('photos/2024/vacation/IMG_1.dng', 'pixels-1');
    await write('photos/2024/vacation/IMG_1.xmp', 'edits-1');
    await write('photos/2024/vacation/beach/IMG_2.dng', 'pixels-2');
    await write('photos/2024/vacation/beach/IMG_2.xmp', 'edits-2');
    // A sibling OUTSIDE the trashed subtree — must survive untouched.
    await write('photos/2024/other.dng', 'pixels-other');

    const id1 = await seedAsset(db, 'photos/2024/vacation', 'IMG_1.dng');
    const id2 = await seedAsset(db, 'photos/2024/vacation/beach', 'IMG_2.dng');
    const idOther = await seedAsset(db, 'photos/2024', 'other.dng');

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
    const otherRow = await fetchAssetRow(db, idOther);
    expect(otherRow.deleted_at).toBeNull();

    // Now-empty source subtree (vacation/, vacation/beach/) was cleaned up
    // best-effort; photos/2024 survives (still holds other.dng).
    expect(await exists('photos/2024/vacation')).toBe(false);
    expect(await exists('photos/2024')).toBe(true);

    // DB: both trashed assets tombstoned + repointed, original_path recorded.
    const row1 = await fetchAssetRow(db, id1);
    expect(row1.deleted_at).not.toBeNull();
    expect(row1.original_path).toBe(path.join(root, 'photos/2024/vacation/IMG_1.dng'));
    expect(row1.fileinfo[0]!.path).toBe('.maple/trash/photos/2024/vacation');
    const row2 = await fetchAssetRow(db, id2);
    expect(row2.deleted_at).not.toBeNull();
    expect(row2.fileinfo[0]!.path).toBe('.maple/trash/photos/2024/vacation/beach');

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

    const restoredRow1 = await fetchAssetRow(db, id1);
    expect(restoredRow1.deleted_at).toBeNull();
    expect(restoredRow1.original_path).toBeNull();
    expect(restoredRow1.fileinfo[0]!.path).toBe('photos/2024/vacation');
    const restoredRow2 = await fetchAssetRow(db, id2);
    expect(restoredRow2.deleted_at).toBeNull();
    expect(restoredRow2.fileinfo[0]!.path).toBe('photos/2024/vacation/beach');

    // Sibling still untouched throughout.
    expect(await read('photos/2024/other.dng')).toBe('pixels-other');
  });

  test('a sibling directory whose name merely starts with the target is not matched', async () => {
    if (!db) return;
    await write('photos/IMG_1.dng', 'pixels-1');
    await write('photos2/IMG_2.dng', 'pixels-2');
    const id1 = await seedAsset(db, 'photos', 'IMG_1.dng');
    const id2 = await seedAsset(db, 'photos2', 'IMG_2.dng');

    const summary = await trashFolderRecursive(folderId, root, 'photos');
    expect(summary.total).toBe(1);
    expect(summary.items[0]!.assetId).toBe(id1.toHexString());

    const row2 = await fetchAssetRow(db, id2);
    expect(row2.deleted_at).toBeNull();
    expect(await read('photos2/IMG_2.dng')).toBe('pixels-2');
  });
});

describe('trashFolderRecursive — partial-failure semantics', () => {
  test('one asset failing does not roll back the others, and is reported per-asset', async () => {
    if (!db) return;
    await write('sub/IMG_1.dng', 'pixels-1');
    // IMG_2's asset doc is seeded but its on-disk file is deliberately
    // NEVER written — moveToTrash will fail to find the source, causing
    // trashAssetById to return `{ kind: 'error' }` for this one asset only.
    const id1 = await seedAsset(db, 'sub', 'IMG_1.dng');
    const id2 = await seedAsset(db, 'sub', 'IMG_2.dng');

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
    const row1 = await fetchAssetRow(db, id1);
    expect(row1.deleted_at).not.toBeNull();

    // The failed asset's doc is untouched — still live, no original_path.
    const row2 = await fetchAssetRow(db, id2);
    expect(row2.deleted_at).toBeNull();
  });
});

describe('trashFolderRecursive — multi-location change-feed correctness (#2695 review)', () => {
  test('folder-trashing a secondary location emits a change event for THAT location, not the primary', async () => {
    if (!db) return;
    // A different, un-registered library — stands in for the asset's
    // globally-primary location, which this operation must NOT touch or
    // reference. It's deliberately never written to disk and never
    // registered in `folders`: if the fix regresses and the change event
    // (or the folder lookup for it) ever falls back to this library, the
    // asset_changes row will show a stale/null relative_path instead of
    // the correct one under `root`.
    const primaryLibraryId = new ObjectId();
    await write('sub/IMG.dng', 'pixels');
    const id = new ObjectId();
    await db.collection('assets').insertOne({
      _id: id,
      fileinfo: [
        { path: '', filename: 'IMG.dng', library_id: primaryLibraryId, deleted_at: null },
        { path: 'sub', filename: 'IMG.dng', library_id: folderId, deleted_at: null },
      ],
      size: 6,
      mtime: 1_700_000_000_000,
      deleted_at: null,
    } as never);

    const summary = await trashFolderRecursive(folderId, root, 'sub');
    expect(summary.succeeded).toBe(1);

    const change = await db
      .collection('asset_changes')
      .findOne({ asset_id: id, kind: 'delete' }, { sort: { cursor: -1 } });
    expect(change).toBeTruthy();
    const folderIdOnChange = (change as unknown as { folder_id: ObjectId }).folder_id;
    expect(folderIdOnChange.equals(folderId)).toBe(true);
    expect(folderIdOnChange.equals(primaryLibraryId)).toBe(false);
    // Resolved against `folderId`'s (our test folder's) root — proves the
    // relative_path lookup used the SECONDARY location's library, not the
    // primary one (which isn't even a registered folder, so a wrong
    // lookup would have produced null here).
    expect((change as unknown as { relative_path: string | null }).relative_path).toBe(
      'sub/IMG.dng',
    );

    // The primary entry is completely untouched — only the secondary
    // (folderId) location was ever a candidate for this folder-trash.
    const row = await fetchAssetRow(db, id);
    const primaryEntry = row.fileinfo.find((f) => f.library_id.equals(primaryLibraryId));
    expect(primaryEntry?.path).toBe('');
    expect(primaryEntry?.filename).toBe('IMG.dng');
  });
});

describe('folder-trashed assets are covered by the existing trash-gc sweep', () => {
  test('runTrashGcOnce purges a folder-trashed asset once past the retention window — no folder-specific GC needed', async () => {
    if (!db) return;
    await write('sub/IMG_1.dng', 'pixels-1');
    const id1 = await seedAsset(db, 'sub', 'IMG_1.dng');

    const summary = await trashFolderRecursive(folderId, root, 'sub');
    expect(summary.succeeded).toBe(1);
    expect(await exists('.maple/trash/sub/IMG_1.dng')).toBe(true);

    // Backdate deleted_at past the retention window — trash-gc has no
    // notion of "this came from a folder trash", it only reads the
    // asset doc's own deleted_at, which is exactly what
    // `trashAssetById`/`markSoftDeleted` stamped above.
    const oldIso = new Date(Date.now() - 40 * 86_400_000).toISOString();
    await db.collection('assets').updateOne({ _id: id1 }, { $set: { deleted_at: oldIso } });

    const gcSummary = await runTrashGcOnce({ retentionDays: 30 });
    expect(gcSummary.purged).toBeGreaterThanOrEqual(1);

    expect(await exists('.maple/trash/sub/IMG_1.dng')).toBe(false);
    const row = await db.collection('assets').findOne({ _id: id1 });
    expect(row).toBeNull();
  });
});
