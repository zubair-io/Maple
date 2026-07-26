/**
 * Tests for the clear-video-screenshot-flags migration (#2325).
 *
 * The code fix stops NEW videos being flagged; it does nothing for videos
 * already carrying the flag, because a stage does not re-run once its
 * version is stamped. The properties worth pinning down, and why each would
 * be a real bug:
 *  - videos are selected, stills are NOT (a still sweep would wrongly clear
 *    real screenshots and re-run describe across the whole library)
 *  - `vision.is_screenshot` is only touched on rows that HAVE a vision
 *    subdoc (a bare $set would fabricate `vision: { is_screenshot: false }`
 *    on heuristic-flagged rows, which is a malformed VisionDoc that would
 *    then shadow the filename heuristic in sidecar-metadata-index)
 *  - the full five-field stage reset, not just `version` (a dead-lettered
 *    row left at `dead: true` is never re-claimed)
 *  - the done-marker terminates the migration
 *  - soft-deleted / missing locations are excluded
 *
 * Skips when MongoDB is unreachable (mirrors the other migration tests).
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { MongoClient, ObjectId, type Db } from 'mongodb';
import {
  clearVideoScreenshotFlags,
  VIDEO_SCREENSHOT_CLEAR_VERSION,
} from './clear-video-screenshot-flags.ts';

const TEST_DB = `maple_test_clear_video_screenshot_${process.pid}`;
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
    console.log('[clear-video-screenshot-flags.test] skipping: MongoDB unreachable');
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

beforeEach(async () => {
  if (!mongoReachable) return;
  await db!.collection('assets').deleteMany({});
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

/** A stage entry in the dead-lettered state — the case a `version`-only
 * reset would silently fail to re-claim. */
function deadStage() {
  return {
    version: 5,
    attempts: 3,
    last_error: 'boom',
    processed_at: new Date().toISOString(),
    dead: true,
  };
}

/** The assets collection carries a unique index on
 * `(fileinfo.library_id, fileinfo.path, fileinfo.filename)`, so every fixture
 * doc in a multi-insert needs its own filename. */
let seq = 0;

function videoDoc(overrides: Record<string, unknown> = {}) {
  const n = ++seq;
  return {
    _id: new ObjectId(),
    maple_id: `clear-video-${n}`,
    fileinfo: [
      {
        path: '2024/Screenshot',
        filename: `Screen Recording 2024-06-01 (${n}).mov`,
        library_id: libId,
        deleted_at: null,
        missing_since: null,
      },
    ],
    is_screenshot: true,
    stages: { describe: deadStage(), meili: deadStage() },
    ...overrides,
  };
}

function stillDoc(overrides: Record<string, unknown> = {}) {
  const n = ++seq;
  return {
    ...videoDoc(),
    maple_id: `clear-still-${n}`,
    fileinfo: [
      {
        path: '2024/Screenshot',
        filename: `Screenshot 2024-06-01 (${n}).png`,
        library_id: libId,
        deleted_at: null,
        missing_since: null,
      },
    ],
    ...overrides,
  };
}

