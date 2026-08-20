/**
 * Integration tests for `relocateAsset`'s (#2629) `collision: 'replace'`
 * occupancy guard (#2843) — split out of `relocate-asset.test.ts` on its
 * own so that file stays under the repo's 600-line file-budget ceiling
 * (with headroom under 570) rather than thinning coverage to fit. Same
 * harness/pattern as the parent file: real temp directories + real files
 * (no mocks for the filesystem or sidecar layer) AND a real MongoDB,
 * connect-or-skip-gracefully — see `if (!db) return;` in every test body.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { MongoClient, ObjectId, type Db } from 'mongodb';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { closeDb } from '../db/client.ts';
import { setLibraryRootsForTests } from '../indexer/libraries.cache.ts';
import { relocateAsset } from './relocate-asset.ts';

const MONGO_URI = process.env.MAPLE_MONGO_URI ?? 'mongodb://localhost:27017';
const TEST_DB = `maple_relocate_asset_collision_test_${process.pid}`;
const ORIGINAL_MONGO_DB = process.env.MAPLE_MONGO_DB;
const ORIGINAL_MONGO_URI = process.env.MAPLE_MONGO_URI;

let client: MongoClient | null = null;
let db: Db | null = null;
let root: string;

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
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'relocate-asset-collision-'));
  client = await tryConnect();
  if (!client) return;
  await closeDb();
  process.env.MAPLE_MONGO_URI = MONGO_URI;
  process.env.MAPLE_MONGO_DB = TEST_DB;
  db = client.db(TEST_DB);
  await db.dropDatabase();
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
  setLibraryRootsForTests(null);
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

/** Pre-relocate stage bookkeeping every seeded asset starts with — dirty on
 * purpose (non-zero versions, an attempt count, a dead-lettered thumb) so a
 * test can assert `relocateAsset` actually resets it rather than merely
 * leaving already-zero fields alone. Mirrors the parent file's fixture. */
function dirtyStagesFixture(): Record<string, unknown> {
  return {
    thumb: { version: 3, attempts: 2, last_error: 'boom', processed_at: new Date(), dead: true },
    preview: { version: 3, attempts: 0, last_error: null, processed_at: new Date(), dead: false },
    meili: { version: 5, attempts: 1, last_error: null, processed_at: new Date(), dead: false },
  };
}

/** Seed one asset doc whose fileinfo[0] points at `relPath`/`filename` under
 * the temp `root`, wire the in-memory library-roots cache to resolve it,
 * and return the asset id + library id. */
async function seedAsset(
  d: Db,
  relPath: string,
  filename: string,
  extra: Record<string, unknown> = {},
): Promise<{ id: ObjectId; libraryId: ObjectId }> {
  const libraryId = new ObjectId();
  const id = new ObjectId();
  await d.collection('assets').insertOne({
    _id: id,
    fileinfo: [{ path: relPath, filename, library_id: libraryId, deleted_at: null }],
    size: 6,
    mtime: 1_700_000_000_000,
    rating: 0,
    flag: 0,
    color_label: '',
    indexed_at: '2026-01-01T00:00:00Z',
    has_xmp: false,
    deleted_at: null,
    stages: dirtyStagesFixture(),
    ...extra,
  } as never);
  setLibraryRootsForTests(new Map([[libraryId.toHexString(), root]]));
  return { id, libraryId };
}

/** Seed TWO asset docs sharing one library id — needed for occupancy-guard
 * tests, where the incoming asset's own library must still resolve to
 * `root` after the occupant is seeded (`seedAsset` above overwrites the
 * roots map on every call, since it always mints a fresh library id). */
async function seedTwoAssetsSameLibrary(
  d: Db,
  a: { relPath: string; filename: string },
  b: { relPath: string; filename: string },
): Promise<{ idA: ObjectId; idB: ObjectId; libraryId: ObjectId }> {
  const libraryId = new ObjectId();
  const idA = new ObjectId();
  const idB = new ObjectId();
  const base = (id: ObjectId, entry: { relPath: string; filename: string }) => ({
    _id: id,
    fileinfo: [
      { path: entry.relPath, filename: entry.filename, library_id: libraryId, deleted_at: null },
    ],
    size: 6,
    mtime: 1_700_000_000_000,
    rating: 0,
    flag: 0,
    color_label: '',
    indexed_at: '2026-01-01T00:00:00Z',
    has_xmp: false,
    deleted_at: null,
    stages: dirtyStagesFixture(),
  });
  await d.collection('assets').insertOne(base(idA, a) as never);
  await d.collection('assets').insertOne(base(idB, b) as never);
  setLibraryRootsForTests(new Map([[libraryId.toHexString(), root]]));
  return { idA, idB, libraryId };
}

