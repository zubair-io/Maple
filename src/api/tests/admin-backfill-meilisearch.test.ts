/**
 * Tests POST /api/admin/enrichment/backfill-meilisearch — sweeps every
 * asset with a populated `place.search_blob` and upserts to Meilisearch.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { Elysia } from 'elysia';
import { MongoClient, ObjectId, type Db } from 'mongodb';
import {
  setMeilisearchClientForTests,
  type MeilisearchClient,
  type MeilisearchAssetDoc,
} from '../src/enrichment/meilisearch-client.ts';

const TEST_DB = `maple_test_meili_backfill_${process.pid}`;
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
      semanticConfigured: () => false,
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
    console.log('[admin-backfill-meilisearch.test] skipping: MongoDB unreachable');
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
    // backfill cursor now filters on. Empty/absent ⇒ filtered out.
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

describe('POST /api/admin/enrichment/backfill-meilisearch', () => {
  it('returns 400 when Meilisearch is not configured', async () => {
    if (!mongoReachable) return;
    const meili = makeCapturingMeili(false);
    setMeilisearchClientForTests(meili.client);

    const { meilisearchBackfillRoutes } =
      await import('../src/routes/admin-backfill-meilisearch.ts');
    const app = new Elysia().use(meilisearchBackfillRoutes);
    const r = await app.handle(
      new Request('http://localhost/api/admin/enrichment/backfill-meilisearch', { method: 'POST' }),
    );
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: string };
    expect(body.error).toContain('not configured');
  });

  it('upserts enriched and filename-only assets and reports counts', async () => {
    if (!mongoReachable) return;
    await db!.collection('assets').insertMany([
      makeRow('a', 'albany ny'),
      makeRow('b', 'new york ny park'),
      makeRow('c', 'san francisco ca'),
      // Filename-only assets are still indexed for exact identifier search.
      makeRow('d', ''),
      // A missing place is also valid when the filename is searchable.
      makeRow('e', null),
    ]);
    // Skipped: missing maple_id (legacy row).
    await db!.collection('assets').insertOne({
      folder_id: FOLDER,
      abs_path: '/lib/legacy.dng',
      filename: 'legacy.dng',
      size: 1024,
      mtime: Date.now(),
      rating: 0,
      flag: 0,
      color_label: '',
      indexed_at: new Date().toISOString(),
      exif: null,
      // Non-empty top-level blob so it enters the cursor — but no maple_id,
      // so the per-row skip fires (exercising that path).
      search_blob: 'boston ma',
      place: {
        source: 'nominatim',
        geocoder_version: 1,
        geocoded_at: '',
        lat: 0,
        lon: 0,
        display_name: null,
        address: {},
        pois: [],
        rollups: { locality: null, region: null, country_code: null },
        search_blob: 'boston ma',
      },
      deleted_at: null,
    });
    // Soft-deleted but populated — should still be upserted (the route
    // pushes deletedAt through so Meilisearch knows the doc is tombstoned).
    await db!
      .collection('assets')
      .insertOne(makeRow('g', 'denver co', { deletedAt: new Date().toISOString() }));
    await db!.collection('assets').insertOne({
      ...makeRow('h', 'stale modern location'),
      fileinfo: [
        {
          library_id: FOLDER,
          path: '',
          filename: 'h.dng',
          deleted_at: null,
          missing_since: new Date().toISOString(),
        },
      ],
    });

    const meili = makeCapturingMeili();
    setMeilisearchClientForTests(meili.client);

    const { meilisearchBackfillRoutes } =
      await import('../src/routes/admin-backfill-meilisearch.ts');
    const app = new Elysia().use(meilisearchBackfillRoutes);
    const r = await app.handle(
      new Request('http://localhost/api/admin/enrichment/backfill-meilisearch', { method: 'POST' }),
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      scanned: number;
      upserted: number;
      tombstoned: number;
      skipped: number;
      errors: number;
    };
    // All seven stable assets are scanned; the legacy row without maple_id is
    // excluded by the cursor query.
    expect(body.scanned).toBe(7);
    expect(body.upserted).toBe(5);
    expect(body.tombstoned).toBe(2);
    expect(body.skipped).toBe(2);
    expect(body.errors).toBe(0);

    // Confirm the captured upserts include the right ids and folderId.
    const ids = meili.upserts.map((u) => u.id).sort();
    expect(ids).toEqual(['a', 'b', 'c', 'd', 'e']);
    for (const u of meili.upserts) {
      expect(u.folderId).toBe(FOLDER.toHexString());
    }
    expect(meili.tombstones.sort()).toEqual(['g', 'h']);

    // ensureIndex was called once at the start.
    expect(meili.ensureCalls).toBe(1);
  });

  it('pushes the FULL doc shape (description / vision / people / searchBlob)', async () => {
    if (!mongoReachable) return;
    // A row with a description, vision fields, and an assigned named person.
    const PERSON = new ObjectId();
    await db!.collection('people').insertOne({
      _id: PERSON,
      name: 'Greyson',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      merged_into: null,
    } as never);
    await db!.collection('assets').insertOne({
      folder_id: FOLDER,
      maple_id: 'full',
      filename: 'full.dng',
      size: 1024,
      mtime: Date.now(),
      rating: 0,
      flag: 0,
      color_label: '',
      indexed_at: new Date().toISOString(),
      exif: { captured_at: '2024-06-01T12:00:00.000Z' },
      search_blob: 'albany ny kids playing lacrosse greyson',
      description: 'kids playing lacrosse',
      ocr_text: null,
      is_screenshot: false,
      vision: {
        caption: 'kids playing lacrosse',
        subjects: ['child', 'athlete'],
        scene_type: 'outdoor',
        setting: 'sports field',
        activity: 'lacrosse',
        notable_objects: ['lacrosse stick'],
        is_screenshot: false,
      },
      faces: [
        { bbox: { x: 0, y: 0, w: 0.2, h: 0.2 }, person_id: PERSON.toHexString(), confidence: 0.9 },
      ],
      place: {
        source: 'nominatim',
        geocoder_version: 1,
        geocoded_at: '2026-05-08T00:00:00.000Z',
        lat: 0,
        lon: 0,
        display_name: 'albany ny',
        address: {},
        pois: [],
        rollups: { locality: null, region: null, country_code: null },
        search_blob: 'albany ny',
      },
      deleted_at: null,
    } as never);

    const meili = makeCapturingMeili();
    setMeilisearchClientForTests(meili.client);

    const { meilisearchBackfillRoutes } =
      await import('../src/routes/admin-backfill-meilisearch.ts');
    const app = new Elysia().use(meilisearchBackfillRoutes);
    const r = await app.handle(
      new Request('http://localhost/api/admin/enrichment/backfill-meilisearch', {
        method: 'POST',
      }),
    );
    expect(r.status).toBe(200);

    const doc = meili.upserts.find((u) => u.id === 'full');
    expect(doc).toBeDefined();
    expect(doc!.description).toBe('kids playing lacrosse');
    expect(doc!.visionSceneType).toBe('outdoor');
    expect(doc!.visionActivity).toBe('lacrosse');
    expect(doc!.visionSubjects).toEqual(['child', 'athlete']);
    expect(doc!.isScreenshot).toBe(false);
    expect(doc!.people).toEqual(['Greyson']);
    // searchBlob is recomposed and includes tokens from every source.
    const tokens = new Set(doc!.searchBlob.split(' '));
    expect(tokens.has('albany')).toBe(true);
    expect(tokens.has('lacrosse')).toBe(true);
    expect(tokens.has('greyson')).toBe(true);
  });

  it('resumes from a durable cursor in bounded batches', async () => {
    if (!mongoReachable) return;
    await db!
      .collection('assets')
      .insertMany([
        makeRow('batch-a', 'hvac installation'),
        makeRow('batch-b', 'heat pump'),
        makeRow('batch-c', 'air conditioning'),
      ]);
    const meili = makeCapturingMeili();
    setMeilisearchClientForTests(meili.client);
    const { meilisearchBackfillRoutes } =
      await import('../src/routes/admin-backfill-meilisearch.ts');
    const app = new Elysia().use(meilisearchBackfillRoutes);

    const first = await app.handle(
      new Request('http://localhost/api/admin/enrichment/backfill-meilisearch?batchSize=2', {
        method: 'POST',
      }),
    );
    const firstBody = (await first.json()) as {
      complete: boolean;
      nextCursor: string | null;
      cumulative: { scanned: number };
    };
    expect(firstBody.complete).toBe(false);
    expect(firstBody.nextCursor).not.toBeNull();
    expect(firstBody.cumulative.scanned).toBe(2);

    const second = await app.handle(
      new Request('http://localhost/api/admin/enrichment/backfill-meilisearch?batchSize=2', {
        method: 'POST',
      }),
    );
    const secondBody = (await second.json()) as {
      complete: boolean;
      nextCursor: string | null;
      cumulative: { scanned: number; upserted: number };
    };
    expect(secondBody.complete).toBe(true);
    expect(secondBody.nextCursor).toBeNull();
    expect(secondBody.cumulative.scanned).toBe(3);
    expect(secondBody.cumulative.upserted).toBe(3);
    expect(meili.upserts.map((doc) => doc.id).sort()).toEqual(['batch-a', 'batch-b', 'batch-c']);
  });

  it('dead-letters a deterministic row error and advances the cursor', async () => {
    if (!mongoReachable) return;
    await db!.collection('assets').insertOne({
      ...makeRow('broken-row', 'bad folder id'),
      folder_id: 'not-an-object-id',
    });
    const meili = makeCapturingMeili();
    setMeilisearchClientForTests(meili.client);
    const { meilisearchBackfillRoutes } =
      await import('../src/routes/admin-backfill-meilisearch.ts');
    const app = new Elysia().use(meilisearchBackfillRoutes);

    const response = await app.handle(
      new Request('http://localhost/api/admin/enrichment/backfill-meilisearch', {
        method: 'POST',
      }),
    );
    const body = (await response.json()) as {
      complete: boolean;
      errors: number;
      nextCursor: string | null;
    };
    expect(body.complete).toBe(true);
    expect(body.errors).toBe(1);
    expect(body.nextCursor).toBeNull();
    const failure = await db!
      .collection('meilisearch_backfill_failures')
      .findOne({ maple_id: 'broken-row' });
    expect(failure?.attempts).toBe(1);
  });

  it('retains the cursor and retries an idempotent batch after a write failure', async () => {
    if (!mongoReachable) return;
    await db!
      .collection('assets')
      .insertMany([
        makeRow('retry-a', 'compressor installation'),
        makeRow('retry-b', 'heat pump installed'),
      ]);
    const meili = makeCapturingMeili();
    meili.failBatch = true;
    setMeilisearchClientForTests(meili.client);
    const { meilisearchBackfillRoutes } =
      await import('../src/routes/admin-backfill-meilisearch.ts');
    const app = new Elysia().use(meilisearchBackfillRoutes);
    const url = 'http://localhost/api/admin/enrichment/backfill-meilisearch?batchSize=10';

    const failed = await app.handle(new Request(url, { method: 'POST' }));
    const failedBody = (await failed.json()) as {
      complete: boolean;
      nextCursor: string | null;
      errors: number;
    };
    expect(failedBody.complete).toBe(false);
    expect(failedBody.nextCursor).toBeNull();
    expect(failedBody.errors).toBe(2);
    expect(meili.upserts).toHaveLength(0);

    meili.failBatch = false;
    const retried = await app.handle(new Request(url, { method: 'POST' }));
    const retriedBody = (await retried.json()) as {
      complete: boolean;
      upserted: number;
    };
    expect(retriedBody.complete).toBe(true);
    expect(retriedBody.upserted).toBe(2);
    expect(meili.upserts.map((doc) => doc.id).sort()).toEqual(['retry-a', 'retry-b']);
  });
});
