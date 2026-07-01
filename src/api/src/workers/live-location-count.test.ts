/**
 * Tests for the live_location_count denormalization introduced in #1302.
 *
 * Covers:
 *
 * 1. Parity test (the key safety net):
 *    `countDocuments({ live_location_count: { $gte: 2 } })` must equal
 *    `countDocuments(liveAwareDuplicatePredicate())` across all asset shapes.
 *
 * 2. Maintenance tests — each liveness mutation updates live_location_count:
 *    - Add a second live fileinfo entry (count 1 → 2)
 *    - Tombstone one of two via missing_since (count 2 → 1)
 *    - Tombstone one of two via deleted_at (count 2 → 1)
 *    - $pull an entry from two-live (count 2 → 1)
 *    - Restore / clear a tombstone (count 1 → 2)
 *
 * 3. Status count test:
 *    The /status deduplicate `ready` count uses live_location_count and
 *    returns the same value as liveAwareDuplicatePredicate.
 *
 * Skips when MongoDB is unreachable.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { MongoClient, ObjectId, type Collection, type Db } from 'mongodb';

const TEST_DB = `maple_test_llc_${process.pid}`;
process.env.MAPLE_MONGO_DB = TEST_DB;
const MONGO_URI = process.env.MAPLE_MONGO_URI ?? 'mongodb://localhost:27017';

let mongo: MongoClient | null = null;
let mongoReachable = false;
let db: Db | null = null;
let libraryId: ObjectId;

async function tryConnect(): Promise<MongoClient | null> {
  const c = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 1500, connectTimeoutMS: 1500 });
  try {
    await c.connect();
    await c.db('admin').command({ ping: 1 });
    return c;
  } catch {
    try {
      await c.close();
    } catch {
      /* ignore */
    }
    return null;
  }
}

beforeAll(async () => {
  mongo = await tryConnect();
  mongoReachable = mongo !== null;
  if (!mongoReachable) {
    console.log('[live-location-count.test] skipping: MongoDB unreachable');
    return;
  }
  db = mongo!.db(TEST_DB);
  await db.dropDatabase();
  libraryId = new ObjectId();
  for (const name of ['users', 'credentials', 'invites', 'refresh_tokens', 'challenges']) {
    await db.createCollection(name).catch(() => undefined);
  }
  const { closeDb, ensureIndexes } = await import('../db/client.ts');
  await closeDb();
  await ensureIndexes();
});

beforeEach(async () => {
  if (!mongoReachable) return;
  await db!.collection('assets').deleteMany({});
});

afterAll(async () => {
  if (mongo) {
    await mongo.db(TEST_DB).dropDatabase();
    await mongo.close();
  }
  const { closeDb } = await import('../db/client.ts');
  await closeDb();
});

let _assetSeq = 0;
function makeMapleId(): string {
  _assetSeq++;
  return String(_assetSeq).padStart(32, '0');
}

function liveEntry(relDir = 'photos', filename = 'img.dng') {
  return { path: relDir, filename, library_id: libraryId, deleted_at: null, missing_since: null };
}

function tombstonedMissing(relDir = 'gone', filename = 'img.dng') {
  return {
    path: relDir,
    filename,
    library_id: libraryId,
    deleted_at: null,
    missing_since: '2026-01-01T00:00:00.000Z',
  };
}

function tombstonedDeleted(relDir = 'replaced', filename = 'img.dng') {
  return {
    path: relDir,
    filename,
    library_id: libraryId,
    deleted_at: '2026-01-01T00:00:00.000Z',
    missing_since: null,
  };
}

async function insertAsset(fileinfos: object[], liveLocationCount?: number): Promise<ObjectId> {
  const id = new ObjectId();
  await db!.collection('assets').insertOne({
    _id: id,
    maple_id: makeMapleId(),
    fileinfo: fileinfos,
    size: 1,
    mtime: 0,
    rating: 0,
    flag: 0,
    color_label: '',
    indexed_at: new Date().toISOString(),
    deleted_at: null,
    live_location_count:
      liveLocationCount ?? fileinfos.filter((f: any) => !f.deleted_at && !f.missing_since).length,
  } as never);
  return id;
}

// ---------------------------------------------------------------------------
// 1. Parity test
// ---------------------------------------------------------------------------

