/**
 * Tests for the rearm-video-posters migration (#1649).
 *
 * The migration exists because every video in an existing library is already
 * stamped `version = targetVersion` on the thumb / preview / describe / face
 * stages — the pre-#1649 handlers skipped video on extension, and a `skip`
 * marks a stage permanently done. Poster-frame rendering would therefore never
 * run for a single existing video without this reset.
 *
 * The properties worth pinning down, and why each would be a real bug:
 *  - videos are selected, stills are NOT (a still sweep would cascade a
 *    cf-thumb-sync reset across the whole library and re-upload every
 *    thumbnail to R2 — the billable event that ruled out a targetVersion bump)
 *  - the full five-field stage reset, not just `version` (a dead-lettered
 *    asset left at `dead: true` is never re-claimed, so it would silently
 *    never get a poster)
 *  - `exif` is untouched (resetting it would undo `backfill-video-exif`)
 *  - the done-marker terminates the migration (without it the candidate set
 *    refills as soon as the thumb stage re-stamps, and it loops forever)
 *  - soft-deleted / missing locations are excluded
 *
 * Skips when MongoDB is unreachable (mirrors the other migration tests).
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { MongoClient, ObjectId, type Db } from 'mongodb';
import { rearmVideoPosters, VIDEO_POSTER_REARM_VERSION } from './rearm-video-posters.ts';

const TEST_DB = `maple_test_rearm_video_posters_${process.pid}`;
process.env.MAPLE_MONGO_DB = TEST_DB;
const MONGO_URI = process.env.MAPLE_MONGO_URI ?? 'mongodb://localhost:27017';

let mongo: MongoClient | null = null;
let mongoReachable = false;
let db: Db | null = null;

async function tryConnect(): Promise<MongoClient | null> {
  const c = new MongoClient(MONGO_URI, {
    serverSelectionTimeoutMS: 1500,
    connectTimeoutMS: 1500,
  });
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
    console.log('[rearm-video-posters.test] skipping: MongoDB unreachable');
    return;
  }
  db = mongo!.db(TEST_DB);
  await db.dropDatabase();
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

/** A stage entry in the "already processed, done" state every existing video
 * is currently sitting in. */
function doneStage(version = 3) {
  return {
    version,
    attempts: 0,
    last_error: null,
    processed_at: new Date().toISOString(),
    dead: false,
  };
}

function makeAsset(
  filename: string,
  opts: {
    rearmed?: boolean;
    deleted?: boolean;
    missing?: boolean;
    stages?: Record<string, ReturnType<typeof doneStage>>;
  } = {},
) {
  const id = new ObjectId();
  return {
    _id: id,
    maple_id: id.toHexString() + '0'.repeat(32 - 24),
    fileinfo: [
      {
        path: 'media',
        filename,
        library_id: libId,
        deleted_at: opts.deleted ? new Date().toISOString() : null,
        missing_since: opts.missing ? new Date().toISOString() : null,
      },
    ],
    size: 1,
    mtime: 0,
    rating: 0,
    flag: 0,
    color_label: '',
    indexed_at: new Date().toISOString(),
    deleted_at: null,
    stages: opts.stages ?? {
      exif: doneStage(1),
      thumb: doneStage(3),
      preview: doneStage(1),
      describe: doneStage(1),
      'face-detect': doneStage(1),
      'face-embed': doneStage(1),
      'cf-thumb-sync': doneStage(1),
    },
    ...(opts.rearmed ? { video_poster_rearm_version: VIDEO_POSTER_REARM_VERSION } : {}),
  };
}

async function reset(): Promise<void> {
  await db!.collection('assets').deleteMany({});
}

describe('rearmVideoPosters — selection', () => {
  it('counts videos that have not been re-armed, and ignores stills', async () => {
    if (!mongoReachable) return;
    await reset();
    const coll = db!.collection('assets');
    await coll.insertMany([
      makeAsset('IMG_1.MOV'),
      makeAsset('clip.mp4'),
      makeAsset('photo.dng'),
      makeAsset('scan.jpg'),
    ] as never[]);

    expect(await rearmVideoPosters.countRemaining()).toBe(2);
  });

  it('excludes videos already stamped at the current re-arm version', async () => {
    if (!mongoReachable) return;
    await reset();
    await db!
      .collection('assets')
      .insertMany([makeAsset('done.mov', { rearmed: true }), makeAsset('todo.mov')] as never[]);

    expect(await rearmVideoPosters.countRemaining()).toBe(1);
  });

  it('excludes soft-deleted and missing video locations', async () => {
    if (!mongoReachable) return;
    await reset();
    await db!
      .collection('assets')
      .insertMany([
        makeAsset('gone.mov', { deleted: true }),
        makeAsset('vanished.mov', { missing: true }),
      ] as never[]);

    expect(await rearmVideoPosters.countRemaining()).toBe(0);
  });

  it('matches video extensions case-insensitively', async () => {
    if (!mongoReachable) return;
    await reset();
    await db!
      .collection('assets')
      .insertMany([makeAsset('UPPER.MOV'), makeAsset('lower.mkv')] as never[]);

    expect(await rearmVideoPosters.countRemaining()).toBe(2);
  });
});

