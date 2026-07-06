/**
 * Tests for the manual-override + requeue routes added on top of
 * /api/assets/:id (PUT place / description, POST enrichment/requeue).
 *
 * Real Mongo. Skip-passes if Mongo is unreachable. Mirrors the
 * search-route.test.ts setup: bare-Elysia `app.handle`, per-pid DB name,
 * close the singleton between phases so the route under test sees the
 * same DB the test seeded.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { Elysia } from 'elysia';
import { MongoClient, ObjectId, type Db } from 'mongodb';
import { pendingEnrichment } from '../src/db/schema.ts';
import { searchBlobUpdateExpression } from '../src/enrichment/search-blob.ts';

const TEST_DB = `maple_test_assets_overrides_${process.pid}`;
const PRIOR_MONGO_DB = process.env.MAPLE_MONGO_DB;
process.env.MAPLE_MONGO_DB = TEST_DB;
const MONGO_URI = process.env.MAPLE_MONGO_URI ?? 'mongodb://localhost:27017';

let mongo: MongoClient | null = null;
let mongoReachable = false;
let db: Db | null = null;
let app: Elysia | null = null;

const folderId = new ObjectId();
let assetId: ObjectId;

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

async function seedAsset(): Promise<ObjectId> {
  const _id = new ObjectId();
  await db!.collection('assets').insertOne({
    _id,
    folder_id: folderId,
    filename: 'DSC_1234.dng',
    abs_path: '/lib/DSC_1234.dng',
    size: 12345,
    mtime: Date.now(),
    rating: 0,
    flag: 0,
    color_label: '',
    indexed_at: new Date().toISOString(),
    enrichment: pendingEnrichment(),
    place: null,
    faces: [],
    description: null,
    ocr_text: null,
    search_blob: '',
  } as never);
  return _id;
}

beforeAll(async () => {
  mongo = await tryConnect();
  mongoReachable = mongo !== null;
  if (!mongoReachable) {
    console.log('[assets-overrides.test] skipping: MongoDB unreachable at', MONGO_URI);
    return;
  }
  db = mongo!.db(TEST_DB);
  await db.dropDatabase();

  // Reset the singleton DB connection so the route under test reads the
  // fresh MAPLE_MONGO_DB env value. Mirrors the pattern in
  // tests/search-route.test.ts.
  const { closeDb } = await import('../src/db/client.ts');
  await closeDb();

  const { assetsRoutes } = await import('../src/routes/assets.ts');
  app = new Elysia().use(assetsRoutes);
});

beforeEach(async () => {
  if (!mongoReachable) return;
  await db!.collection('assets').deleteMany({});
  assetId = await seedAsset();
});

afterAll(async () => {
  if (mongo && mongoReachable) {
    try {
      await mongo.db(TEST_DB).dropDatabase();
    } catch {}
    try {
      await mongo.close();
    } catch {}
  }
  try {
    const { closeDb } = await import('../src/db/client.ts');
    await closeDb();
  } catch {}
  if (PRIOR_MONGO_DB === undefined) delete process.env.MAPLE_MONGO_DB;
  else process.env.MAPLE_MONGO_DB = PRIOR_MONGO_DB;
});

async function put(
  path: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> {
  const res = await app!.handle(
    new Request(`http://localhost${path}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
}

async function post(
  path: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> {
  const res = await app!.handle(
    new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
}

describe('PUT /api/assets/:id/place', () => {
  it('400 on bad ObjectId', async () => {
    if (!mongoReachable) return;
    const r = await put('/api/assets/not-an-oid/place', { place: null });
    expect(r.status).toBe(400);
  });

  it('404 on unknown asset', async () => {
    if (!mongoReachable) return;
    const r = await put(`/api/assets/${new ObjectId().toHexString()}/place`, { place: null });
    expect(r.status).toBe(404);
  });

  it('saves a place + recomputes search_blob', async () => {
    if (!mongoReachable) return;
    const place = {
      source: 'manual',
      geocoder_version: 0,
      geocoded_at: new Date().toISOString(),
      lat: 40.7128,
      lon: -74.006,
      display_name: 'Brooklyn, New York, USA',
      address: { city: 'Brooklyn', state: 'New York', country: 'USA' },
      pois: [],
      rollups: { locality: 'Brooklyn', region: 'New York', country_code: 'us' },
      search_blob: 'brooklyn new york usa',
    };
    const r = await put(`/api/assets/${assetId.toHexString()}/place`, {
      place,
    });
    expect(r.status).toBe(204);
    const doc = await db!.collection('assets').findOne({ _id: assetId });
    expect(doc!.place!.display_name).toBe('Brooklyn, New York, USA');
    // search_blob is the sorted-deduped tokenisation of the place's
    // search_blob (description and ocr_text are still null). Sort is
    // pure alphabetical — "york" lands after "usa".
    expect(doc!.search_blob).toBe('brooklyn new usa york');
  });

  it('clears the place when null is sent', async () => {
    if (!mongoReachable) return;
    // First seed a place by hand so we have something to clear.
    await db!.collection('assets').updateOne({ _id: assetId }, [
      {
        $set: {
          place: {
            source: 'nominatim',
            geocoder_version: 1,
            geocoded_at: new Date().toISOString(),
            lat: 0,
            lon: 0,
            display_name: 'Old place',
            address: {},
            pois: [],
            rollups: { locality: null, region: null, country_code: null },
            search_blob: 'old place',
          },
          search_blob: searchBlobUpdateExpression({
            placeSearchBlob: 'old place',
          }),
        },
      },
    ]);
    const r = await put(`/api/assets/${assetId.toHexString()}/place`, {
      place: null,
    });
    expect(r.status).toBe(204);
    const doc = await db!.collection('assets').findOne({ _id: assetId });
    expect(doc!.place).toBeNull();
    // Without a place, the unified blob falls back to description + ocr —
    // both null on this seed → empty string.
    expect(doc!.search_blob).toBe('');
  });
});

describe('PUT /api/assets/:id/description', () => {
  it('saves description + recomputes search_blob', async () => {
    if (!mongoReachable) return;
    const r = await put(`/api/assets/${assetId.toHexString()}/description`, {
      text: 'A red barn at sunset',
    });
    expect(r.status).toBe(204);
    const doc = await db!.collection('assets').findOne({ _id: assetId });
    expect(doc!.description).toBe('A red barn at sunset');
    // search_blob = sorted lowercase token bag.
    expect(doc!.search_blob).toBe('a at barn red sunset');
  });

  it('clears description when null is sent', async () => {
    if (!mongoReachable) return;
    await db!
      .collection('assets')
      .updateOne(
        { _id: assetId },
        { $set: { description: 'old caption', search_blob: 'old caption' } },
      );
    const r = await put(`/api/assets/${assetId.toHexString()}/description`, { text: null });
    expect(r.status).toBe(204);
    const doc = await db!.collection('assets').findOne({ _id: assetId });
    expect(doc!.description).toBeNull();
  });

  it('422 when text is not a string or null (Elysia schema validation)', async () => {
    if (!mongoReachable) return;
    const r = await put(`/api/assets/${assetId.toHexString()}/description`, { text: 42 });
    expect(r.status).toBe(422);
  });
});

describe('POST /api/assets/:id/enrichment/requeue', () => {
  it('400 on unknown stage', async () => {
    if (!mongoReachable) return;
    const r = await post(`/api/assets/${assetId.toHexString()}/enrichment/requeue`, {
      stage: 'bogus',
    });
    expect(r.status).toBe(400);
  });

  it('clears done_at + bumps version on a fresh row', async () => {
    if (!mongoReachable) return;
    // Mark geocode as done so we can verify it's reset.
    await db!.collection('assets').updateOne(
      { _id: assetId },
      {
        $set: {
          'enrichment.geocode.done_at': new Date().toISOString(),
          'enrichment.geocode.version': 1,
          'enrichment.geocode.attempts': 3,
          'enrichment.geocode.last_error': 'boom',
          'enrichment.geocode.dead_letter_at': new Date().toISOString(),
          'enrichment.geocode.locked_by': 'stale-worker',
          'enrichment.geocode.lease_expires_at': new Date().toISOString(),
        },
      },
    );
    const r = await post(`/api/assets/${assetId.toHexString()}/enrichment/requeue`, {
      stage: 'geocode',
    });
    expect(r.status).toBe(200);
    expect((r.body as { stage: string; version: number }).stage).toBe('geocode');
    expect((r.body as { stage: string; version: number }).version).toBe(2);

    const doc = await db!.collection('assets').findOne({ _id: assetId });
    const geocode = doc!.enrichment!.geocode;
    expect(geocode.done_at).toBeNull();
    expect(geocode.version).toBe(2);
    expect(geocode.attempts).toBe(0);
    expect(geocode.last_error).toBeNull();
    expect(geocode.dead_letter_at).toBeNull();
    expect(geocode.locked_by).toBeNull();
    expect(geocode.lease_expires_at).toBeNull();
  });

  it('works for every stage in the whitelist', async () => {
    if (!mongoReachable) return;
    for (const stage of ['geocode', 'face', 'describe']) {
      const r = await post(`/api/assets/${assetId.toHexString()}/enrichment/requeue`, { stage });
      expect(r.status).toBe(200);
      expect((r.body as { stage: string }).stage).toBe(stage);
    }
  });

  it('starts from version 1 when row had no prior version', async () => {
    if (!mongoReachable) return;
    const r = await post(`/api/assets/${assetId.toHexString()}/enrichment/requeue`, {
      stage: 'describe',
    });
    expect(r.status).toBe(200);
    expect((r.body as { version: number }).version).toBe(1);
  });
});

describe('GET /api/assets/:id (extended payload)', () => {
  it('includes ocr_text and ocr_meta in the response', async () => {
    if (!mongoReachable) return;
    await db!.collection('assets').updateOne(
      { _id: assetId },
      {
        $set: {
          ocr_text: 'hello',
          ocr_meta: {
            engine: 'qwen2.5-vl',
            engine_version: 'qwen3-vl:8b',
            generated_at: new Date().toISOString(),
            mean_confidence: null,
          },
        },
      },
    );
    const res = await app!.handle(
      new Request(`http://localhost/api/assets/${assetId.toHexString()}`),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ocr_text: string | null;
      ocr_meta: { engine: string } | null;
    };
    expect(body.ocr_text).toBe('hello');
    expect(body.ocr_meta!.engine).toBe('qwen2.5-vl');
  });
});
