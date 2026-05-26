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
  ensureCalls: number;
  configured: boolean;
}

function makeCapturingMeili(configured = true): CapturedMeili {
  const upserts: MeilisearchAssetDoc[] = [];
  const c: CapturedMeili = {
    upserts,
    ensureCalls: 0,
    configured,
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
      tombstone: async () => {},
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

  it('upserts every asset with a non-empty searchBlob and reports counts', async () => {
    if (!mongoReachable) return;
    await db!.collection('assets').insertMany([
      makeRow('a', 'albany ny'),
      makeRow('b', 'new york ny park'),
      makeRow('c', 'san francisco ca'),
      // Skipped: empty blob.
      makeRow('d', ''),
      // Skipped: null place.
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
      skipped: number;
      errors: number;
    };
    // 5 hit the Mongo cursor (a, b, c, legacy, g) — d and e have empty/
    // missing search_blob and are filtered out by the find() predicate.
    expect(body.scanned).toBe(5);
    // Only those with both maple_id AND non-empty blob are upserted.
    expect(body.upserted).toBe(4);
    expect(body.skipped).toBe(1); // legacy row (no maple_id)
    expect(body.errors).toBe(0);

    // Confirm the captured upserts include the right ids and folderId.
    const ids = meili.upserts.map((u) => u.id).sort();
    expect(ids).toEqual(['a', 'b', 'c', 'g']);
    for (const u of meili.upserts) {
      expect(u.folderId).toBe(FOLDER.toHexString());
    }
    // The soft-deleted row's deletedAt should round-trip.
    const denver = meili.upserts.find((u) => u.id === 'g');
    expect(denver).toBeDefined();
    expect(denver!.deletedAt).not.toBeNull();

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
});
