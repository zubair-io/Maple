/**
 * EXIF stage — merge-on-collision tests for `tryMergeWithExistingPrimary`.
 *
 * Covers the runtime safety net the handler reaches for when a maple_id
 * upgrade would collide with an existing row's primary id (E11000 on the
 * unique partial index). The expected behaviour mirrors the boot-time
 * `mergeDuplicateAssets` heal in `db/migrations.ts` but applies one row
 * at a time as duplicates surface from the worker queue. See
 * `workers/stages/exif.ts` for the production call site.
 *
 * Requires: MAPLE_MONGO_URI (or a local MongoDB on localhost:27017).
 * Skips gracefully when Mongo is unreachable.
 */
import { describe, expect, it, beforeAll, afterAll } from 'bun:test';
import { ObjectId, MongoClient, type Db } from 'mongodb';
import { tryConnect } from '../discover/_test-helpers.ts';

const TEST_DB = `maple_test_exif_merge_${process.pid}`;
process.env.MAPLE_MONGO_DB = TEST_DB;

let mongo: MongoClient | null = null;
let mongoReachable = false;
let db: Db | null = null;

beforeAll(async () => {
  mongo = await tryConnect();
  mongoReachable = mongo !== null;
  if (!mongoReachable) {
    console.log('[exif.merge.test] skipping: MongoDB unreachable');
    return;
  }
  db = mongo!.db(TEST_DB);
  await db.dropDatabase();
  const { closeDb } = await import('../../db/client.ts');
  await closeDb();
});

afterAll(async () => {
  if (mongo) {
    try {
      await mongo.db(TEST_DB).dropDatabase();
    } catch {}
    try {
      await mongo.close();
    } catch {}
  }
  const { closeDb } = await import('../../db/client.ts');
  await closeDb();
});

describe('exif stage — tryMergeWithExistingPrimary', () => {
  it('returns null when no other row owns the new maple_id', async () => {
    if (!mongoReachable) return;
    const { assetsCollection } = await import('../../db/client.ts');
    const { __exifTestInternals } = await import('./exif.ts');
    const coll = await assetsCollection();

    const loser = {
      _id: new ObjectId(),
      maple_id: '02' + 'a'.repeat(30),
      fileinfo: [
        {
          library_id: new ObjectId(),
          path: 'a',
          filename: 'IMG.jpg',
          deleted_at: null,
        },
      ],
    };
    const newId = '01' + 'b'.repeat(30);
    await coll.deleteMany({ maple_id: { $in: [loser.maple_id, newId] } });
    await coll.insertOne(loser as never);

    const result = await __exifTestInternals.tryMergeWithExistingPrimary(loser as never, newId);
    expect(result).toBeNull();
    // Loser row still exists, untouched.
    const stillThere = await coll.findOne({ _id: loser._id });
    expect(stillThere).not.toBeNull();

    await coll.deleteMany({ maple_id: { $in: [loser.maple_id, newId] } });
  });

  it('merges fileinfo into the winner and deletes the loser when the new id collides', async () => {
    if (!mongoReachable) return;
    const { assetsCollection } = await import('../../db/client.ts');
    const { __exifTestInternals } = await import('./exif.ts');
    const coll = await assetsCollection();

    const libraryId = new ObjectId();
    const collidingId = '01' + 'c'.repeat(30);
    const winner = {
      _id: new ObjectId(),
      maple_id: collidingId,
      fileinfo: [
        { library_id: libraryId, path: 'a', filename: 'IMG.jpg', deleted_at: null },
      ],
    };
    const loser = {
      _id: new ObjectId(),
      maple_id: '02' + 'd'.repeat(30),
      fileinfo: [
        { library_id: libraryId, path: 'b', filename: 'IMG.jpg', deleted_at: null },
      ],
    };
    await coll.deleteMany({ maple_id: { $in: [winner.maple_id, loser.maple_id] } });
    await coll.insertMany([winner, loser] as never);

    const result = await __exifTestInternals.tryMergeWithExistingPrimary(
      loser as never,
      collidingId,
    );
    expect(result).not.toBeNull();
    expect(result!.equals(winner._id)).toBe(true);

    // Winner now carries both locations; loser is gone.
    const survivingWinner = await coll.findOne({ _id: winner._id });
    expect(survivingWinner).not.toBeNull();
    const entries = (survivingWinner!.fileinfo ?? [])
      .map((e: any) => `${e.path}/${e.filename}`)
      .sort();
    expect(entries).toEqual(['a/IMG.jpg', 'b/IMG.jpg']);
    const deadLoser = await coll.findOne({ _id: loser._id });
    expect(deadLoser).toBeNull();

    await coll.deleteMany({ maple_id: { $in: [winner.maple_id, loser.maple_id] } });
  });

  it('prefers live fileinfo entries over tombstones when both rows reference the same location', async () => {
    if (!mongoReachable) return;
    const { assetsCollection } = await import('../../db/client.ts');
    const { __exifTestInternals } = await import('./exif.ts');
    const coll = await assetsCollection();

    const libraryId = new ObjectId();
    const collidingId = '01' + 'e'.repeat(30);
    // Winner has the shared location tombstoned. Loser still considers
    // it live. Merge must surface the live entry.
    const winner = {
      _id: new ObjectId(),
      maple_id: collidingId,
      fileinfo: [
        {
          library_id: libraryId,
          path: 'shared',
          filename: 'IMG.jpg',
          deleted_at: '2026-05-01T00:00:00.000Z',
        },
      ],
    };
    const loser = {
      _id: new ObjectId(),
      maple_id: '02' + 'f'.repeat(30),
      fileinfo: [
        { library_id: libraryId, path: 'shared', filename: 'IMG.jpg', deleted_at: null },
      ],
    };
    await coll.deleteMany({ maple_id: { $in: [winner.maple_id, loser.maple_id] } });
    await coll.insertMany([winner, loser] as never);

    await __exifTestInternals.tryMergeWithExistingPrimary(loser as never, collidingId);
    const merged = await coll.findOne({ _id: winner._id });
    const list = (merged!.fileinfo ?? []) as Array<{ deleted_at?: string | null }>;
    expect(list).toHaveLength(1);
    expect(list[0]!.deleted_at ?? null).toBeNull();

    await coll.deleteMany({ maple_id: { $in: [winner.maple_id, loser.maple_id] } });
  });
});