describe('clear-video-screenshot-flags', () => {
  it('clears the flag on a flagged video and stamps the marker', async () => {
    if (!mongoReachable) return;
    const coll = db!.collection('assets');
    const doc = videoDoc();
    await coll.insertOne(doc as never);

    const res = await clearVideoScreenshotFlags.runBatch(100);
    expect(res.processed).toBe(1);
    expect(res.errors).toBe(0);

    const after = await coll.findOne({ _id: doc._id });
    expect(after!.is_screenshot).toBe(false);
    expect(after!.video_screenshot_clear_version).toBe(VIDEO_SCREENSHOT_CLEAR_VERSION);
  });

  it('re-arms describe and meili with the full five-field reset', async () => {
    if (!mongoReachable) return;
    const coll = db!.collection('assets');
    const doc = videoDoc();
    await coll.insertOne(doc as never);

    await clearVideoScreenshotFlags.runBatch(100);

    const after = await coll.findOne({ _id: doc._id });
    for (const stage of ['describe', 'meili']) {
      expect(after!.stages[stage].version).toBe(0);
      expect(after!.stages[stage].attempts).toBe(0);
      expect(after!.stages[stage].last_error).toBe(null);
      expect(after!.stages[stage].processed_at).toBe(null);
      expect(after!.stages[stage].dead).toBe(false);
    }
  });

  it('clears vision.is_screenshot when a vision subdoc exists', async () => {
    if (!mongoReachable) return;
    const coll = db!.collection('assets');
    const doc = videoDoc({
      vision: { caption: 'a UI', is_screenshot: true, subjects: [] },
    });
    await coll.insertOne(doc as never);

    await clearVideoScreenshotFlags.runBatch(100);

    const after = await coll.findOne({ _id: doc._id });
    expect(after!.vision.is_screenshot).toBe(false);
    // The rest of the VisionDoc survives.
    expect(after!.vision.caption).toBe('a UI');
  });

  it('selects a video flagged ONLY in the vision subdoc', async () => {
    if (!mongoReachable) return;
    const coll = db!.collection('assets');
    const doc = videoDoc({
      is_screenshot: false,
      vision: { caption: 'a UI', is_screenshot: true, subjects: [] },
    });
    await coll.insertOne(doc as never);

    const res = await clearVideoScreenshotFlags.runBatch(100);
    expect(res.processed).toBe(1);

    const after = await coll.findOne({ _id: doc._id });
    expect(after!.vision.is_screenshot).toBe(false);
    // The marker and the stage re-arm must land in the SAME write that clears
    // the mirror. If they were split, a failure in between would leave this
    // row matching neither arm of the candidate `$or` on retry — flag right,
    // stages never re-armed, and silently so.
    expect(after!.video_screenshot_clear_version).toBe(VIDEO_SCREENSHOT_CLEAR_VERSION);
    expect(after!.stages.describe.version).toBe(0);
    expect(after!.stages.describe.dead).toBe(false);
    expect(after!.stages.meili.version).toBe(0);
  });

  it('counts a row carrying BOTH flags exactly once', async () => {
    if (!mongoReachable) return;
    const coll = db!.collection('assets');
    const doc = videoDoc({
      is_screenshot: true,
      vision: { caption: 'a UI', is_screenshot: true, subjects: [] },
    });
    await coll.insertOne(doc as never);

    // Handled entirely by the vision-first write; the mirror write must not
    // pick it up again and double-count it.
    const res = await clearVideoScreenshotFlags.runBatch(100);
    expect(res.processed).toBe(1);

    const after = await coll.findOne({ _id: doc._id });
    expect(after!.is_screenshot).toBe(false);
    expect(after!.vision.is_screenshot).toBe(false);
    expect(after!.video_screenshot_clear_version).toBe(VIDEO_SCREENSHOT_CLEAR_VERSION);
  });

  it('does NOT fabricate a vision subdoc on a heuristic-flagged video', async () => {
    if (!mongoReachable) return;
    const coll = db!.collection('assets');
    const doc = videoDoc();
    await coll.insertOne(doc as never);

    await clearVideoScreenshotFlags.runBatch(100);

    const after = await coll.findOne({ _id: doc._id });
    expect(after!.vision).toBeUndefined();
  });

  it('leaves still images alone', async () => {
    if (!mongoReachable) return;
    const coll = db!.collection('assets');
    const doc = stillDoc();
    await coll.insertOne(doc as never);

    await clearVideoScreenshotFlags.runBatch(100);

    const after = await coll.findOne({ _id: doc._id });
    expect(after!.is_screenshot).toBe(true);
    expect(after!.video_screenshot_clear_version).toBeUndefined();
  });

  it('excludes soft-deleted and missing locations', async () => {
    if (!mongoReachable) return;
    const coll = db!.collection('assets');
    const deleted = videoDoc();
    deleted.fileinfo[0].deleted_at = new Date().toISOString() as never;
    const missing = videoDoc();
    missing.fileinfo[0].missing_since = new Date().toISOString() as never;
    await coll.insertMany([deleted, missing] as never);

    await clearVideoScreenshotFlags.runBatch(100);

    expect((await coll.findOne({ _id: deleted._id }))!.is_screenshot).toBe(true);
    expect((await coll.findOne({ _id: missing._id }))!.is_screenshot).toBe(true);
  });

  it('reaches done and is idempotent on a second pass', async () => {
    if (!mongoReachable) return;
    const coll = db!.collection('assets');
    await coll.insertOne(videoDoc() as never);

    await clearVideoScreenshotFlags.runBatch(100);
    expect(await clearVideoScreenshotFlags.countRemaining()).toBe(0);

    const second = await clearVideoScreenshotFlags.runBatch(100);
    expect(second.processed).toBe(0);
    expect(second.errors).toBe(0);
  });

  it('countRemaining reports pending work before the sweep', async () => {
    if (!mongoReachable) return;
    const coll = db!.collection('assets');
    await coll.insertMany([videoDoc(), videoDoc(), stillDoc()] as never);

    // Two videos pending; the still is not a candidate.
    expect(await clearVideoScreenshotFlags.countRemaining()).toBe(2);
  });
});