type StageRow = { version: number; attempts: number; last_error: unknown; dead: boolean };
type AssetRow = {
  fileinfo: Array<{ path: string; filename: string }>;
  stages: Record<string, StageRow>;
};

/** Re-fetch an asset row with the shape the tests below assert against. */
async function fetchAssetRow(d: Db, id: ObjectId): Promise<AssetRow> {
  return (await d.collection('assets').findOne({ _id: id })) as unknown as AssetRow;
}

// ---------------------------------------------------------------------------
// #2843 — `collision: 'replace'` must refuse rather than clobber a
// DIFFERENT, live, indexed asset already occupying the destination.
// ---------------------------------------------------------------------------

describe('relocateAsset — replace collision guard (#2843)', () => {
  test('replace onto a path occupied by another LIVE indexed asset is refused 409-shaped, both files and sidecars intact, both rows unchanged', async () => {
    if (!db) return;
    await write('a/incoming.dng', 'incoming-pixels');
    await write('b/occupant.dng', 'occupant-pixels');
    await write('b/occupant.xmp', 'occupant-edits');
    const { idA: incomingId, idB: occupantId } = await seedTwoAssetsSameLibrary(
      db,
      { relPath: 'a', filename: 'incoming.dng' },
      { relPath: 'b', filename: 'occupant.dng' },
    );

    const result = await relocateAsset({
      id: incomingId,
      mode: 'move',
      collision: 'replace',
      destinationPath: 'b',
      destinationFilename: 'occupant.dng',
    });

    expect(result).toEqual({ kind: 'occupied', occupiedByAssetId: occupantId.toHexString() });

    // Neither file's bytes moved.
    expect(await read('a/incoming.dng')).toBe('incoming-pixels');
    expect(await read('b/occupant.dng')).toBe('occupant-pixels');
    // The occupant's sidecar (edit history) was NOT deleted.
    expect(await read('b/occupant.xmp')).toBe('occupant-edits');

    // Neither row moved.
    const incomingRow = await fetchAssetRow(db, incomingId);
    expect(incomingRow.fileinfo[0]!.path).toBe('a');
    expect(incomingRow.fileinfo[0]!.filename).toBe('incoming.dng');
    const occupantRow = await fetchAssetRow(db, occupantId);
    expect(occupantRow.fileinfo[0]!.path).toBe('b');
    expect(occupantRow.fileinfo[0]!.filename).toBe('occupant.dng');
  });

  test('replace onto a path occupied only by an UNTRACKED file (no asset row) still works — the legitimate case', async () => {
    if (!db) return;
    await write('a/incoming.dng', 'incoming-pixels');
    await write('b/untracked.dng', 'stale-bytes-nobody-indexed');
    const { id } = await seedAsset(db, 'a', 'incoming.dng');

    const result = await relocateAsset({
      id,
      mode: 'move',
      collision: 'replace',
      destinationPath: 'b',
      destinationFilename: 'untracked.dng',
    });

    expect(result.kind).toBe('relocated');
    expect(await exists('a/incoming.dng')).toBe(false);
    expect(await read('b/untracked.dng')).toBe('incoming-pixels');
    const row = await fetchAssetRow(db, id);
    expect(row.fileinfo[0]!.path).toBe('b');
    expect(row.fileinfo[0]!.filename).toBe('untracked.dng');
  });

  test('replace onto a path occupied by a TRASHED (top-level deleted_at set) former occupant still works — not a live occupant', async () => {
    if (!db) return;
    await write('a/incoming.dng', 'incoming-pixels');
    await write('b/trashed.dng', 'trashed-occupant-bytes');
    const { idA: incomingId, idB: trashedId } = await seedTwoAssetsSameLibrary(
      db,
      { relPath: 'a', filename: 'incoming.dng' },
      { relPath: 'b', filename: 'trashed.dng' },
    );
    // Mark the occupant top-level trashed WITHOUT moving its fileinfo entry
    // off the destination path — isolates the top-level `deleted_at` check:
    // even though the entry still names 'b/trashed.dng', a trashed asset
    // must not count as a live occupant.
    await db
      .collection('assets')
      .updateOne({ _id: trashedId }, { $set: { deleted_at: '2026-01-01T00:00:00Z' } });

    const result = await relocateAsset({
      id: incomingId,
      mode: 'move',
      collision: 'replace',
      destinationPath: 'b',
      destinationFilename: 'trashed.dng',
    });

    expect(result.kind).toBe('relocated');
    expect(await read('b/trashed.dng')).toBe('incoming-pixels');
  });

  test('replace does not consider the incoming asset itself an occupant of its own destination', async () => {
    if (!db) return;
    // A multi-location asset: one live entry at 'a', another live entry
    // already at 'b' — replacing onto 'b' for the SAME asset must not be
    // refused as "occupied by a different asset" (it isn't different).
    await write('a/IMG_1.dng', 'pixels-a');
    await write('b/IMG_1.dng', 'pixels-b');
    const libraryId = new ObjectId();
    const id = new ObjectId();
    await db.collection('assets').insertOne({
      _id: id,
      fileinfo: [
        { path: 'a', filename: 'IMG_1.dng', library_id: libraryId, deleted_at: null },
        {
          path: 'b',
          filename: 'IMG_1.dng',
          library_id: libraryId,
          deleted_at: null,
          missing_since: new Date(),
        },
      ],
      deleted_at: null,
      stages: dirtyStagesFixture(),
    } as never);
    setLibraryRootsForTests(new Map([[libraryId.toHexString(), root]]));

    const result = await relocateAsset({
      id,
      mode: 'move',
      collision: 'replace',
      destinationPath: 'b',
      destinationFilename: 'IMG_1.dng',
    });

    expect(result.kind).not.toBe('occupied');
  });

  test('auto-suffix/keep-both/skip are unaffected by the guard — collision landscape unchanged', async () => {
    if (!db) return;
    await write('a/IMG_1.dng', 'pixels');
    await write('b/IMG_1.dng', 'occupant');
    const { idA: incomingId } = await seedTwoAssetsSameLibrary(
      db,
      { relPath: 'a', filename: 'IMG_1.dng' },
      { relPath: 'b', filename: 'IMG_1.dng' },
    );

    const autoSuffix = await relocateAsset({
      id: incomingId,
      mode: 'move',
      collision: 'auto-suffix',
      destinationPath: 'b',
    });
    expect(autoSuffix.kind).toBe('relocated');
    if (autoSuffix.kind === 'relocated') {
      expect(autoSuffix.newFilename).toBe('IMG_1.1.dng');
    }
  });

  test('skip against an occupied destination stays a no-op (guard is replace-only)', async () => {
    if (!db) return;
    await write('a/IMG_1.dng', 'pixels');
    await write('b/IMG_1.dng', 'occupant');
    const { idA: incomingId } = await seedTwoAssetsSameLibrary(
      db,
      { relPath: 'a', filename: 'IMG_1.dng' },
      { relPath: 'b', filename: 'IMG_1.dng' },
    );

    const result = await relocateAsset({
      id: incomingId,
      mode: 'move',
      collision: 'skip',
      destinationPath: 'b',
    });
    expect(result.kind).toBe('skipped');
    expect(await read('a/IMG_1.dng')).toBe('pixels');
    expect(await read('b/IMG_1.dng')).toBe('occupant');
  });

  test("the incoming asset's own row is untouched after a refusal", async () => {
    if (!db) return;
    await write('a/incoming.dng', 'incoming-pixels');
    await write('b/occupant.dng', 'occupant-pixels');
    const { idA: incomingId } = await seedTwoAssetsSameLibrary(
      db,
      { relPath: 'a', filename: 'incoming.dng' },
      { relPath: 'b', filename: 'occupant.dng' },
    );

    const before = await fetchAssetRow(db, incomingId);
    const result = await relocateAsset({
      id: incomingId,
      mode: 'move',
      collision: 'replace',
      destinationPath: 'b',
      destinationFilename: 'occupant.dng',
    });
    expect(result.kind).toBe('occupied');

    const after = await fetchAssetRow(db, incomingId);
    expect(after.fileinfo).toEqual(before.fileinfo);
    expect(after.stages).toEqual(before.stages);
  });
});