describe('rearmVideoPosters — runBatch', () => {
  it('resets every poster-dependent stage to unprocessed and stamps the marker', async () => {
    if (!mongoReachable) return;
    await reset();
    const coll = db!.collection('assets');
    await coll.insertOne(makeAsset('IMG_9.MOV') as never);

    const res = await rearmVideoPosters.runBatch(50);
    expect(res).toEqual({ processed: 1, errors: 0 });

    const doc = await coll.findOne({});
    for (const stage of [
      'thumb',
      'preview',
      'describe',
      'face-detect',
      'face-embed',
      'cf-thumb-sync',
    ]) {
      expect(doc!.stages[stage].version).toBe(0);
    }
    expect(doc!.video_poster_rearm_version).toBe(VIDEO_POSTER_REARM_VERSION);
  });

  it('clears attempts / last_error / processed_at / dead, not just version', async () => {
    if (!mongoReachable) return;
    await reset();
    const coll = db!.collection('assets');
    // A video whose thumb stage previously dead-lettered. Resetting `version`
    // alone would leave `dead: true`, and `buildClaimQuery` would never hand
    // this asset to the stage again — it would silently never get a poster.
    await coll.insertOne(
      makeAsset('dead.mov', {
        stages: {
          thumb: {
            version: 3,
            attempts: 5,
            last_error: 'no still frame to thumbnail',
            processed_at: new Date().toISOString(),
            dead: true,
          },
        } as never,
      }) as never,
    );

    await rearmVideoPosters.runBatch(50);

    const t = (await coll.findOne({}))!.stages.thumb;
    expect(t.version).toBe(0);
    expect(t.attempts).toBe(0);
    expect(t.last_error).toBeNull();
    expect(t.processed_at).toBeNull();
    expect(t.dead).toBe(false);
  });

  it('leaves the exif stage untouched', async () => {
    if (!mongoReachable) return;
    await reset();
    const coll = db!.collection('assets');
    await coll.insertOne(makeAsset('has-exif.mov') as never);

    await rearmVideoPosters.runBatch(50);

    // Video EXIF is owned by backfill-video-exif (#1525). Resetting it here
    // would re-run that migration's work and could re-file the asset.
    expect((await coll.findOne({}))!.stages.exif.version).toBe(1);
  });

  it('does not touch stills', async () => {
    if (!mongoReachable) return;
    await reset();
    const coll = db!.collection('assets');
    await coll.insertMany([makeAsset('keep.dng'), makeAsset('sweep.mov')] as never[]);

    await rearmVideoPosters.runBatch(50);

    const still = await coll.findOne({ 'fileinfo.0.filename': 'keep.dng' });
    expect(still!.stages.thumb.version).toBe(3);
    expect(still!.video_poster_rearm_version).toBeUndefined();
  });

  it('honours batchSize', async () => {
    if (!mongoReachable) return;
    await reset();
    await db!
      .collection('assets')
      .insertMany([makeAsset('a.mov'), makeAsset('b.mov'), makeAsset('c.mov')] as never[]);

    expect((await rearmVideoPosters.runBatch(2)).processed).toBe(2);
    expect(await rearmVideoPosters.countRemaining()).toBe(1);
  });

  it('converges: a second pass finds nothing and is a no-op', async () => {
    if (!mongoReachable) return;
    await reset();
    const coll = db!.collection('assets');
    await coll.insertOne(makeAsset('once.mov') as never);

    await rearmVideoPosters.runBatch(50);
    expect(await rearmVideoPosters.countRemaining()).toBe(0);

    // The done-marker is what terminates this. Simulating the thumb stage
    // re-stamping the asset after it renders a poster must NOT put it back in
    // the candidate set — without the marker the migration would loop forever,
    // re-arming the very work it just caused.
    await coll.updateOne({}, { $set: { 'stages.thumb.version': 3 } });
    expect(await rearmVideoPosters.countRemaining()).toBe(0);

    expect(await rearmVideoPosters.runBatch(50)).toEqual({
      processed: 0,
      errors: 0,
    });
  });
});
