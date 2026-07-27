/**
 * Migration-adapter surface of the Meilisearch backfill (durable progress,
 * reset, dead-letter backlog count). Split from
 * `admin-backfill-meilisearch.test.ts` for the file-size budget — these
 * tests drive `backfillMeilisearchVectors` directly and never touch the
 * HTTP route, so the route/auth boilerplate stays behind.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { MongoClient, ObjectId, type Db } from 'mongodb';
import {
  setMeilisearchClientForTests,
  type MeilisearchClient,
  type MeilisearchAssetDoc,
} from '../src/enrichment/meilisearch-client.ts';

const TEST_DB = `maple_test_meili_backfill_mig_${process.pid}`;
process.env.MAPLE_MONGO_DB = TEST_DB;
process.env.MAPLE_JWT_SECRET = 'x'.repeat(32);
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

interface CapturedMeili {
  client: MeilisearchClient;
  upserts: MeilisearchAssetDoc[];
  tombstones: string[];
  ensureCalls: number;
  configured: boolean;
  failBatch: boolean;
}

function makeCapturingMeili(configured = true): CapturedMeili {
  const upserts: MeilisearchAssetDoc[] = [];
  const tombstones: string[] = [];
  const c: CapturedMeili = {
    upserts,
    tombstones,
    ensureCalls: 0,
    configured,
    failBatch: false,
    client: {
      isConfigured: () => c.configured,
      semanticConfigured: () => c.configured,
      health: async () => c.configured,
      ensureIndex: async () => {
        c.ensureCalls += 1;
      },
      upsert: async (doc) => {
        upserts.push(doc);
      },
      upsertOrThrow: async (doc) => {
        upserts.push(doc);
      },
      upsertBatchOrThrow: async (docs) => {
        if (c.failBatch) throw new Error('temporary batch failure');
        upserts.push(...docs);
      },
      tombstoneBatchOrThrow: async (ids) => {
        if (c.failBatch) throw new Error('temporary batch failure');
        tombstones.push(...ids);
      },
      tombstone: async (id) => {
        tombstones.push(id);
      },
      search: async () => ({ ids: [], estimatedTotal: 0 }),
    },
  };
  return c;
}

beforeAll(async () => {
  mongo = await tryConnect();
  mongoReachable = mongo !== null;
  if (!mongoReachable) {
    console.log('[admin-backfill-meilisearch-migration.test] skipping: MongoDB unreachable');
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
  await db!.collection('people').deleteMany({});
  await db!.collection('meilisearch_backfill_state').deleteMany({});
  await db!.collection('meilisearch_backfill_failures').deleteMany({});
  await db!.collection('meilisearch_backfill_leases').deleteMany({});
  setMeilisearchClientForTests(null);
});

afterAll(async () => {
  if (mongo) {
    await mongo.db(TEST_DB).dropDatabase();
    await mongo.close();
  }
  const { closeDb } = await import('../src/db/client.ts');
  await closeDb();
  setMeilisearchClientForTests(null);
});

const FOLDER = new ObjectId();

function makeRow(mapleId: string, blob: string | null, opts: { deletedAt?: string | null } = {}) {
  return {
    folder_id: FOLDER,
    maple_id: mapleId,
    abs_path: `/lib/${mapleId}.dng`,
    filename: `${mapleId}.dng`,
    size: 1024,
    mtime: Date.now(),
    rating: 0,
    flag: 0,
    color_label: '',
    indexed_at: new Date().toISOString(),
    exif: {
      captured_at: '2024-06-01T12:00:00.000Z',
      captured_year: 2024,
      captured_month: 6,
      camera_make: null,
      camera_model: null,
      lens: null,
      iso: null,
      aperture: null,
      shutter: null,
      focal_length: null,
      gps: null,
    },
    // Top-level unified blob — what the meili stage persists and what the
    // backfill cursor filters on. Empty/absent ⇒ filtered out.
    search_blob: blob ?? '',
    place:
      blob === null
        ? null
        : {
            source: 'nominatim',
            geocoder_version: 1,
            geocoded_at: '2026-05-08T00:00:00.000Z',
            lat: 0,
            lon: 0,
            display_name: blob,
            address: {},
            pois: [],
            rollups: { locality: null, region: null, country_code: null },
            search_blob: blob,
          },
    deleted_at: opts.deletedAt ?? null,
  };
}

describe('Meilisearch backfill migration adapter', () => {
  it('exposes durable progress and reset through the migration adapter', async () => {
    if (!mongoReachable) return;
    await db!
      .collection('assets')
      .insertMany([
        makeRow('migration-a', 'boiler installation'),
        makeRow('migration-b', 'heat pump'),
        makeRow('migration-c', 'air handler'),
      ]);
    const meili = makeCapturingMeili();
    setMeilisearchClientForTests(meili.client);
    const { backfillMeilisearchVectors } =
      await import('../src/workers/migration/backfill-meilisearch-vectors.ts');
    expect(backfillMeilisearchVectors.preferredBatchSize).toBe(50);

    expect(await backfillMeilisearchVectors.countRemaining()).toBe(3);
    expect(await backfillMeilisearchVectors.runBatch(2)).toEqual({
      processed: 2,
      errors: 0,
      complete: false,
    });
    expect(await backfillMeilisearchVectors.countRemaining()).toBe(1);

    // An exact-size final batch is marked complete without requiring a
    // trailing empty request from the migration worker.
    expect(await backfillMeilisearchVectors.runBatch(1)).toEqual({
      processed: 1,
      errors: 0,
      complete: true,
    });
    expect(await backfillMeilisearchVectors.countRemaining()).toBe(0);
    const state = await db!
      .collection<{ _id: string; completed_at?: string | null }>('meilisearch_backfill_state')
      .findOne({ _id: 'assets' });
    expect(state?.completed_at).not.toBeNull();

    // A confirming poll after completion is idempotent. Only an explicit
    // reset may restart the library-wide sweep.
    const upsertCount = meili.upserts.length;
    expect(await backfillMeilisearchVectors.runBatch(1)).toEqual({
      processed: 0,
      errors: 0,
      complete: true,
    });
    expect(meili.upserts).toHaveLength(upsertCount);
    expect(
      await db!
        .collection<{ _id: string }>('meilisearch_backfill_state')
        .findOne({ _id: 'assets' }),
    ).toEqual(state);

    const { resetMigrationState } = await import('../src/workers/migration-config.repo.ts');
    const { BACKFILL_MEILISEARCH_VECTORS_ID } = await import('../src/workers/migration/ids.ts');
    await resetMigrationState(BACKFILL_MEILISEARCH_VECTORS_ID);
    expect(await backfillMeilisearchVectors.countRemaining()).toBe(3);
  });

  it('surfaces the live dead-letter backlog through the migration adapter', async () => {
    if (!mongoReachable) return;
    await db!.collection('assets').insertOne({
      ...makeRow('status-broken', 'bad folder id'),
      folder_id: 'not-an-object-id',
    });
    const meili = makeCapturingMeili();
    setMeilisearchClientForTests(meili.client);
    const { backfillMeilisearchVectors } =
      await import('../src/workers/migration/backfill-meilisearch-vectors.ts');

    // A migration without a dead-letter queue omits the field entirely; this
    // one always implements it.
    expect(backfillMeilisearchVectors.countFailedPermanently).toBeDefined();
    expect(await backfillMeilisearchVectors.countFailedPermanently!()).toBe(0);

    // The row's folder_id never becomes valid, so both the initial compose
    // failure and the same-run redrive re-attempt fail — the row stays
    // dead-lettered and the live count reflects it.
    await backfillMeilisearchVectors.runBatch(10);
    expect(await backfillMeilisearchVectors.countFailedPermanently!()).toBe(1);
  });
});
