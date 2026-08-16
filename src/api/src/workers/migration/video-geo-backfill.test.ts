/**
 * Integration tests for the two video-GPS-backfill migrations.
 *
 * Covers:
 *  audit-video-geo-backfill:
 *   - candidate selection (live mp4/mov + $elemMatch liveness tie)
 *   - donor closest-in-time pick within ±15 min
 *   - ±15 min boundary (just-in vs just-out)
 *   - same-library scoping (GPS photo in a DIFFERENT library must NOT be borrowed)
 *   - writes NOTHING to asset docs
 *   - idempotency (second runBatch is a no-op: audit doc already exists)
 *   - no-donor case: audit doc with decision: 'no-donor'
 *   - no-timestamp skips logged but not in candidate set
 *
 *  apply-video-geo-backfill:
 *   - 3-step apply writes: exif.gps, geo_inferred, stages.geocode reset, backup_layout_version unset
 *   - idempotency (second runBatch is a no-op: video drops out of exif.gps:null filter)
 *   - no-donor sentinel (geo_backfill_skipped set, video excluded from future batches)
 *
 * Uses a throwaway mongod on MAPLE_MONGO_URI (default: mongodb://localhost:27017),
 * in a dedicated test database — never touches the dev DB. Skips when MongoDB is
 * unreachable.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { MongoClient, ObjectId, type Db } from 'mongodb';
import { LIB_A, LIB_B, videoAsset, photoAsset } from './video-geo-backfill.fixtures.ts';
import { withTestDb } from '../../db/test-db.test-helpers.ts';

// Unique DB per test run to avoid cross-run pollution.
const TEST_DB = withTestDb(`maple_test_video_geo_backfill_${process.pid}`);
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
    console.log('[video-geo-backfill.test] skipping: MongoDB unreachable');
    return;
  }
  db = mongo!.db(TEST_DB);
  await db.dropDatabase();

  // Seed required collections so ensureIndexes won't fail on missing namespaces.
  for (const name of ['users', 'credentials', 'invites', 'refresh_tokens', 'challenges']) {
    await db.createCollection(name).catch(() => undefined);
  }

  // Reset the db singleton so it picks up the test DB env var.
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

// ---------------------------------------------------------------------------
// Tests: audit-video-geo-backfill
// ---------------------------------------------------------------------------

describe('audit-video-geo-backfill', () => {
  it('skips when MongoDB unreachable', async () => {
    if (!mongoReachable) return;
    // If we got here, MongoDB is reachable — this is a sentinel.
    expect(true).toBe(true);
  });

  it('writes audit doc with match decision for a candidate with a nearby donor', async () => {
    if (!mongoReachable || !db) return;

    const assets = db.collection('assets');
    const audit = db.collection('video_geo_backfill_audit');
    await assets.deleteMany({});
    await audit.deleteMany({});

    const videoId = new ObjectId();
    const photoId = new ObjectId();

    const videoTime = '2019-05-18T17:45:35.000Z';
    // Photo is 2 minutes later — well within ±15 min.
    const photoTime = '2019-05-18T17:47:35.000Z';

    await assets.insertMany([
      videoAsset(videoId, { capturedAt: videoTime }),
      photoAsset(photoId, { capturedAt: photoTime }),
    ]);

    const { auditVideoGeoBackfill } = await import('./audit-video-geo-backfill.ts');

    expect(await auditVideoGeoBackfill.countRemaining()).toBe(1);

    const result = await auditVideoGeoBackfill.runBatch(50);
    expect(result.errors).toBe(0);
    expect(result.processed).toBe(1);

    expect(await auditVideoGeoBackfill.countRemaining()).toBe(0);

    const auditDoc = await audit.findOne({ _id: videoId });
    expect(auditDoc).not.toBeNull();
    expect(auditDoc!.decision).toBe('match');
    expect(auditDoc!.donor_id!.toHexString()).toBe(photoId.toHexString());
    expect(auditDoc!.donor_gps).toEqual({ lat: 37.7749, lng: -122.4194 });
    expect(typeof auditDoc!.delta_ms).toBe('number');
    expect(auditDoc!.delta_ms).toBe(2 * 60 * 1000); // 2 minutes

    // Asset doc must NOT have been modified.
    const videoBefore = await assets.findOne({ _id: videoId });
    expect(videoBefore!.exif.gps).toBeNull();
    expect(videoBefore!.geo_inferred).toBeUndefined();
  });

  it('selects closest donor when multiple photos are in the window', async () => {
    if (!mongoReachable || !db) return;

    const assets = db.collection('assets');
    const audit = db.collection('video_geo_backfill_audit');
    await assets.deleteMany({});
    await audit.deleteMany({});

    const videoId = new ObjectId();
    const nearPhotoId = new ObjectId();
    const farPhotoId = new ObjectId();

    const videoTime = '2019-05-18T17:45:00.000Z';
    const nearTime = '2019-05-18T17:46:00.000Z'; // 1 min away
    const farTime = '2019-05-18T17:55:00.000Z'; // 10 min away

    const nearGps = { lat: 10.0, lng: 20.0 };
    const farGps = { lat: 50.0, lng: 60.0 };

    await assets.insertMany([
      videoAsset(videoId, { capturedAt: videoTime }),
      photoAsset(nearPhotoId, { capturedAt: nearTime, gps: nearGps }),
      photoAsset(farPhotoId, { capturedAt: farTime, gps: farGps }),
    ]);

    const { auditVideoGeoBackfill } = await import('./audit-video-geo-backfill.ts');
    await auditVideoGeoBackfill.runBatch(50);

    const auditDoc = await audit.findOne({ _id: videoId });
    expect(auditDoc!.decision).toBe('match');
    expect(auditDoc!.donor_id!.toHexString()).toBe(nearPhotoId.toHexString());
    expect(auditDoc!.donor_gps).toEqual(nearGps);
    expect(auditDoc!.delta_ms).toBe(60_000); // 1 minute
  });

  it('rejects donor just outside the ±15 min window', async () => {
    if (!mongoReachable || !db) return;

    const assets = db.collection('assets');
    const audit = db.collection('video_geo_backfill_audit');
    await assets.deleteMany({});
    await audit.deleteMany({});

    const videoId = new ObjectId();
    const photoId = new ObjectId();

    const videoTime = '2019-05-18T17:45:00.000Z';
    // 15 min + 1 second = just outside the window.
    const photoTime = '2019-05-18T18:00:01.000Z';

    await assets.insertMany([
      videoAsset(videoId, { capturedAt: videoTime }),
      photoAsset(photoId, { capturedAt: photoTime }),
    ]);

    const { auditVideoGeoBackfill } = await import('./audit-video-geo-backfill.ts');
    await auditVideoGeoBackfill.runBatch(50);

    const auditDoc = await audit.findOne({ _id: videoId });
    expect(auditDoc!.decision).toBe('no-donor');
  });

  it('accepts donor at exactly the ±15 min boundary', async () => {
    if (!mongoReachable || !db) return;

    const assets = db.collection('assets');
    const audit = db.collection('video_geo_backfill_audit');
    await assets.deleteMany({});
    await audit.deleteMany({});

    const videoId = new ObjectId();
    const photoId = new ObjectId();

    const videoTime = '2019-05-18T17:45:00.000Z';
    // Exactly 15 minutes = within window ($lte).
    const photoTime = '2019-05-18T18:00:00.000Z';

    await assets.insertMany([
      videoAsset(videoId, { capturedAt: videoTime }),
      photoAsset(photoId, { capturedAt: photoTime }),
    ]);

    const { auditVideoGeoBackfill } = await import('./audit-video-geo-backfill.ts');
    await auditVideoGeoBackfill.runBatch(50);

    const auditDoc = await audit.findOne({ _id: videoId });
    expect(auditDoc!.decision).toBe('match');
    expect(auditDoc!.delta_ms).toBe(15 * 60 * 1000);
  });

  it('does NOT borrow from a GPS photo in a DIFFERENT library', async () => {
    if (!mongoReachable || !db) return;

    const assets = db.collection('assets');
    const audit = db.collection('video_geo_backfill_audit');
    await assets.deleteMany({});
    await audit.deleteMany({});

    const videoId = new ObjectId();
    const photoId = new ObjectId();

    const videoTime = '2019-05-18T17:45:00.000Z';
    const photoTime = '2019-05-18T17:46:00.000Z'; // 1 min — close

    await assets.insertMany([
      videoAsset(videoId, { capturedAt: videoTime, libraryId: LIB_A }),
      // Photo is in a DIFFERENT library.
      photoAsset(photoId, { capturedAt: photoTime, libraryId: LIB_B }),
    ]);

    const { auditVideoGeoBackfill } = await import('./audit-video-geo-backfill.ts');
    await auditVideoGeoBackfill.runBatch(50);

    const auditDoc = await audit.findOne({ _id: videoId });
    expect(auditDoc!.decision).toBe('no-donor');
  });

  it('does NOT borrow GPS from a video donor (donors must be photos)', async () => {
    if (!mongoReachable || !db) return;

    const assets = db.collection('assets');
    const audit = db.collection('video_geo_backfill_audit');
    await assets.deleteMany({});
    await audit.deleteMany({});

    const videoId = new ObjectId();
    const donorVideoId = new ObjectId();
    const videoTime = '2019-05-18T17:45:00.000Z';

    await assets.insertMany([
      videoAsset(videoId, { capturedAt: videoTime }),
      // A *video* (.mov) with GPS in the window — must NOT be selected as a donor.
      videoAsset(donorVideoId, {
        capturedAt: '2019-05-18T17:45:30.000Z',
        gps: { lat: 1, lng: 2 },
        filename: 'other.mov',
      }),
    ]);

    const { auditVideoGeoBackfill } = await import('./audit-video-geo-backfill.ts');
    await auditVideoGeoBackfill.runBatch(50);

    const auditDoc = await audit.findOne({ _id: videoId });
    expect(auditDoc!.decision).toBe('no-donor');
  });

  it('does NOT borrow GPS from an already-inferred asset (no daisy-chaining)', async () => {
    if (!mongoReachable || !db) return;

    const assets = db.collection('assets');
    const audit = db.collection('video_geo_backfill_audit');
    await assets.deleteMany({});
    await audit.deleteMany({});

    const videoId = new ObjectId();
    const inferredId = new ObjectId();
    const videoTime = '2019-05-18T17:45:00.000Z';

    const inferred = photoAsset(inferredId, {
      capturedAt: '2019-05-18T17:45:30.000Z',
      gps: { lat: 1, lng: 2 },
    }) as Record<string, unknown>;
    // Mark the photo as itself inferred — it must be excluded as a donor.
    inferred.geo_inferred = {
      source: 'temporal-neighbor',
      donor_id: new ObjectId(),
      donor_delta_ms: 0,
      at: new Date().toISOString(),
    };

    await assets.insertMany([videoAsset(videoId, { capturedAt: videoTime }), inferred]);

    const { auditVideoGeoBackfill } = await import('./audit-video-geo-backfill.ts');
    await auditVideoGeoBackfill.runBatch(50);

    const auditDoc = await audit.findOne({ _id: videoId });
    expect(auditDoc!.decision).toBe('no-donor');
  });

  it('is idempotent: second runBatch writes no new audit docs', async () => {
    if (!mongoReachable || !db) return;

    const assets = db.collection('assets');
    const audit = db.collection('video_geo_backfill_audit');
    await assets.deleteMany({});
    await audit.deleteMany({});

    const videoId = new ObjectId();
    const photoId = new ObjectId();
    const videoTime = '2019-05-18T17:45:00.000Z';
    const photoTime = '2019-05-18T17:46:00.000Z';

    await assets.insertMany([
      videoAsset(videoId, { capturedAt: videoTime }),
      photoAsset(photoId, { capturedAt: photoTime }),
    ]);

    const { auditVideoGeoBackfill } = await import('./audit-video-geo-backfill.ts');

    const first = await auditVideoGeoBackfill.runBatch(50);
    expect(first.processed).toBe(1);

    const countAfterFirst = await audit.countDocuments({});

    const second = await auditVideoGeoBackfill.runBatch(50);
    expect(second.processed).toBe(0); // nothing remaining

    const countAfterSecond = await audit.countDocuments({});
    expect(countAfterSecond).toBe(countAfterFirst); // no new docs
  });

  it('does not count videos with no captured_at as candidates', async () => {
    if (!mongoReachable || !db) return;

    const assets = db.collection('assets');
    const audit = db.collection('video_geo_backfill_audit');
    await assets.deleteMany({});
    await audit.deleteMany({});

    const noTimestampId = new ObjectId();
    await assets.insertOne(videoAsset(noTimestampId, { capturedAt: null }));

    const { auditVideoGeoBackfill } = await import('./audit-video-geo-backfill.ts');
    expect(await auditVideoGeoBackfill.countRemaining()).toBe(0);

    const result = await auditVideoGeoBackfill.runBatch(50);
    expect(result.processed).toBe(0);

    // No audit doc for no-timestamp video.
    expect(await audit.countDocuments({ _id: noTimestampId })).toBe(0);
  });

  it('skips deleted (non-live) video entries with $elemMatch', async () => {
    if (!mongoReachable || !db) return;

    const assets = db.collection('assets');
    const audit = db.collection('video_geo_backfill_audit');
    await assets.deleteMany({});
    await audit.deleteMany({});

    const videoId = new ObjectId();
    // The fileinfo entry is deleted — not live.
    await assets.insertOne(videoAsset(videoId, { deleted_at: '2024-01-01T00:00:00.000Z' }));

    const { auditVideoGeoBackfill } = await import('./audit-video-geo-backfill.ts');
    expect(await auditVideoGeoBackfill.countRemaining()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: apply-video-geo-backfill
// ---------------------------------------------------------------------------

describe('apply-video-geo-backfill', () => {
  it('applies GPS, geo_inferred, resets geocode stage, unsets backup_layout_version', async () => {
    if (!mongoReachable || !db) return;

    const assets = db.collection('assets');
    await assets.deleteMany({});

    const videoId = new ObjectId();
    const photoId = new ObjectId();

    const videoTime = '2019-05-18T17:45:35.000Z';
    const photoTime = '2019-05-18T17:47:00.000Z'; // 1m25s away

    const gps = { lat: 37.7749, lng: -122.4194 };

    await assets.insertMany([
      videoAsset(videoId, { capturedAt: videoTime, backupLayoutVersion: 4 }),
      photoAsset(photoId, { capturedAt: photoTime, gps }),
    ]);

    const { applyVideoGeoBackfill } = await import('./apply-video-geo-backfill.ts');

    expect(await applyVideoGeoBackfill.countRemaining()).toBe(1);

    const result = await applyVideoGeoBackfill.runBatch(50);
    expect(result.errors).toBe(0);
    expect(result.processed).toBe(1);

    expect(await applyVideoGeoBackfill.countRemaining()).toBe(0);

    const doc = await assets.findOne({ _id: videoId });
    expect(doc).not.toBeNull();

    // 1. GPS set.
    expect(doc!.exif.gps).toEqual(gps);

    // 2. Provenance field set.
    expect(doc!.geo_inferred).not.toBeNull();
    expect(doc!.geo_inferred!.source).toBe('temporal-neighbor');
    expect(doc!.geo_inferred!.donor_id.toHexString()).toBe(photoId.toHexString());
    expect(typeof doc!.geo_inferred!.donor_delta_ms).toBe('number');
    expect(doc!.geo_inferred!.donor_delta_ms).toBe(85_000); // 1m25s

    // 3. stages.geocode reset to version 0.
    expect(doc!.stages!.geocode!.version).toBe(0);
    expect(doc!.stages!.geocode!.attempts).toBe(0);
    expect(doc!.stages!.geocode!.last_error).toBeNull();
    expect(doc!.stages!.geocode!.dead).toBe(false);

    // 4. backup_layout_version unset.
    expect(doc!.backup_layout_version).toBeUndefined();
  });

  it('is idempotent: second runBatch does nothing (video no longer in candidate set)', async () => {
    if (!mongoReachable || !db) return;

    const assets = db.collection('assets');
    await assets.deleteMany({});

    const videoId = new ObjectId();
    const photoId = new ObjectId();

    const videoTime = '2019-05-18T17:45:00.000Z';
    const photoTime = '2019-05-18T17:46:00.000Z';

    await assets.insertMany([
      videoAsset(videoId, { capturedAt: videoTime }),
      photoAsset(photoId, { capturedAt: photoTime }),
    ]);

    const { applyVideoGeoBackfill } = await import('./apply-video-geo-backfill.ts');

    const first = await applyVideoGeoBackfill.runBatch(50);
    expect(first.processed).toBe(1);

    // After GPS is set, the video drops out of exif.gps: null.
    expect(await applyVideoGeoBackfill.countRemaining()).toBe(0);

    const second = await applyVideoGeoBackfill.runBatch(50);
    expect(second.processed).toBe(0);
    expect(second.errors).toBe(0);

    // Verify the geo_inferred field wasn't overwritten.
    const doc = await assets.findOne({ _id: videoId });
    expect(doc!.geo_inferred!.source).toBe('temporal-neighbor');
  });

  it('sets geo_backfill_skipped sentinel when no donor is found', async () => {
    if (!mongoReachable || !db) return;

    const assets = db.collection('assets');
    await assets.deleteMany({});

    const videoId = new ObjectId();
    // No photos at all in this DB run.
    await assets.insertOne(videoAsset(videoId, { capturedAt: '2019-05-18T17:45:00.000Z' }));

    const { applyVideoGeoBackfill } = await import('./apply-video-geo-backfill.ts');

    expect(await applyVideoGeoBackfill.countRemaining()).toBe(1);

    const result = await applyVideoGeoBackfill.runBatch(50);
    expect(result.processed).toBe(1);
    expect(result.errors).toBe(0);

    const doc = await assets.findOne({ _id: videoId });
    // GPS unchanged, sentinel set.
    expect(doc!.exif.gps).toBeNull();
    expect(doc!.geo_backfill_skipped).toBe('no-donor');

    // Now excluded from candidate set.
    expect(await applyVideoGeoBackfill.countRemaining()).toBe(0);
  });

  it('does NOT borrow GPS from a photo in a DIFFERENT library', async () => {
    if (!mongoReachable || !db) return;

    const assets = db.collection('assets');
    await assets.deleteMany({});

    const videoId = new ObjectId();
    const photoId = new ObjectId();

    const videoTime = '2019-05-18T17:45:00.000Z';
    const photoTime = '2019-05-18T17:46:00.000Z';

    await assets.insertMany([
      videoAsset(videoId, { capturedAt: videoTime, libraryId: LIB_A }),
      photoAsset(photoId, { capturedAt: photoTime, libraryId: LIB_B }),
    ]);

    const { applyVideoGeoBackfill } = await import('./apply-video-geo-backfill.ts');
    await applyVideoGeoBackfill.runBatch(50);

    const doc = await assets.findOne({ _id: videoId });
    // GPS should NOT have been set.
    expect(doc!.exif.gps).toBeNull();
    expect(doc!.geo_backfill_skipped).toBe('no-donor');
  });

  it('uses the closest donor (not just any donor) when multiple photos exist', async () => {
    if (!mongoReachable || !db) return;

    const assets = db.collection('assets');
    await assets.deleteMany({});

    const videoId = new ObjectId();
    const nearId = new ObjectId();
    const farId = new ObjectId();

    const videoTime = '2019-05-18T17:45:00.000Z';
    const nearTime = '2019-05-18T17:46:00.000Z'; // 1 min
    const farTime = '2019-05-18T17:55:00.000Z'; // 10 min

    const nearGps = { lat: 10.0, lng: 20.0 };
    const farGps = { lat: 50.0, lng: 60.0 };

    await assets.insertMany([
      videoAsset(videoId, { capturedAt: videoTime }),
      photoAsset(nearId, { capturedAt: nearTime, gps: nearGps }),
      photoAsset(farId, { capturedAt: farTime, gps: farGps }),
    ]);

    const { applyVideoGeoBackfill } = await import('./apply-video-geo-backfill.ts');
    await applyVideoGeoBackfill.runBatch(50);

    const doc = await assets.findOne({ _id: videoId });
    expect(doc!.exif.gps).toEqual(nearGps);
    expect(doc!.geo_inferred!.donor_id.toHexString()).toBe(nearId.toHexString());
  });
});
