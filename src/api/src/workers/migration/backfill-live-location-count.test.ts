/**
 * Tests for the backfill-live-location-count migration.
 *
 * Covers:
 *  - countRemaining: returns 0 when field is present, >0 when absent.
 *  - runBatch: populates live_location_count correctly for:
 *      - single-location live asset (count = 1)
 *      - multi-live asset (count ≥ 2)
 *      - one-live + tombstoned-sibling (missing_since set, count = 1)
 *      - one-live + deleted_at-sibling (count = 1)
 *      - all-tombstoned asset (count = 0)
 *  - Idempotency: re-running leaves already-migrated rows unchanged.
 *
 * Skips when MongoDB is unreachable (mirrors other migration tests).
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { MongoClient, ObjectId, type Db } from 'mongodb';
import { backfillLiveLocationCount } from './backfill-live-location-count.ts';
import { withTestDb } from '../../db/test-db.test-helpers.ts';

const TEST_DB = withTestDb(`maple_test_backfill_llc_${process.pid}`);
const MONGO_URI = process.env.MAPLE_MONGO_URI ?? 'mongodb://localhost:27017';

let mongo: MongoClient | null = null;
let mongoReachable = false;
let db: Db | null = null;

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
    console.log('[backfill-live-location-count.test] skipping: MongoDB unreachable');
    return;
  }
  db = mongo!.db(TEST_DB);
  await db.dropDatabase();
  // ensureIndexes creates collections as a side effect; seed the required
  // ones beforehand so ensureIndexes doesn't fail on missing namespaces.
  for (const name of ['users', 'credentials', 'invites', 'refresh_tokens', 'challenges']) {
    await db.createCollection(name).catch(() => undefined);
  }
  const { closeDb, ensureIndexes } = await import('../../db/client.ts');
  await closeDb();
  await ensureIndexes();
});

afterAll(async () => {
  if (mongo) {
    await mongo.db(TEST_DB).dropDatabase();
    await mongo.close();
  }
  const { closeDb } = await import('../../db/client.ts');
  await closeDb();
});

const libId = new ObjectId();

function makeAsset(
  id: ObjectId,
  fileinfos: Array<{ missing_since?: string | null; deleted_at?: string | null }>,
  withField = false,
) {
  return {
    _id: id,
    maple_id: id.toHexString() + '0'.repeat(32 - 24),
    fileinfo: fileinfos.map((fi) => ({
      path: 'photos',
      filename: `${id.toHexString()}.dng`,
      library_id: libId,
      deleted_at: fi.deleted_at ?? null,
      missing_since: fi.missing_since ?? null,
    })),
    size: 1,
    mtime: 0,
    rating: 0,
    flag: 0,
    color_label: '',
    indexed_at: new Date().toISOString(),
    deleted_at: null,
    ...(withField ? { live_location_count: 999 } : {}),
  };
}

describe('backfillLiveLocationCount migration', () => {
  it('countRemaining returns 0 when all assets already have the field', async () => {
    if (!mongoReachable) return;
    const coll = db!.collection('assets');
    await coll.deleteMany({});
    const id = new ObjectId();
    await coll.insertOne(makeAsset(id, [{}], /* withField */ true) as never);
    const count = await backfillLiveLocationCount.countRemaining();
    expect(count).toBe(0);
  });

  it('countRemaining returns count of assets missing the field', async () => {
    if (!mongoReachable) return;
    const coll = db!.collection('assets');
    await coll.deleteMany({});
    await coll.insertMany([
      makeAsset(new ObjectId(), [{}]) as never,
      makeAsset(new ObjectId(), [{}]) as never,
      makeAsset(new ObjectId(), [{}], /* withField */ true) as never, // already migrated
    ]);
    const count = await backfillLiveLocationCount.countRemaining();
    expect(count).toBe(2);
  });

  it('sets live_location_count = 1 for a single live location', async () => {
    if (!mongoReachable) return;
    const coll = db!.collection('assets');
    await coll.deleteMany({});
    const id = new ObjectId();
    await coll.insertOne(makeAsset(id, [{}]) as never);

    const result = await backfillLiveLocationCount.runBatch(100);
    expect(result.processed).toBe(1);
    expect(result.errors).toBe(0);

    const doc = await coll.findOne({ _id: id });
    expect(doc!.live_location_count).toBe(1);
  });

  it('sets live_location_count = 2 for two live locations', async () => {
    if (!mongoReachable) return;
    const coll = db!.collection('assets');
    await coll.deleteMany({});
    const id = new ObjectId();
    // Two live entries (no tombstone tags)
    await coll.insertOne(makeAsset(id, [{}, {}]) as never);

    await backfillLiveLocationCount.runBatch(100);

    const doc = await coll.findOne({ _id: id });
    expect(doc!.live_location_count).toBe(2);
  });

  it('sets live_location_count = 1 when one of two entries has missing_since (tombstoned sibling)', async () => {
    if (!mongoReachable) return;
    const coll = db!.collection('assets');
    await coll.deleteMany({});
    const id = new ObjectId();
    await coll.insertOne(
      makeAsset(id, [{}, { missing_since: '2026-01-01T00:00:00.000Z' }]) as never,
    );

    await backfillLiveLocationCount.runBatch(100);

    const doc = await coll.findOne({ _id: id });
    // Only 1 live entry (missing_since makes the second non-live)
    expect(doc!.live_location_count).toBe(1);
  });

  it('sets live_location_count = 1 when one of two entries has deleted_at', async () => {
    if (!mongoReachable) return;
    const coll = db!.collection('assets');
    await coll.deleteMany({});
    const id = new ObjectId();
    await coll.insertOne(makeAsset(id, [{}, { deleted_at: '2026-01-01T00:00:00.000Z' }]) as never);

    await backfillLiveLocationCount.runBatch(100);

    const doc = await coll.findOne({ _id: id });
    expect(doc!.live_location_count).toBe(1);
  });

  it('sets live_location_count = 0 when all entries are tombstoned', async () => {
    if (!mongoReachable) return;
    const coll = db!.collection('assets');
    await coll.deleteMany({});
    const id = new ObjectId();
    await coll.insertOne(
      makeAsset(id, [
        { missing_since: '2026-01-01T00:00:00.000Z' },
        { deleted_at: '2026-01-01T00:00:00.000Z' },
      ]) as never,
    );

    await backfillLiveLocationCount.runBatch(100);

    const doc = await coll.findOne({ _id: id });
    expect(doc!.live_location_count).toBe(0);
  });

  it('is idempotent: re-running does not change already-migrated rows', async () => {
    if (!mongoReachable) return;
    const coll = db!.collection('assets');
    await coll.deleteMany({});
    const id = new ObjectId();
    // Pre-set the field at 999 — the migration should skip it (already has the field)
    await coll.insertOne(makeAsset(id, [{}, {}], /* withField */ true) as never);

    await backfillLiveLocationCount.runBatch(100);

    const doc = await coll.findOne({ _id: id });
    // Already had field=999, migration skips rows with the field present
    expect(doc!.live_location_count).toBe(999);
  });

  it('processes multiple assets in one batch', async () => {
    if (!mongoReachable) return;
    const coll = db!.collection('assets');
    await coll.deleteMany({});
    const ids = [new ObjectId(), new ObjectId(), new ObjectId()];
    await coll.insertMany([
      makeAsset(ids[0], [{}]) as never, // 1 live
      makeAsset(ids[1], [{}, {}]) as never, // 2 live
      makeAsset(ids[2], [{ missing_since: '2026-01-01T00:00:00.000Z' }, {}]) as never, // 1 live
    ]);

    const result = await backfillLiveLocationCount.runBatch(100);
    expect(result.processed).toBe(3);

    const docs = await coll.find({ _id: { $in: ids } }).toArray();
    const byId = new Map(docs.map((d) => [d._id.toHexString(), d]));
    expect(byId.get(ids[0].toHexString())!.live_location_count).toBe(1);
    expect(byId.get(ids[1].toHexString())!.live_location_count).toBe(2);
    expect(byId.get(ids[2].toHexString())!.live_location_count).toBe(1);
  });
});
