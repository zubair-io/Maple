/**
 * Integration tests for `trashAssetById` / `restoreAssetById` (#2630),
 * covering two rounds of the #2695 review:
 *
 *   1. The plain "first non-deleted" fileinfo pick is unsafe when an
 *      earlier entry is missing-tagged but not deleted — it targets the
 *      stale/offline copy instead of the live one (same bug class fixed
 *      for `relocateAsset` via `activeFileInfo`).
 *   2. A follow-up round caught that the FIRST fix was incomplete: the
 *      selector (`activeFileInfo`) picked the right entry, but the
 *      no-`opts.entry` derivation of `libraryId`/`assetFolderId` still
 *      came from the asset's globally-primary `info.folder_id` — a
 *      SEPARATE computation (`resolvePrimary` in `assets.transform.ts`)
 *      that can disagree with `activeFileInfo` when no fileinfo entry is
 *      simultaneously live AND not-missing-tagged (both then fall back,
 *      but to different elements — `resolvePrimary` falls back to the
 *      literal `fileinfo[0]`, `activeFileInfo` falls back to the first
 *      merely-live one). The fix (`resolveEntrySpec`) collapses both
 *      functions onto ONE entry-resolution call so the library used for
 *      the file move, DB repoint, and folder-root lookup can never
 *      disagree with the entry actually acted on again.
 *
 * The tests below construct that exact divergence with TWO distinct
 * libraries, and assert the file physically lands under the SECONDARY
 * library's root — not merely that some downstream event references the
 * right id, which wouldn't have caught the incompleteness (see #2695).
 *
 * Real temp directories + real files AND a real MongoDB, same
 * connect-or-skip-gracefully pattern as the sibling `library/*.test.ts`
 * files.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { MongoClient, ObjectId, type Db } from 'mongodb';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { closeDb } from '../db/client.ts';
import { invalidateLibraryRoots } from '../indexer/libraries.cache.ts';
import { trashAssetById, restoreAssetById } from './asset-trash.ts';

const MONGO_URI = process.env.MAPLE_MONGO_URI ?? 'mongodb://localhost:27017';
const TEST_DB = `maple_asset_trash_test_${process.pid}`;
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
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'asset-trash-'));
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
    slug: 'asset-trash-test',
    label: 'asset-trash-test',
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

type AssetRow = {
  fileinfo: Array<{
    path: string;
    filename: string;
    library_id: ObjectId;
    deleted_at?: string | null;
    missing_since?: Date | string | null;
  }>;
  deleted_at: string | null;
};

async function fetchAssetRow(d: Db, id: ObjectId): Promise<AssetRow> {
  return (await d.collection('assets').findOne({ _id: id })) as unknown as AssetRow;
}

describe('trashAssetById / restoreAssetById — multi-location selector', () => {
  test('trash: targets the live entry, not a missing-tagged one (same library)', async () => {
    if (!db) return;
    await write('live/IMG_9.dng', 'pixels');
    const id = new ObjectId();
    // Same shape as relocate-asset.test.ts's regression fixture: the
    // FIRST fileinfo entry is missing-tagged (stale/offline location),
    // the SECOND is live. The plain "first non-deleted" pick would target
    // the stale one.
    await db.collection('assets').insertOne({
      _id: id,
      fileinfo: [
        {
          path: 'stale',
          filename: 'IMG_9.dng',
          library_id: folderId,
          deleted_at: null,
          missing_since: new Date(),
        },
        { path: 'live', filename: 'IMG_9.dng', library_id: folderId, deleted_at: null },
      ],
      size: 6,
      mtime: 1_700_000_000_000,
      deleted_at: null,
    } as never);

    const outcome = await trashAssetById(id);
    expect(outcome.kind).toBe('ok');

    // The LIVE copy moved to trash; the stale-tagged entry's (nonexistent)
    // file was never touched.
    expect(await exists('live/IMG_9.dng')).toBe(false);
    expect(await read('.maple/trash/live/IMG_9.dng')).toBe('pixels');

    const row = await fetchAssetRow(db, id);
    expect(row.deleted_at).not.toBeNull();
    const staleEntry = row.fileinfo.find((f) => f.path === 'stale');
    const liveEntry = row.fileinfo.find((f) => f.path.startsWith('.maple/trash'));
    expect(staleEntry).toBeTruthy(); // untouched
    expect(liveEntry?.path).toBe('.maple/trash/live');
  });

  test('restore: targets the trashed (formerly-live) entry, not a missing-tagged one (same library)', async () => {
    if (!db) return;
    await write('live/IMG_9.dng', 'pixels');
    const id = new ObjectId();
    await db.collection('assets').insertOne({
      _id: id,
      fileinfo: [
        {
          path: 'stale',
          filename: 'IMG_9.dng',
          library_id: folderId,
          deleted_at: null,
          missing_since: new Date(),
        },
        { path: 'live', filename: 'IMG_9.dng', library_id: folderId, deleted_at: null },
      ],
      size: 6,
      mtime: 1_700_000_000_000,
      deleted_at: null,
    } as never);

    const trashOutcome = await trashAssetById(id);
    expect(trashOutcome.kind).toBe('ok');

    // After trash, BOTH fileinfo entries are missing_since-free (only the
    // trashed one's path/filename changed) — restoreAssetById must not
    // fall back to the naive "first non-deleted" pick, which would target
    // the still-stale-tagged `stale` entry instead of the trashed one.
    const restoreOutcome = await restoreAssetById(id);
    expect(restoreOutcome.kind).toBe('ok');

    expect(await read('live/IMG_9.dng')).toBe('pixels');
    const row = await fetchAssetRow(db, id);
    expect(row.deleted_at).toBeNull();
    const staleEntry = row.fileinfo.find((f) => f.path === 'stale');
    const restoredEntry = row.fileinfo.find((f) => f.path === 'live');
    expect(staleEntry).toBeTruthy(); // still untouched
    expect(restoredEntry).toBeTruthy();
  });
});

describe('trashAssetById / restoreAssetById — cross-library derivation (#2695 second review round)', () => {
  // `resolvePrimary` (assets.transform.ts, backs `info.folder_id`) and
  // `activeFileInfo` (this module's selector) can disagree specifically
  // when NO fileinfo entry is simultaneously live-and-not-missing:
  // `resolvePrimary` then falls back to the literal `fileinfo[0]`, while
  // `activeFileInfo` falls back to the first merely-live entry. Putting
  // the two entries in DIFFERENT libraries makes a wrong derivation
  // observable as a hard failure (or worse, a write to the wrong
  // library's root) rather than something that happens to still work by
  // coincidence.
  //
  // `staleLibraryId` is deliberately NEVER registered in `folders` — the
  // fixed code must never look it up at all. If a regression reintroduces
  // `libraryId = info.folder_id`, this asserts against exactly what that
  // would do: resolve to the unregistered library and fail outright,
  // rather than silently writing there (there is nothing on disk under it
  // to fail either way, but the assertions below on `root` pin down where
  // the file actually must land).

  test('trash: the file lands under the SECONDARY (active) library root, not the primary', async () => {
    if (!db) return;
    const staleLibraryId = new ObjectId(); // never registered
    await write('sub/IMG.dng', 'pixels');
    const id = new ObjectId();
    await db.collection('assets').insertOne({
      _id: id,
      fileinfo: [
        // fileinfo[0]: retired entry in a DIFFERENT, unregistered library.
        // `resolvePrimary`'s naive fallback (`fileinfo[0]`) would pick
        // this one if the fixed derivation regressed.
        {
          path: 'old',
          filename: 'IMG.dng',
          library_id: staleLibraryId,
          deleted_at: '2020-01-01T00:00:00Z',
        },
        // fileinfo[1]: the ACTUAL active entry, live but missing-tagged —
        // `activeFileInfo`'s fallback (first merely-live entry) correctly
        // picks this one.
        {
          path: 'sub',
          filename: 'IMG.dng',
          library_id: folderId,
          deleted_at: null,
          missing_since: new Date(),
        },
      ],
      size: 6,
      mtime: 1_700_000_000_000,
      deleted_at: null,
    } as never);

    const outcome = await trashAssetById(id);
    expect(outcome.kind).toBe('ok');
    if (outcome.kind === 'ok') {
      expect(outcome.folderId.equals(folderId)).toBe(true);
      expect(outcome.folderId.equals(staleLibraryId)).toBe(false);
    }

    // The file physically moved under `root` — folderId's (the secondary
    // library's) root — not merely that some event/return value claims so.
    expect(await exists('sub/IMG.dng')).toBe(false);
    expect(await read('.maple/trash/sub/IMG.dng')).toBe('pixels');

    const row = await fetchAssetRow(db, id);
    const retiredEntry = row.fileinfo.find((f) => f.library_id.equals(staleLibraryId));
    const trashedEntry = row.fileinfo.find((f) => f.library_id.equals(folderId));
    expect(retiredEntry?.path).toBe('old'); // completely untouched
    expect(trashedEntry?.path).toBe('.maple/trash/sub');
  });

  test('restore: the file lands back under the SECONDARY (active) library root, not the primary', async () => {
    if (!db) return;
    const staleLibraryId = new ObjectId(); // never registered
    await write('.maple/trash/sub/IMG.dng', 'pixels');
    const id = new ObjectId();
    const originalAbsPath = path.join(root, 'sub', 'IMG.dng');
    await db.collection('assets').insertOne({
      _id: id,
      fileinfo: [
        {
          path: 'old',
          filename: 'IMG.dng',
          library_id: staleLibraryId,
          deleted_at: '2020-01-01T00:00:00Z',
        },
        // The already-trashed entry — seeded directly with a residual
        // `missing_since` (plausible: a watcher `removed` event could
        // have tagged it before it was trashed) so NEITHER entry is
        // simultaneously live-and-not-missing, forcing both selectors
        // into their fallback branches.
        {
          path: '.maple/trash/sub',
          filename: 'IMG.dng',
          library_id: folderId,
          deleted_at: null,
          missing_since: new Date(),
        },
      ],
      size: 6,
      mtime: 1_700_000_000_000,
      deleted_at: '2026-01-01T00:00:00Z',
      original_path: originalAbsPath,
    } as never);

    const outcome = await restoreAssetById(id);
    expect(outcome.kind).toBe('ok');
    if (outcome.kind === 'ok') {
      expect(outcome.folderId.equals(folderId)).toBe(true);
      expect(outcome.folderId.equals(staleLibraryId)).toBe(false);
    }

    // The file physically landed back under `root` (folderId's root).
    expect(await exists('.maple/trash/sub/IMG.dng')).toBe(false);
    expect(await read('sub/IMG.dng')).toBe('pixels');

    const row = await fetchAssetRow(db, id);
    const retiredEntry = row.fileinfo.find((f) => f.library_id.equals(staleLibraryId));
    const restoredEntry = row.fileinfo.find((f) => f.library_id.equals(folderId));
    expect(retiredEntry?.path).toBe('old'); // completely untouched
    expect(restoredEntry?.path).toBe('sub');
  });
});

describe('reaped rows (#2977)', () => {
  test('restore of a reaped asset fails cleanly without touching disk', async () => {
    if (!client) return;
    // A reaped row: soft-deleted by the missing-reaper, no trashed copy.
    // The file quietly RETURNED to the stored path — restore must still
    // refuse (revive is discover's job) and must not move/unlink anything.
    const abs = await write('sub/back.dng', 'returned-bytes');
    const id = new ObjectId();
    await db!.collection('assets').insertOne({
      _id: id,
      fileinfo: [
        {
          path: 'sub',
          filename: 'back.dng',
          library_id: folderId,
          deleted_at: null,
          missing_since: '2026-08-01T00:00:00.000Z',
        },
      ],
      deleted_at: '2026-08-10T00:00:00.000Z',
      deleted_reason: 'reaped',
      size: 1,
      mtime: 0,
      rating: 0,
      flag: 0,
      color_label: '',
      indexed_at: '2026-08-01T00:00:00.000Z',
    } as never);

    const outcome = await restoreAssetById(id);
    expect(outcome.kind).toBe('error');
    expect((outcome as { error?: string }).error).toContain('removed from disk');
    // Row untouched, file untouched.
    const row = await fetchAssetRow(db!, id);
    expect(row.deleted_at).toBe('2026-08-10T00:00:00.000Z');
    expect(await read('sub/back.dng')).toBe('returned-bytes');
    void abs;
  });
});
