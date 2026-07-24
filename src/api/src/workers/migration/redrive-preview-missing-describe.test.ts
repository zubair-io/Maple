/**
 * Tests for the redrive-preview-missing-describe migration (#2179, the
 * one-time backlog drain following the #2177 behavioural fix).
 *
 * Rows whose describe stage terminally skipped with `skip: preview-missing`
 * before the `{ rearm }` result existed (#2177) are stamped done and never
 * re-claimed.
 * This migration resets exactly those rows so the new describe branch decides
 * their fate (re-arm preview on drift, re-skip terminally where no preview can
 * exist).
 *
 * The properties worth pinning down, and why each would be a real bug:
 *  - ONLY rows with the exact `skip: preview-missing` last_error are selected
 *    (a broader sweep would re-run describe — a billable/slow Ollama pass —
 *    across rows that completed fine or skipped for unrelated reasons)
 *  - the full five-field describe reset, not just `version`
 *  - the preview stage is untouched (whether preview needs a re-run is the
 *    describe handler's call; resetting it here would re-render previews that
 *    are present and fine)
 *  - the done-marker terminates the migration (the terminal video case
 *    re-writes the same `skip: preview-missing` string under the new code, so
 *    without the marker the candidate set refills and it loops forever)
 *
 * Skips when MongoDB is unreachable (mirrors the other migration tests).
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { MongoClient, ObjectId, type Db } from 'mongodb';
import {
  redrivePreviewMissingDescribe,
  PREVIEW_MISSING_REDRIVE_VERSION,
} from './redrive-preview-missing-describe.ts';

const TEST_DB = `maple_test_redrive_preview_missing_${process.pid}`;
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
    console.log('[redrive-preview-missing-describe.test] skipping: MongoDB unreachable');
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

function stage(overrides: Record<string, unknown> = {}) {
  return {
    version: 7,
    attempts: 0,
    last_error: null,
    processed_at: new Date().toISOString(),
    dead: false,
    ...overrides,
  };
}

function makeAsset(
  filename: string,
  opts: {
    describeLastError?: string | null;
    redriven?: boolean;
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
        deleted_at: null,
        missing_since: null,
      },
    ],
    size: 1,
    mtime: 0,
    rating: 0,
    flag: 0,
    color_label: '',
    indexed_at: new Date().toISOString(),
    deleted_at: null,
    stages: {
      exif: stage({ version: 1 }),
      thumb: stage({ version: 3 }),
      preview: stage({ version: 4 }),
      describe: stage({ last_error: opts.describeLastError ?? null }),
    },
    ...(opts.redriven ? { preview_missing_redrive_version: PREVIEW_MISSING_REDRIVE_VERSION } : {}),
  };
}

async function reset(): Promise<void> {
  await db!.collection('assets').deleteMany({});
}

describe('redrivePreviewMissingDescribe — selection', () => {
  it('counts only rows skipped on a missing preview', async () => {
    if (!mongoReachable) return;
    await reset();
    await db!
      .collection('assets')
      .insertMany([
        makeAsset('drifted.dng', { describeLastError: 'skip: preview-missing' }),
        makeAsset('captioned.dng'),
        makeAsset('stub.eip', { describeLastError: 'skip: stub-file' }),
        makeAsset('flaky.dng', { describeLastError: 'LLM timeout' }),
      ] as never[]);

    expect(await redrivePreviewMissingDescribe.countRemaining()).toBe(1);
  });

  it('excludes rows already stamped at the current re-drive version', async () => {
    if (!mongoReachable) return;
    await reset();
    await db!
      .collection('assets')
      .insertMany([
        makeAsset('done.dng', { describeLastError: 'skip: preview-missing', redriven: true }),
        makeAsset('todo.dng', { describeLastError: 'skip: preview-missing' }),
      ] as never[]);

    expect(await redrivePreviewMissingDescribe.countRemaining()).toBe(1);
  });
});

describe('redrivePreviewMissingDescribe — runBatch', () => {
  it('resets the describe stage to unprocessed and stamps the marker', async () => {
    if (!mongoReachable) return;
    await reset();
    const coll = db!.collection('assets');
    await coll.insertOne(
      makeAsset('drifted.dng', { describeLastError: 'skip: preview-missing' }) as never,
    );

    const res = await redrivePreviewMissingDescribe.runBatch(50);
    expect(res).toEqual({ processed: 1, errors: 0 });

    const d = (await coll.findOne({}))!;
    expect(d.stages.describe.version).toBe(0);
    expect(d.stages.describe.attempts).toBe(0);
    expect(d.stages.describe.last_error).toBeNull();
    expect(d.stages.describe.processed_at).toBeNull();
    expect(d.stages.describe.dead).toBe(false);
    expect(d.preview_missing_redrive_version).toBe(PREVIEW_MISSING_REDRIVE_VERSION);
  });

  it('leaves the preview stage (and every other stage) untouched', async () => {
    if (!mongoReachable) return;
    await reset();
    const coll = db!.collection('assets');
    await coll.insertOne(
      makeAsset('drifted.dng', { describeLastError: 'skip: preview-missing' }) as never,
    );

    await redrivePreviewMissingDescribe.runBatch(50);

    // Whether preview needs regenerating is the describe handler's call under
    // the new { rearm } branch — the migration itself must not force a
    // re-render of previews that are present and fine.
    const d = (await coll.findOne({}))!;
    expect(d.stages.preview.version).toBe(4);
    expect(d.stages.thumb.version).toBe(3);
    expect(d.stages.exif.version).toBe(1);
  });

  it('does not touch rows that skipped for other reasons or completed', async () => {
    if (!mongoReachable) return;
    await reset();
    const coll = db!.collection('assets');
    await coll.insertMany([
      makeAsset('captioned.dng'),
      makeAsset('stub.eip', { describeLastError: 'skip: stub-file' }),
      makeAsset('sweep.dng', { describeLastError: 'skip: preview-missing' }),
    ] as never[]);

    await redrivePreviewMissingDescribe.runBatch(50);

    const captioned = await coll.findOne({ 'fileinfo.0.filename': 'captioned.dng' });
    expect(captioned!.stages.describe.version).toBe(7);
    expect(captioned!.preview_missing_redrive_version).toBeUndefined();
    const stub = await coll.findOne({ 'fileinfo.0.filename': 'stub.eip' });
    expect(stub!.stages.describe.version).toBe(7);
    expect(stub!.stages.describe.last_error).toBe('skip: stub-file');
  });

  it('honours batchSize', async () => {
    if (!mongoReachable) return;
    await reset();
    await db!
      .collection('assets')
      .insertMany([
        makeAsset('a.dng', { describeLastError: 'skip: preview-missing' }),
        makeAsset('b.dng', { describeLastError: 'skip: preview-missing' }),
        makeAsset('c.dng', { describeLastError: 'skip: preview-missing' }),
      ] as never[]);

    expect((await redrivePreviewMissingDescribe.runBatch(2)).processed).toBe(2);
    expect(await redrivePreviewMissingDescribe.countRemaining()).toBe(1);
  });

  it('converges: a row that re-skips under the new code does not re-enter', async () => {
    if (!mongoReachable) return;
    await reset();
    const coll = db!.collection('assets');
    await coll.insertOne(
      makeAsset('video-no-ffmpeg.mov', { describeLastError: 'skip: preview-missing' }) as never,
    );

    await redrivePreviewMissingDescribe.runBatch(50);
    expect(await redrivePreviewMissingDescribe.countRemaining()).toBe(0);

    // The terminal case (video on a no-ffmpeg host) re-writes the SAME
    // last_error string when describe re-runs. The done-marker is what keeps
    // that out of the candidate set — without it the migration would re-arm
    // the very skip it just caused, forever.
    await coll.updateOne(
      {},
      {
        $set: {
          'stages.describe.version': 7,
          'stages.describe.last_error': 'skip: preview-missing',
        },
      },
    );
    expect(await redrivePreviewMissingDescribe.countRemaining()).toBe(0);
    expect(await redrivePreviewMissingDescribe.runBatch(50)).toEqual({
      processed: 0,
      errors: 0,
    });
  });
});