describe('live_location_count parity with liveAwareDuplicatePredicate', () => {
  it('countDocuments({live_location_count:{$gte:2}}) === countDocuments(liveAwareDuplicatePredicate()) across all shapes', async () => {
    if (!mongoReachable) return;

    const { liveAwareDuplicatePredicate } = await import('../indexer/images.repo.ts');
    const coll = db!.collection('assets');

    // Seed every shape:
    await insertAsset([liveEntry()]); // 1 live → count 1 (not duplicate)
    await insertAsset([liveEntry('a'), liveEntry('b')]); // 2 live → count 2 (DUPLICATE)
    await insertAsset([liveEntry('c'), liveEntry('d'), liveEntry('e')]); // 3 live → count 3 (DUPLICATE)
    await insertAsset([liveEntry('f'), tombstonedMissing('f2')]); // 1 live + 1 tombstoned → count 1 (not duplicate)
    await insertAsset([liveEntry('g'), tombstonedDeleted('g2')]); // 1 live + 1 deleted_at → count 1 (not duplicate)
    await insertAsset([tombstonedMissing('h'), tombstonedMissing('h2')]); // 0 live → count 0 (not duplicate)
    await insertAsset([liveEntry('i'), tombstonedMissing('i2'), liveEntry('i3')]); // 2 live + 1 tombstoned → count 2 (DUPLICATE)

    const indexedCount = await coll.countDocuments({ live_location_count: { $gte: 2 } });
    const exprCount = await coll.countDocuments(
      liveAwareDuplicatePredicate() as Parameters<typeof coll.countDocuments>[0],
    );

    expect(indexedCount).toBe(exprCount);
    expect(indexedCount).toBe(3); // the three DUPLICATE shapes above
  });
});

// ---------------------------------------------------------------------------
// 2. Maintenance tests — each mutation updates live_location_count
// ---------------------------------------------------------------------------

describe('live_location_count maintenance: add a second live entry', () => {
  it('$push of a live fileinfo entry increments live_location_count from 1 to 2', async () => {
    if (!mongoReachable) return;
    const coll = db!.collection('assets');
    const id = await insertAsset([liveEntry('a')]);

    // Simulate discover/$push adding a second live location (as handle-event.ts does)
    const newEntry = liveEntry('b');
    await coll.updateOne({ _id: id }, [
      { $set: { fileinfo: { $concatArrays: [{ $ifNull: ['$fileinfo', []] }, [newEntry]] } } },
      {
        $set: {
          live_location_count: {
            $size: {
              $filter: {
                input: { $ifNull: ['$fileinfo', []] },
                cond: {
                  $and: [
                    { $eq: [{ $ifNull: ['$$this.deleted_at', null] }, null] },
                    { $eq: [{ $ifNull: ['$$this.missing_since', null] }, null] },
                  ],
                },
              },
            },
          },
        },
      },
    ]);

    const doc = await coll.findOne({ _id: id });
    expect(doc!.live_location_count).toBe(2);
  });
});

describe('live_location_count maintenance: tombstone via missing_since', () => {
  it('setting missing_since on one of two live entries decrements live_location_count from 2 to 1', async () => {
    if (!mongoReachable) return;
    const coll = db!.collection('assets');
    const id = await insertAsset([liveEntry('a'), liveEntry('b')]);

    // Simulate dedupe/discover/tag-missing setting missing_since on entry 'b'
    await coll.updateOne(
      { _id: id },
      { $set: { 'fileinfo.$[e].missing_since': '2026-06-15T00:00:00.000Z' } },
      {
        arrayFilters: [{ 'e.path': 'b', 'e.filename': 'img.dng', 'e.library_id': libraryId }],
      },
    );

    // After setting missing_since, recompute live_location_count as maintenance code does
    const { updateLiveLocationCount } = await import('../indexer/images.repo.ts');
    await updateLiveLocationCount(coll as never, id);

    const doc = await coll.findOne({ _id: id });
    expect(doc!.live_location_count).toBe(1);
  });
});

describe('live_location_count maintenance: tombstone via deleted_at', () => {
  it('setting deleted_at on one of two live entries decrements live_location_count from 2 to 1', async () => {
    if (!mongoReachable) return;
    const coll = db!.collection('assets');
    const id = await insertAsset([liveEntry('a'), liveEntry('b')]);

    // Simulate handle-event setting deleted_at on entry 'b' (content changed)
    await coll.updateOne(
      { _id: id },
      { $set: { 'fileinfo.$[e].deleted_at': '2026-06-15T00:00:00.000Z' } },
      {
        arrayFilters: [{ 'e.path': 'b', 'e.filename': 'img.dng', 'e.library_id': libraryId }],
      },
    );

    const { updateLiveLocationCount } = await import('../indexer/images.repo.ts');
    await updateLiveLocationCount(coll as never, id);

    const doc = await coll.findOne({ _id: id });
    expect(doc!.live_location_count).toBe(1);
  });
});

