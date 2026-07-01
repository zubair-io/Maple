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
import type { MongoClient } from 'mongodb';
import { ObjectId, type Db } from 'mongodb';
import { tryConnect } from '../discover/_test-helpers.ts';

const TEST_DB = `maple_test_exif_merge_${process.pid}`;
process.env.MAPLE_MONGO_DB = TEST_DB;

let mongo: MongoClient | null = null;
let mongoReachable = false;
let db: Db | null = null;

const NO_LOSER_CONTRIBUTION = { exif: null, is_screenshot: false };

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

  // Mirror the production unique partial index on `maple_id` (see
  // db/client.ts `maple_id_gt_1`). Without it the merge could transiently
  // hold the same primary id on two rows and silently pass — exactly the
  // gap that let the E11000-on-upgrade ordering bug ship. With the index in
  // place the "loser is survivor" case fails loudly unless the condemned row
  // is deleted before the survivor claims the id.
  await db
    .collection('assets')
    .createIndex(
      { maple_id: 1 },
      { name: 'maple_id_gt_1', unique: true, partialFilterExpression: { maple_id: { $gt: '' } } },
    );
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
      indexed_at: '2026-05-01T00:00:00.000Z',
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

    const result = await __exifTestInternals.tryMergeWithExistingPrimary(
      loser as never,
      newId,
      NO_LOSER_CONTRIBUTION,
    );
    expect(result).toBeNull();
    // Loser row still exists, untouched.
    const stillThere = await coll.findOne({ _id: loser._id });
    expect(stillThere).not.toBeNull();

    await coll.deleteMany({ maple_id: { $in: [loser.maple_id, newId] } });
  });

  it('merges fileinfo into the survivor and deletes the condemned when the new id collides', async () => {
    if (!mongoReachable) return;
    const { assetsCollection } = await import('../../db/client.ts');
    const { __exifTestInternals } = await import('./exif.ts');
    const coll = await assetsCollection();

    const libraryId = new ObjectId();
    const collidingId = '01' + 'c'.repeat(30);
    // Other-row indexed_at is earlier → survives.
    const other = {
      _id: new ObjectId(),
      maple_id: collidingId,
      indexed_at: '2026-04-01T00:00:00.000Z',
      fileinfo: [{ library_id: libraryId, path: 'a', filename: 'IMG.jpg', deleted_at: null }],
    };
    const loser = {
      _id: new ObjectId(),
      maple_id: '02' + 'd'.repeat(30),
      indexed_at: '2026-05-01T00:00:00.000Z',
      fileinfo: [{ library_id: libraryId, path: 'b', filename: 'IMG.jpg', deleted_at: null }],
    };
    await coll.deleteMany({ maple_id: { $in: [other.maple_id, loser.maple_id] } });
    await coll.insertMany([other, loser] as never);

    const result = await __exifTestInternals.tryMergeWithExistingPrimary(
      loser as never,
      collidingId,
      NO_LOSER_CONTRIBUTION,
    );
    expect(result).not.toBeNull();
    expect(result!.equals(other._id)).toBe(true);

    // Survivor (other) now carries both locations; loser is gone.
    const survivor = await coll.findOne({ _id: other._id });
    expect(survivor).not.toBeNull();
    const entries = (survivor!.fileinfo ?? []).map((e: any) => `${e.path}/${e.filename}`).sort();
    expect(entries).toEqual(['a/IMG.jpg', 'b/IMG.jpg']);
    const deadLoser = await coll.findOne({ _id: loser._id });
    expect(deadLoser).toBeNull();

    await coll.deleteMany({ maple_id: { $in: [other.maple_id, loser.maple_id] } });
  });

  it('picks the older row as survivor and writes the maple_id upgrade when the loser is older', async () => {
    if (!mongoReachable) return;
    const { assetsCollection } = await import('../../db/client.ts');
    const { __exifTestInternals } = await import('./exif.ts');
    const coll = await assetsCollection();

    const libraryId = new ObjectId();
    const collidingId = '01' + 'a'.repeat(30);
    // The OTHER row is newer than the loser — survivor pick by indexed_at
    // means the loser survives, and tryMergeWithExistingPrimary writes the
    // upgraded maple_id onto it.
    const other = {
      _id: new ObjectId(),
      maple_id: collidingId,
      indexed_at: '2026-05-15T00:00:00.000Z',
      fileinfo: [{ library_id: libraryId, path: 'newer', filename: 'IMG.jpg', deleted_at: null }],
    };
    const loser = {
      _id: new ObjectId(),
      maple_id: '02' + '1'.repeat(30),
      indexed_at: '2026-01-01T00:00:00.000Z',
      rating: 5,
      flag: 1,
      color_label: 'red',
      fileinfo: [{ library_id: libraryId, path: 'older', filename: 'IMG.jpg', deleted_at: null }],
    };
    await coll.deleteMany({ maple_id: { $in: [other.maple_id, loser.maple_id] } });
    await coll.insertMany([other, loser] as never);

    const result = await __exifTestInternals.tryMergeWithExistingPrimary(
      loser as never,
      collidingId,
      NO_LOSER_CONTRIBUTION,
    );
    expect(result).not.toBeNull();
    expect(result!.equals(loser._id)).toBe(true);

    const survivor = await coll.findOne({ _id: loser._id });
    expect(survivor).not.toBeNull();
    expect((survivor as { maple_id?: string }).maple_id).toBe(collidingId);
    // User-edited fields kept (they were already on the survivor).
    expect((survivor as { rating?: number }).rating).toBe(5);
    expect((survivor as { flag?: number }).flag).toBe(1);
    expect((survivor as { color_label?: string }).color_label).toBe('red');
    // Both locations now on the survivor.
    const entries = ((survivor!.fileinfo ?? []) as Array<{ path: string; filename: string }>)
      .map((e) => `${e.path}/${e.filename}`)
      .sort();
    expect(entries).toEqual(['newer/IMG.jpg', 'older/IMG.jpg']);
    // The newer row is gone.
    const condemned = await coll.findOne({ _id: other._id });
    expect(condemned).toBeNull();

    await coll.deleteMany({ maple_id: { $in: [collidingId, loser.maple_id] } });
  });

  it('migrates user-edited fields (rating, flag, color_label) from condemned onto a default survivor', async () => {
    if (!mongoReachable) return;
    const { assetsCollection } = await import('../../db/client.ts');
    const { __exifTestInternals } = await import('./exif.ts');
    const coll = await assetsCollection();

    const libraryId = new ObjectId();
    const collidingId = '01' + '5'.repeat(30);
    // Survivor (older) has defaults; condemned (newer, loser) has user edits.
    // The user-edits-on-loser scenario is rare but real: a user rates a
    // freshly-discovered duplicate before its exif stage finishes.
    const other = {
      _id: new ObjectId(),
      maple_id: collidingId,
      indexed_at: '2026-04-01T00:00:00.000Z',
      rating: 0,
      flag: 0,
      color_label: '',
      fileinfo: [{ library_id: libraryId, path: 'a', filename: 'IMG.jpg', deleted_at: null }],
    };
    const loser = {
      _id: new ObjectId(),
      maple_id: '02' + '6'.repeat(30),
      indexed_at: '2026-05-01T00:00:00.000Z',
      rating: 4,
      flag: 1,
      color_label: 'green',
      fileinfo: [{ library_id: libraryId, path: 'b', filename: 'IMG.jpg', deleted_at: null }],
    };
    await coll.deleteMany({ maple_id: { $in: [other.maple_id, loser.maple_id] } });
    await coll.insertMany([other, loser] as never);

    await __exifTestInternals.tryMergeWithExistingPrimary(
      loser as never,
      collidingId,
      NO_LOSER_CONTRIBUTION,
    );
    const survivor = await coll.findOne({ _id: other._id });
    expect(survivor).not.toBeNull();
    expect((survivor as { rating?: number }).rating).toBe(4);
    expect((survivor as { flag?: number }).flag).toBe(1);
    expect((survivor as { color_label?: string }).color_label).toBe('green');

    await coll.deleteMany({ maple_id: { $in: [other.maple_id, loser.maple_id] } });
  });

  it('writes the freshly-computed exif from the loser when the survivor has none', async () => {
    if (!mongoReachable) return;
    const { assetsCollection } = await import('../../db/client.ts');
    const { __exifTestInternals } = await import('./exif.ts');
    const coll = await assetsCollection();

    const libraryId = new ObjectId();
    const collidingId = '01' + '7'.repeat(30);
    const other = {
      _id: new ObjectId(),
      maple_id: collidingId,
      indexed_at: '2026-04-01T00:00:00.000Z',
      exif: null,
      fileinfo: [{ library_id: libraryId, path: 'a', filename: 'IMG.jpg', deleted_at: null }],
    };
    const loser = {
      _id: new ObjectId(),
      maple_id: '02' + '8'.repeat(30),
      indexed_at: '2026-05-01T00:00:00.000Z',
      fileinfo: [{ library_id: libraryId, path: 'b', filename: 'IMG.jpg', deleted_at: null }],
    };
    await coll.deleteMany({ maple_id: { $in: [other.maple_id, loser.maple_id] } });
    await coll.insertMany([other, loser] as never);

    const freshExif = {
      captured_at: '2024-01-01T12:00:00.000Z',
      captured_year: 2024,
      captured_month: 1,
      camera_make: 'Hasselblad',
      camera_model: 'L3D-100c',
      lens: null,
      iso: 100,
      aperture: 5.6,
      shutter: '1/250',
      focal_length: 24,
      gps: null,
    };
    await __exifTestInternals.tryMergeWithExistingPrimary(loser as never, collidingId, {
      exif: freshExif,
      is_screenshot: false,
    });
    const survivor = await coll.findOne({ _id: other._id });
    expect(survivor).not.toBeNull();
    expect((survivor as { exif?: { camera_make: string } | null }).exif?.camera_make).toBe(
      'Hasselblad',
    );

    await coll.deleteMany({ maple_id: { $in: [other.maple_id, loser.maple_id] } });
  });

  it('prefers live fileinfo entries over tombstones when both rows reference the same location', async () => {
    if (!mongoReachable) return;
    const { assetsCollection } = await import('../../db/client.ts');
    const { __exifTestInternals } = await import('./exif.ts');
    const coll = await assetsCollection();

    const libraryId = new ObjectId();
    const collidingId = '01' + 'e'.repeat(30);
    // Survivor (other, older) has the shared location tombstoned. Loser
    // (newer) considers it live. Merge must surface the live entry on the
    // survivor.
    const other = {
      _id: new ObjectId(),
      maple_id: collidingId,
      indexed_at: '2026-04-01T00:00:00.000Z',
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
      indexed_at: '2026-05-15T00:00:00.000Z',
      fileinfo: [{ library_id: libraryId, path: 'shared', filename: 'IMG.jpg', deleted_at: null }],
    };
    await coll.deleteMany({ maple_id: { $in: [other.maple_id, loser.maple_id] } });
    await coll.insertMany([other, loser] as never);

    await __exifTestInternals.tryMergeWithExistingPrimary(
      loser as never,
      collidingId,
      NO_LOSER_CONTRIBUTION,
    );
    const merged = await coll.findOne({ _id: other._id });
    const list = (merged!.fileinfo ?? []) as Array<{ deleted_at?: string | null }>;
    expect(list).toHaveLength(1);
    expect(list[0]!.deleted_at ?? null).toBeNull();

    await coll.deleteMany({ maple_id: { $in: [other.maple_id, loser.maple_id] } });
  });
});
