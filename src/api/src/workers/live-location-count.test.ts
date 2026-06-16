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
import { MongoClient, ObjectId, type Db } from 'mongodb';

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
