/**
 * Vector-coverage carry-forward across a document-shape change (#2384).
 *
 * The pure prefix parsing is unit-tested in
 * `src/enrichment/meilisearch-vector-coverage.test.ts`. This file exercises
 * the Mongo `$regex` query that actually decides which rows keep their
 * coverage, because that is where a mistake would hide: `advanceKnownVectorCoverage`
 * runs unconditionally on every boot (`meilisearch-http-bootstrap.ts`), so a
 * too-permissive filter silently marks the whole library as vectorized under
 * a template it was never embedded with — 100% coverage over empty
 * transcripts, and nothing left for the operator to backfill.
 *
 * Skip-passes when MongoDB is unreachable, matching the sibling suites.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { MongoClient, ObjectId, type Db } from 'mongodb';

const TEST_DB = `maple_test_meili_coverage_shape_${process.pid}`;
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
    } catch {}
    return null;
  }
}

beforeAll(async () => {
  mongo = await tryConnect();
  mongoReachable = mongo !== null;
  if (!mongoReachable) {
    console.log('[meilisearch-vector-coverage-shape.test] skipping: MongoDB unreachable');
    return;
  }
  db = mongo!.db(TEST_DB);
  await db.dropDatabase();
  const { closeDb } = await import('../src/db/client.ts');
  await closeDb();
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
  const { closeDb } = await import('../src/db/client.ts');
  await closeDb();
});

const FOLDER = new ObjectId();

/** A live asset row carrying a given stored fingerprint. */
function row(mapleId: string, fingerprint: string | null) {
  return {
    _id: new ObjectId(),
    maple_id: mapleId,
    deleted_at: null,
    fileinfo: [
      {
        library_id: FOLDER,
        path: '',
        filename: `${mapleId}.jpg`,
        deleted_at: null,
        missing_since: null,
      },
    ],
    ...(fingerprint === null ? {} : { semantic_vector_fingerprint: fingerprint }),
  };
}

async function storedFingerprints(): Promise<Record<string, string | undefined>> {
  const rows = await db!.collection('assets').find({}).toArray();
  return Object.fromEntries(
    rows.map((r) => [r.maple_id as string, r.semantic_vector_fingerprint as string | undefined]),
  );
}

describe('advanceKnownVectorCoverage — document-shape gate', () => {
  it('carries coverage forward within one shape but not across a shape change', async () => {
    if (!mongoReachable) return;
    const { advanceKnownVectorCoverage } =
      await import('../src/enrichment/meilisearch-vector-coverage.ts');

    await db!.collection('assets').insertMany([
      // Same shape as the incoming fingerprint — model/url changed only.
      row('same-shape', 'v8:oldhash'),
      // Previous document shape — its vectors were built without the fields
      // the new template reads.
      row('older-shape', 'v7:oldhash'),
      // Pre-#2384 bare-sha256 fingerprint.
      row('legacy-unprefixed', 'deadbeef'),
      // Never vectorized.
      row('never-covered', null),
    ]);

    await advanceKnownVectorCoverage('v8:newhash');

    const after = await storedFingerprints();
    expect(after['same-shape']).toBe('v8:newhash');
    expect(after['older-shape']).toBe('v7:oldhash');
    expect(after['legacy-unprefixed']).toBe('deadbeef');
    expect(after['never-covered']).toBeUndefined();
  });

  it('is a no-op for an unprefixed incoming fingerprint', async () => {
    if (!mongoReachable) return;
    const { advanceKnownVectorCoverage } =
      await import('../src/enrichment/meilisearch-vector-coverage.ts');
    await db!.collection('assets').insertOne(row('some-row', 'v8:oldhash'));

    await advanceKnownVectorCoverage('bare-hash-no-prefix');

    expect((await storedFingerprints())['some-row']).toBe('v8:oldhash');
  });

  it('leaves trashed rows alone even when their shape matches', async () => {
    if (!mongoReachable) return;
    const { advanceKnownVectorCoverage } =
      await import('../src/enrichment/meilisearch-vector-coverage.ts');
    await db!
      .collection('assets')
      .insertOne({ ...row('trashed', 'v8:oldhash'), deleted_at: '2026-01-01T00:00:00Z' });

    await advanceKnownVectorCoverage('v8:newhash');

    expect((await storedFingerprints())['trashed']).toBe('v8:oldhash');
  });
});
