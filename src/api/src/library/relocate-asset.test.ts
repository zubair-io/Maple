/**
 * Integration tests for `relocateAsset` (#2629) — the Mongo-aware
 * orchestrator built on the generic `relocateFile` primitive.
 *
 * Real temp directories + real files (no mocks for the filesystem or
 * sidecar layer) AND a real MongoDB, following the same
 * connect-or-skip-gracefully pattern as
 * `db/assets.repo.trash-rearm.test.ts`. Skips (not fails) when Mongo is
 * unreachable — see `if (!db) return;` in every test body.
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
const TEST_DB = `maple_relocate_asset_test_${process.pid}`;
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
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'relocate-asset-'));
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
 * leaving already-zero fields alone. */
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

type StageRow = { version: number; attempts: number; last_error: unknown; dead: boolean };
type AssetRow = {
  fileinfo: Array<{ path: string; filename: string }>;
  stages: Record<string, StageRow>;
};

/** Re-fetch an asset row with the shape the tests below assert against. */
async function fetchAssetRow(d: Db, id: ObjectId): Promise<AssetRow> {
  return (await d.collection('assets').findOne({ _id: id })) as unknown as AssetRow;
}

/** A stage entry was reset to the post-relocate baseline the ticket's step 7
 * (bump the thumb/preview stage-version) requires. */
function expectStageReset(stage: StageRow): void {
  expect(stage.version).toBe(0);
  expect(stage.attempts).toBe(0);
  expect(stage.last_error).toBeNull();
  expect(stage.dead).toBe(false);
}

