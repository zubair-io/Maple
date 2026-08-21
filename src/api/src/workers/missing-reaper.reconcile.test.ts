/**
 * reapRow tests (#2977) — the reaper's terminal action is a SOFT delete:
 * `deleted_at` + `deleted_reason: 'reaped'` set on the surviving record,
 * guarded against a concurrent revive and against double-soft-delete.
 * Integration tests against a real Mongo (skip-pass when unreachable,
 * mirroring missing-reaper.test.ts).
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { MongoClient, ObjectId, type Db } from 'mongodb';
import { withTestDb } from '../db/test-db.test-helpers.ts';

const TEST_DB = withTestDb(`maple_test_reapreconcile_${process.pid}`);
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
    console.log('[missing-reaper.reconcile.test] skipping: MongoDB unreachable');
    return;
  }
  db = mongo!.db(TEST_DB);
  await db.dropDatabase();
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

const ASSET_BASE = {
  size: 1,
  mtime: 0,
  rating: 0,
  flag: 0,
  color_label: '',
  indexed_at: '2026-05-11T00:00:00Z',
  stages: {},
};

function goneEntry(libId: ObjectId, filename: string, missingIso: string) {
  return {
    library_id: libId,
    path: 'sub',
    filename,
    deleted_at: null,
    missing_since: missingIso,
    missing_reason: 'enoent',
  };
}

describe('reapRow', () => {
  it('soft-deletes an all-gone row instead of removing it', async () => {
    if (!mongoReachable) return;
    const { assetsCollection } = await import('../db/client.ts');
    const { reapRow } = await import('./missing-reaper.reconcile.ts');
    const coll = await assetsCollection();
    const libId = new ObjectId();
    const _id = new ObjectId();
    await coll.insertOne({
      ...ASSET_BASE,
      _id,
      maple_id: 'reap-test-1',
      fileinfo: [goneEntry(libId, 'a.dng', '2026-01-01T00:00:00.000Z')],
      deleted_at: null,
    } as never);
    const reaped = await reapRow(coll, (await coll.findOne({ _id }))! as never);
    expect(reaped).toBe(true);
    const after = await coll.findOne({ _id });
    expect(after).not.toBeNull();
    expect(typeof after!.deleted_at).toBe('string');
    expect((after as { deleted_reason?: string }).deleted_reason).toBe('reaped');
    // fileinfo untouched — kept for revive matching + Trash display.
    expect(after!.fileinfo).toHaveLength(1);
  });

  it('is a no-op when the row regained a live entry (concurrent revive guard)', async () => {
    if (!mongoReachable) return;
    const { assetsCollection } = await import('../db/client.ts');
    const { reapRow } = await import('./missing-reaper.reconcile.ts');
    const coll = await assetsCollection();
    const libId = new ObjectId();
    const _id = new ObjectId();
    await coll.insertOne({
      ...ASSET_BASE,
      _id,
      maple_id: 'reap-test-2',
      fileinfo: [goneEntry(libId, 'b.dng', '2026-01-01T00:00:00.000Z')],
      deleted_at: null,
    } as never);
    const stale = (await coll.findOne({ _id }))! as never;
    // Simulate discover reviving the location AFTER classification.
    await coll.updateOne(
      { _id },
      { $set: { 'fileinfo.0.missing_since': null, 'fileinfo.0.missing_reason': null } },
    );
    const reaped = await reapRow(coll, stale);
    expect(reaped).toBe(false);
    const after = await coll.findOne({ _id });
    expect(after!.deleted_at).toBeNull();
    expect((after as { deleted_reason?: string }).deleted_reason).toBeUndefined();
  });

  it('is a no-op on an already user-trashed row', async () => {
    if (!mongoReachable) return;
    const { assetsCollection } = await import('../db/client.ts');
    const { reapRow } = await import('./missing-reaper.reconcile.ts');
    const coll = await assetsCollection();
    const libId = new ObjectId();
    const _id = new ObjectId();
    await coll.insertOne({
      ...ASSET_BASE,
      _id,
      maple_id: 'reap-test-3',
      fileinfo: [goneEntry(libId, 'c.dng', '2026-01-01T00:00:00.000Z')],
      deleted_at: '2026-08-01T00:00:00.000Z',
      original_path: '/lib/sub/c.dng',
    } as never);
    const reaped = await reapRow(coll, (await coll.findOne({ _id }))! as never);
    expect(reaped).toBe(false);
    const after = await coll.findOne({ _id });
    expect(after!.deleted_at).toBe('2026-08-01T00:00:00.000Z');
    expect((after as { deleted_reason?: string }).deleted_reason).toBeUndefined();
  });
});