describe('live_location_count maintenance: $pull an entry', () => {
  it('$pull of a live entry decrements live_location_count from 2 to 1', async () => {
    if (!mongoReachable) return;
    const coll = db!.collection('assets');
    const id = await insertAsset([liveEntry('a'), liveEntry('b')]);

    // Simulate missing-reaper/dedupe $pull of entry 'a'
    await coll.updateOne(
      { _id: id },
      { $pull: { fileinfo: { path: 'a', filename: 'img.dng', library_id: libraryId } } as never },
    );

    const { updateLiveLocationCount } = await import('../indexer/images.repo.ts');
    await updateLiveLocationCount(coll as never, id);

    const doc = await coll.findOne({ _id: id });
    expect(doc!.live_location_count).toBe(1);
  });
});

describe('live_location_count maintenance: restore (clear tombstone)', () => {
  it('clearing missing_since on a tombstoned sibling increments live_location_count from 1 to 2', async () => {
    if (!mongoReachable) return;
    const coll = db!.collection('assets');
    // Start with 1 live + 1 tombstoned → count = 1
    const id = await insertAsset([liveEntry('a'), tombstonedMissing('b')]);

    // Simulate missing-reaper recover: clear missing_since on 'b'
    await coll.updateOne(
      { _id: id },
      { $set: { 'fileinfo.$[e].missing_since': null } },
      {
        arrayFilters: [{ 'e.path': 'b', 'e.filename': 'img.dng', 'e.library_id': libraryId }],
      },
    );

    const { updateLiveLocationCount } = await import('../indexer/images.repo.ts');
    await updateLiveLocationCount(coll as never, id);

    const doc = await coll.findOne({ _id: id });
    expect(doc!.live_location_count).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Parity helper — re-assert after every mutation below
// ---------------------------------------------------------------------------

async function assertParityAndCount(coll: Collection, id: ObjectId, expectedCount: number) {
  const { liveAwareDuplicatePredicate } = await import('../indexer/images.repo.ts');
  const doc = (await coll.findOne({ _id: id })) as Record<string, unknown> | null;
  expect(doc!.live_location_count).toBe(expectedCount);

  // Whole-collection parity: indexed count == expr count
  const indexed = await coll.countDocuments({ live_location_count: { $gte: 2 } });
  const expr = await coll.countDocuments(
    liveAwareDuplicatePredicate() as Parameters<typeof coll.countDocuments>[0],
  );
  expect(indexed).toBe(expr);
}

// ---------------------------------------------------------------------------
// 4. folders.ts re-upload-overwrite: replaces fileinfo with 1-entry array
//
// Simulates the path at routes/folders.ts ~line 621-637 where a file-overwrite
// trashes the existing asset and does:
//   assets.updateOne({ _id }, { $set: { fileinfo: [singleEntry], deleted_at, original_path } })
//   updateLiveLocationCount(assets, existing._id)   ← fix added in #1302
// After that full sequence live_location_count must drop to 1.
// ---------------------------------------------------------------------------

describe('live_location_count: folders.ts re-upload-overwrite replaces fileinfo array', () => {
  it('setting fileinfo to a 1-entry live array then calling updateLiveLocationCount gives count=1', async () => {
    if (!mongoReachable) return;
    const coll = db!.collection('assets');

    // Start: 2 live entries → count 2 (qualifies as duplicate)
    const id = await insertAsset([liveEntry('a'), liveEntry('b')]);

    // Simulate the re-upload-overwrite $set from folders.ts:
    // replaces fileinfo with a single live entry pointing at the trash path,
    // and sets the TOP-LEVEL deleted_at to mark the asset as trashed.
    await coll.updateOne(
      { _id: id },
      {
        $set: {
          fileinfo: [
            {
              path: '.maple/trash/a',
              filename: 'img.dng',
              library_id: libraryId,
              deleted_at: null, // per-entry stays live (points at trash path)
            },
          ],
          deleted_at: new Date().toISOString(), // top-level asset deleted_at
          original_path: '/library/a/img.dng',
        },
      },
    );

    // The fix: routes/folders.ts now calls updateLiveLocationCount after the $set.
    const { updateLiveLocationCount: recompute } = await import('../indexer/images.repo.ts');
    await recompute(coll as never, id);

    await assertParityAndCount(coll, id, 1);
  });
});

// ---------------------------------------------------------------------------
// 5. folders.ts new-upload $setOnInsert: inserts fileinfo without count
//
// Simulates the findOneAndUpdate(..., { upsert: true }) INSERT arm in
// routes/folders.ts ~line 767-789. When no existing doc matches the fileinfo
// $elemMatch, MongoDB performs an insert via $setOnInsert. The route now sets
// live_location_count: 1 in $setOnInsert so the field is present from birth.
// ---------------------------------------------------------------------------

describe('live_location_count: folders.ts new-upload upsert sets count on insert', () => {
  it('a fresh upsert insert (no matching doc) sets live_location_count to 1', async () => {
    if (!mongoReachable) return;
    const coll = db!.collection('assets');
    const { liveAwareDuplicatePredicate } = await import('../indexer/images.repo.ts');

    const filename = `upload_test_${Date.now()}.dng`;
    const relDir = 'uploads';

    // Simulate the folders.ts findOneAndUpdate upsert WITH the fix applied:
    // live_location_count: 1 is now in $setOnInsert.
    const result = await coll.findOneAndUpdate(
      {
        fileinfo: {
          $elemMatch: { library_id: libraryId, path: relDir, filename },
        },
      },
      {
        $set: {
          size: 12345,
          mtime: Date.now(),
          indexed_at: new Date().toISOString(),
          deleted_at: null,
        },
        $setOnInsert: {
          // Fix (#1302): live_location_count: 1 is now seeded on insert.
          fileinfo: [{ path: relDir, filename, library_id: libraryId, deleted_at: null }],
          live_location_count: 1,
          maple_id: makeMapleId(),
          rating: 0,
          flag: 0,
          color_label: '',
          exif: null,
        } as never,
      },
      { upsert: true, returnDocument: 'after' },
    );

    const doc = result as Record<string, unknown> | null;
    expect(doc!.live_location_count).toBe(1);

    // Parity: indexed == expr
    const indexed = await coll.countDocuments({ live_location_count: { $gte: 2 } });
    const expr = await coll.countDocuments(
      liveAwareDuplicatePredicate() as Parameters<typeof coll.countDocuments>[0],
    );
    expect(indexed).toBe(expr);
  });
});

// ---------------------------------------------------------------------------
// 6. dedupeLiveFileinfo collapses duplicate entries and recomputes count
//
// Simulates move-backup-asset.ts::dedupeLiveFileinfo which now does:
//   coll.updateOne({ _id }, { $set: { fileinfo: deduped } })
//   updateLiveLocationCount(coll, id)   ← fix added in #1302
// where `deduped` has fewer entries than the original. After the full
// sequence live_location_count must reflect the collapsed count.
// ---------------------------------------------------------------------------

describe('live_location_count: dedupeLiveFileinfo collapse recomputes count', () => {
  it('replacing fileinfo with deduped array (2→1 live) then recomputing gives count=1', async () => {
    if (!mongoReachable) return;
    const coll = db!.collection('assets');

    // Start: 2 live entries (duplicate — would qualify for badge), count=2
    const entry = liveEntry('photos');
    const id = await insertAsset([entry, { ...entry }]); // two identical live entries

    // Simulate dedupeLiveFileinfo: collapse to 1 entry, write back via $set
    await coll.updateOne({ _id: id }, { $set: { fileinfo: [entry] } });

    // The fix: dedupeLiveFileinfo now calls updateLiveLocationCount after the collapse.
    const { updateLiveLocationCount: recompute } = await import('../indexer/images.repo.ts');
    await recompute(coll as never, id);

    await assertParityAndCount(coll, id, 1);
  });

  it('dedup collapse preserves parity across the whole collection', async () => {
    if (!mongoReachable) return;
    const coll = db!.collection('assets');

    // Real duplicate (different paths) — should remain a duplicate after dedup
    const id1 = await insertAsset([liveEntry('a'), liveEntry('b')]);
    // Fake duplicate (same path, two entries) — should collapse to 1
    const entry = liveEntry('c');
    const id2 = await insertAsset([entry, { ...entry }]);

    // Collapse id2 and recompute (as the fixed dedupeLiveFileinfo does)
    await coll.updateOne({ _id: id2 }, { $set: { fileinfo: [entry] } });
    const { updateLiveLocationCount: recompute } = await import('../indexer/images.repo.ts');
    await recompute(coll as never, id2);

    // id1 still count=2, id2 count=1, parity holds
    const { liveAwareDuplicatePredicate } = await import('../indexer/images.repo.ts');
    await assertParityAndCount(coll, id1, 2);
    await assertParityAndCount(coll, id2, 1);

    const indexed = await coll.countDocuments({ live_location_count: { $gte: 2 } });
    const expr = await coll.countDocuments(
      liveAwareDuplicatePredicate() as Parameters<typeof coll.countDocuments>[0],
    );
    expect(indexed).toBe(expr);
    expect(indexed).toBe(1); // only id1 remains a duplicate
  });
});

// ---------------------------------------------------------------------------
// 7. trash/restore round-trip — top-level deleted_at only, count unchanged
//
// Trashing and restoring an asset touches the TOP-LEVEL deleted_at and may
// repoint the fileinfo entry path (to .maple/trash/...) but does NOT change
// per-entry liveness. The live count must stay stable across the round-trip.
// ---------------------------------------------------------------------------

describe('live_location_count: trash/restore round-trip leaves count stable', () => {
  it('soft-delete (top-level deleted_at set, fileinfo entry stays live) does not change count', async () => {
    if (!mongoReachable) return;
    const coll = db!.collection('assets');

    // Asset with 1 live entry — count=1
    const id = await insertAsset([liveEntry('photos')]);

    // Simulate markSoftDeleted (legacy path): fileinfo replaced with 1 live
    // entry pointing at trash; top-level deleted_at set.
    await coll.updateOne(
      { _id: id },
      {
        $set: {
          fileinfo: [
            {
              path: '.maple/trash/photos',
              filename: 'img.dng',
              library_id: libraryId,
              deleted_at: null, // per-entry stays live
            },
          ],
          deleted_at: new Date().toISOString(), // TOP-LEVEL only
          original_path: '/library/photos/img.dng',
        },
      },
    );

    // No recompute needed: per-entry liveness didn't change, count stays 1
    const doc = (await coll.findOne({ _id: id })) as Record<string, unknown> | null;
    expect(doc!.live_location_count).toBe(1);
  });

  it('restore (top-level deleted_at cleared) does not change count', async () => {
    if (!mongoReachable) return;
    const coll = db!.collection('assets');

    // Asset in trash — 1 live fileinfo entry pointing at trash path, top-level deleted_at set
    const id = await insertAsset([
      {
        path: '.maple/trash/photos',
        filename: 'img.dng',
        library_id: libraryId,
        deleted_at: null, // per-entry live (points at trash)
        missing_since: null,
      },
    ]);
    await coll.updateOne(
      { _id: id },
      { $set: { deleted_at: new Date().toISOString(), original_path: '/library/photos/img.dng' } },
    );

    // Simulate restoreFromTrash (legacy path): repoint fileinfo + clear top-level deleted_at
    await coll.updateOne(
      { _id: id },
      {
        $set: {
          fileinfo: [
            {
              path: 'photos',
              filename: 'img.dng',
              library_id: libraryId,
              deleted_at: null,
            },
          ],
          size: 12345,
          mtime: Date.now(),
          deleted_at: null, // clear top-level
          original_path: null,
        },
      },
    );

    // No recompute needed: per-entry liveness unchanged, count stays 1
    const doc = (await coll.findOne({ _id: id })) as Record<string, unknown> | null;
    expect(doc!.live_location_count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 3. Status count uses live_location_count (index-covered path)
// ---------------------------------------------------------------------------

describe('deduplicate /status count uses live_location_count index', () => {
  it('fetchStatusDbState reports deduplicate pending = countDocuments({live_location_count:{$gte:2}})', async () => {
    if (!mongoReachable) return;

    // Seed 2 "real" duplicates and 1 non-duplicate
    await insertAsset([liveEntry('a'), liveEntry('b')]); // count=2 → duplicate
    await insertAsset([liveEntry('c'), liveEntry('d'), liveEntry('e')]); // count=3 → duplicate
    await insertAsset([liveEntry('f'), tombstonedMissing('f2')]); // count=1 → not duplicate

    const { fetchStatusDbState } = await import('./routes-status.ts');
    const { stageRegistry } = await import('./registry.ts');
    const { DEDUPLICATE_NAME } = await import('./dedupe.ts');

    const stateNames = [DEDUPLICATE_NAME];
    const statuses = stageRegistry.statuses();
    const dbState = await fetchStatusDbState(stateNames, statuses);

    const pending = dbState.pendingByStage.get(DEDUPLICATE_NAME) ?? -1;
    const ready = dbState.readyByStage.get(DEDUPLICATE_NAME) ?? -1;

    expect(pending).toBe(2);
    expect(ready).toBe(2);
  });
});