describe('relocateAsset', () => {
  test('move: repoints fileinfo, resets thumb/preview + meili, deletes the source', async () => {
    if (!db) return;
    await write('a/IMG_1.dng', 'pixels');
    const { id } = await seedAsset(db, 'a', 'IMG_1.dng');

    const result = await relocateAsset({
      id,
      mode: 'move',
      collision: 'auto-suffix',
      destinationPath: 'b',
    });

    expect(result.kind).toBe('relocated');
    if (result.kind !== 'relocated') return;
    expect(result.newPath).toBe('b');
    expect(result.newFilename).toBe('IMG_1.dng');
    expect(result.renamedOnCollision).toBe(false);
    expect(await exists('a/IMG_1.dng')).toBe(false);
    expect(await read('b/IMG_1.dng')).toBe('pixels');

    const row = await fetchAssetRow(db, id);
    expect(row.fileinfo[0]!.path).toBe('b');
    expect(row.fileinfo[0]!.filename).toBe('IMG_1.dng');
    expectStageReset(row.stages.thumb!);
    expect(row.stages.preview!.version).toBe(0);
    expect(row.stages.meili!.version).toBe(0);
  });

  test('copy: DB row stays untouched — the source asset keeps its identity', async () => {
    if (!db) return;
    await write('a/IMG_1.dng', 'pixels');
    const { id } = await seedAsset(db, 'a', 'IMG_1.dng');

    const result = await relocateAsset({
      id,
      mode: 'copy',
      collision: 'auto-suffix',
      destinationPath: 'b',
    });

    expect(result.kind).toBe('relocated');
    expect(await exists('a/IMG_1.dng')).toBe(true); // copy mode: source survives
    expect(await read('b/IMG_1.dng')).toBe('pixels');

    // The load-bearing half: a copy must NOT repoint the original asset's
    // fileinfo to the duplicate — that would catalog-orphan the untouched
    // source file. The duplicate is the indexer's to discover. The stage
    // rows equally stay dirty: nothing about the source changed.
    const row = await fetchAssetRow(db, id);
    expect(row.fileinfo[0]!.path).toBe('a');
    expect(row.fileinfo[0]!.filename).toBe('IMG_1.dng');
    expect(row.stages.thumb!.version).toBe(3);
  });

  test('multi-location asset: relocate targets the live entry, not a missing-tagged one', async () => {
    if (!db) return;
    await write('live/IMG_9.dng', 'pixels');
    const libraryId = new ObjectId();
    const id = new ObjectId();
    // First entry is missing-tagged (stale/offline location), second is
    // live. The 7173f5e6f selector bug class: a plain "first non-deleted"
    // pick targets the stale copy instead of the live one.
    await db.collection('assets').insertOne({
      _id: id,
      fileinfo: [
        {
          path: 'stale',
          filename: 'IMG_9.dng',
          library_id: libraryId,
          deleted_at: null,
          missing_since: new Date(),
        },
        { path: 'live', filename: 'IMG_9.dng', library_id: libraryId, deleted_at: null },
      ],
      stages: dirtyStagesFixture(),
    } as never);
    setLibraryRootsForTests(new Map([[libraryId.toHexString(), root]]));

    const result = await relocateAsset({
      id,
      mode: 'move',
      collision: 'auto-suffix',
      destinationPath: 'b',
    });

    expect(result.kind).toBe('relocated');
    expect(await read('b/IMG_9.dng')).toBe('pixels');
    const row = await fetchAssetRow(db, id);
    // Only the live entry was repointed; the stale one is untouched.
    expect(row.fileinfo.find((f) => f.path === 'b')?.filename).toBe('IMG_9.dng');
    expect(row.fileinfo.find((f) => f.path === 'stale')).toBeTruthy();
    expect(row.fileinfo.find((f) => f.path === 'live')).toBeUndefined();
  });

  test('sidecar follows the asset relocate end-to-end', async () => {
    if (!db) return;
    await write('a/IMG_1.dng', 'pixels');
    await write('a/IMG_1.xmp', 'edits');
    const { id } = await seedAsset(db, 'a', 'IMG_1.dng');

    const result = await relocateAsset({
      id,
      mode: 'move',
      collision: 'auto-suffix',
      destinationPath: 'b',
    });

    expect(result.kind).toBe('relocated');
    expect(await exists('a/IMG_1.xmp')).toBe(false);
    expect(await read('b/IMG_1.xmp')).toBe('edits');
  });

  test('rename: same directory, new filename (destinationFilename)', async () => {
    if (!db) return;
    await write('a/old-name.dng', 'pixels');
    const { id } = await seedAsset(db, 'a', 'old-name.dng');

    const result = await relocateAsset({
      id,
      mode: 'move',
      collision: 'auto-suffix',
      destinationPath: 'a',
      destinationFilename: 'new-name.dng',
    });

    expect(result.kind).toBe('relocated');
    if (result.kind !== 'relocated') return;
    expect(result.newPath).toBe('a');
    expect(result.newFilename).toBe('new-name.dng');
    expect(await exists('a/old-name.dng')).toBe(false);
    expect(await read('a/new-name.dng')).toBe('pixels');
  });

  test('collision auto-suffix repoints the DB to the ACTUAL suffixed filename', async () => {
    if (!db) return;
    await write('a/IMG_1.dng', 'pixels');
    await write('b/IMG_1.dng', 'occupant');
    const { id } = await seedAsset(db, 'a', 'IMG_1.dng');

    const result = await relocateAsset({
      id,
      mode: 'move',
      collision: 'auto-suffix',
      destinationPath: 'b',
    });

    expect(result.kind).toBe('relocated');
    if (result.kind !== 'relocated') return;
    expect(result.newFilename).toBe('IMG_1.1.dng');
    expect(result.renamedOnCollision).toBe(true);

    const row = await fetchAssetRow(db, id);
    expect(row.fileinfo[0]!.filename).toBe('IMG_1.1.dng');
    expect(await read('b/IMG_1.dng')).toBe('occupant'); // untouched
  });

  test('collision skip: no-op, DB and FS both unchanged', async () => {
    if (!db) return;
    await write('a/IMG_1.dng', 'pixels');
    await write('b/IMG_1.dng', 'occupant');
    const { id } = await seedAsset(db, 'a', 'IMG_1.dng');

    const result = await relocateAsset({
      id,
      mode: 'move',
      collision: 'skip',
      destinationPath: 'b',
    });

    expect(result.kind).toBe('skipped');
    expect(await exists('a/IMG_1.dng')).toBe(true);
    const row = await fetchAssetRow(db, id);
    expect(row.fileinfo[0]!.path).toBe('a'); // DB never touched
  });

  test('a concurrent fileinfo change aborts the repoint and leaves the source untouched (failure direction)', async () => {
    if (!db) return;
    await write('a/IMG_1.dng', 'pixels');
    const { id } = await seedAsset(db, 'a', 'IMG_1.dng');

    // Simulate a race: something else repoints the entry between our read
    // and the relocate's identity-repoint write, so the $elemMatch in
    // onVerified no longer matches anything.
    await db
      .collection('assets')
      .updateOne({ _id: id }, { $set: { 'fileinfo.0.path': 'somewhere-else' } });

    const result = await relocateAsset({
      id,
      mode: 'move',
      collision: 'auto-suffix',
      destinationPath: 'b',
    });

    expect(result.kind).toBe('error');
    // Source untouched — the FS-level revert ran because onVerified threw.
    expect(await exists('a/IMG_1.dng')).toBe(true);
    expect(await read('a/IMG_1.dng')).toBe('pixels');
    expect(await exists('b/IMG_1.dng')).toBe(false);
  });

  test('not-found: unknown asset id', async () => {
    if (!db) return;
    const result = await relocateAsset({
      id: new ObjectId(),
      mode: 'move',
      collision: 'auto-suffix',
      destinationPath: 'b',
    });
    expect(result.kind).toBe('not-found');
  });

  test('#2725: cross-library move lands the file under the DESTINATION library root, not the source root', async () => {
    if (!db) return;
    // A second library, on its own temp root, distinct from `root` (the
    // source library's root that `seedAsset`/`setLibraryRootsForTests`
    // wires up by default).
    const destRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'relocate-asset-dest-'));
    try {
      await write('a/IMG_1.dng', 'pixels');
      const { id, libraryId: sourceLibraryId } = await seedAsset(db, 'a', 'IMG_1.dng');
      const destLibraryId = new ObjectId();
      setLibraryRootsForTests(
        new Map([
          [sourceLibraryId.toHexString(), root],
          [destLibraryId.toHexString(), destRoot],
        ]),
      );

      const result = await relocateAsset({
        id,
        mode: 'move',
        collision: 'auto-suffix',
        destinationPath: 'b',
        destinationLibraryId: destLibraryId,
      });

      expect(result.kind).toBe('relocated');
      if (result.kind !== 'relocated') return;
      expect(result.newPath).toBe('b');
      expect(result.newFilename).toBe('IMG_1.dng');

      // The bug this closes: before #2725 the destination relPath was
      // always resolved under the SOURCE library's root, so the file would
      // have landed at `root/b/IMG_1.dng` instead. Assert it lands under
      // the DESTINATION library's root instead.
      expect(await fs.stat(path.join(destRoot, 'b', 'IMG_1.dng')).then(() => true)).toBe(true);
      expect(
        await fs
          .stat(path.join(root, 'b', 'IMG_1.dng'))
          .then(() => true)
          .catch(() => false),
      ).toBe(false);
      expect(await exists('a/IMG_1.dng')).toBe(false); // source removed (move mode)

      const row = await fetchAssetRow(db, id);
      expect(row.fileinfo[0]!.path).toBe('b');
      expect(row.fileinfo[0]!.filename).toBe('IMG_1.dng');
      const fullRow = (await db.collection('assets').findOne({ _id: id })) as unknown as {
        fileinfo: Array<{ library_id: ObjectId }>;
      };
      // The fileinfo entry's library_id must follow the file to the
      // destination library — otherwise the catalog row claims the OLD
      // library while the bytes live under the new one.
      expect(fullRow.fileinfo[0]!.library_id.toHexString()).toBe(destLibraryId.toHexString());
    } finally {
      await fs.rm(destRoot, { recursive: true, force: true });
    }
  });

  test('#2725: an unknown destinationLibraryId is rejected as invalid, not silently applied under the source root', async () => {
    if (!db) return;
    await write('a/IMG_1.dng', 'pixels');
    const { id } = await seedAsset(db, 'a', 'IMG_1.dng');

    const result = await relocateAsset({
      id,
      mode: 'move',
      collision: 'auto-suffix',
      destinationPath: 'b',
      destinationLibraryId: new ObjectId(), // never registered in the roots cache
    });

    expect(result.kind).toBe('invalid');
    expect(await exists('a/IMG_1.dng')).toBe(true); // untouched
    expect(await exists('b/IMG_1.dng')).toBe(false);
  });

  test('already at destination: skipped without touching disk', async () => {
    if (!db) return;
    await write('a/IMG_1.dng', 'pixels');
    const { id } = await seedAsset(db, 'a', 'IMG_1.dng');

    const result = await relocateAsset({
      id,
      mode: 'move',
      collision: 'auto-suffix',
      destinationPath: 'a',
    });

    expect(result).toEqual({
      kind: 'skipped',
      reason: 'already at destination',
    });
    expect(await read('a/IMG_1.dng')).toBe('pixels');
  });
});

// ---------------------------------------------------------------------------
// Path-traversal defense in depth (jules review on #2669) — relocateAsset
// must reject a hostile destinationPath/destinationFilename itself, not
// merely rely on the HTTP route's own validation, so a future non-HTTP
// caller (or a regression in the route) can't reopen the escape.
// ---------------------------------------------------------------------------

describe('relocateAsset — path traversal is rejected as `invalid`, not attempted', () => {
  test('destinationPath with ../.. traversal is rejected', async () => {
    if (!db) return;
    await write('a/IMG_1.dng', 'pixels');
    const { id } = await seedAsset(db, 'a', 'IMG_1.dng');

    const result = await relocateAsset({
      id,
      mode: 'move',
      collision: 'auto-suffix',
      destinationPath: '../../etc',
    });

    expect(result.kind).toBe('invalid');
    expect(await read('a/IMG_1.dng')).toBe('pixels'); // untouched
  });

  test('an absolute destinationPath is rejected', async () => {
    if (!db) return;
    await write('a/IMG_1.dng', 'pixels');
    const { id } = await seedAsset(db, 'a', 'IMG_1.dng');

    const result = await relocateAsset({
      id,
      mode: 'move',
      collision: 'auto-suffix',
      destinationPath: '/etc',
    });

    expect(result.kind).toBe('invalid');
    expect(await read('a/IMG_1.dng')).toBe('pixels');
  });

  test('a backslash-variant destinationPath is rejected', async () => {
    if (!db) return;
    await write('a/IMG_1.dng', 'pixels');
    const { id } = await seedAsset(db, 'a', 'IMG_1.dng');

    const result = await relocateAsset({
      id,
      mode: 'move',
      collision: 'auto-suffix',
      destinationPath: 'a\\..\\..\\etc',
    });

    expect(result.kind).toBe('invalid');
    expect(await read('a/IMG_1.dng')).toBe('pixels');
  });

  test('a destinationFilename carrying its own traversal is rejected', async () => {
    if (!db) return;
    await write('a/IMG_1.dng', 'pixels');
    const { id } = await seedAsset(db, 'a', 'IMG_1.dng');

    const result = await relocateAsset({
      id,
      mode: 'move',
      collision: 'auto-suffix',
      destinationPath: 'a',
      destinationFilename: '../../../etc/passwd',
    });

    expect(result.kind).toBe('invalid');
    expect(await read('a/IMG_1.dng')).toBe('pixels');
  });

  test('a destinationFilename with an embedded path separator is rejected', async () => {
    if (!db) return;
    await write('a/IMG_1.dng', 'pixels');
    const { id } = await seedAsset(db, 'a', 'IMG_1.dng');

    const result = await relocateAsset({
      id,
      mode: 'move',
      collision: 'auto-suffix',
      destinationPath: 'a',
      destinationFilename: 'sub/IMG_1.dng',
    });

    expect(result.kind).toBe('invalid');
    expect(await read('a/IMG_1.dng')).toBe('pixels');
  });
});
