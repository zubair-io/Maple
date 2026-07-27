import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { MongoClient, ObjectId, type Db } from 'mongodb';
import { signAccessToken } from '../src/auth/tokens.ts';

const TEST_DB = `maple_test_semantic_validation_${process.pid}`;
process.env.MAPLE_MONGO_DB = TEST_DB;
process.env.MAPLE_GEOCODE_WORKER_ENABLED = 'false';
process.env.MAPLE_DESCRIBE_WORKER_ENABLED = 'false';
process.env.MAPLE_JWT_SECRET = 'x'.repeat(32);
const MONGO_URI = process.env.MAPLE_MONGO_URI ?? 'mongodb://localhost:27017';
const realFetch = globalThis.fetch;
let mongo: MongoClient | null = null;
let db: Db | null = null;
let app: Elysia | null = null;

// PUT /config is owner-gated (#2353); the other routes exercised here
// (POST /test-meili) only need a valid bearer, so an owner token covers both.
const ownerJwt = await signAccessToken(
  { sub: new ObjectId().toHexString(), email: 'o@m.c', role: 'owner' },
  'x'.repeat(32),
);

beforeAll(async () => {
  mongo = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 1500 });
  try {
    await mongo.connect();
    db = mongo.db(TEST_DB);
    await db.dropDatabase();
  } catch {
    await mongo.close().catch(() => {});
    mongo = null;
    return;
  }
  const { closeDb } = await import('../src/db/client.ts');
  await closeDb();
  const { enrichmentRoutes } = await import('../src/routes/enrichment.ts');
  app = new Elysia().use(enrichmentRoutes);
});

beforeEach(async () => {
  await db?.collection('app_settings').deleteMany({});
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

afterAll(async () => {
  if (mongo) {
    await mongo.db(TEST_DB).dropDatabase();
    await mongo.close();
  }
  const { closeDb } = await import('../src/db/client.ts');
  await closeDb();
});

async function request(method: 'POST' | 'PUT', path: string, body: object) {
  const response = await app!.handle(
    new Request(`http://localhost${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerJwt}` },
      body: JSON.stringify(body),
    }),
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe('semantic settings validation and connection readiness', () => {
  it('rejects a malformed shared Ollama URL and semantic mode without Meilisearch', async () => {
    if (!app) return;
    const malformed = await request('PUT', '/api/enrichment/config', {
      nominatim_url: null,
      geocode_worker_enabled: false,
      describe_provider_url: 'not-a-url',
    });
    expect(malformed.status).toBe(400);
    expect(malformed.body.error).toContain('Invalid describe_provider_url');

    const missingMeili = await request('PUT', '/api/enrichment/config', {
      nominatim_url: null,
      geocode_worker_enabled: false,
      meilisearch_semantic_enabled: true,
    });
    expect(missingMeili.status).toBe(400);
    expect(missingMeili.body.error).toContain('requires a Meilisearch URL');
  });

  it('uses the saved write-only key when the test field is blank', async () => {
    if (!app || !db) return;
    await db.collection('app_settings').insertOne({
      _id: 'enrichment',
      config: { meilisearch_api_key: 'saved-secret' },
    } as never);
    let authorization: string | null = null;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      authorization = new Headers(init?.headers).get('authorization');
      return new Response(JSON.stringify({ status: 'available' }), { status: 200 });
    }) as typeof fetch;

    const result = await request('POST', '/api/enrichment/test-meili', {
      meilisearch_url: 'http://meili.test:7700',
    });
    expect(result.body).toMatchObject({ ok: true });
    expect(authorization === 'Bearer saved-secret').toBe(true);
  });

  it('returns semantic readiness details instead of health-only success', async () => {
    if (!app || !db) return;
    await db.collection('app_settings').insertOne({
      _id: 'enrichment',
      config: {
        meilisearch_semantic_enabled: true,
        meilisearch_embedder_model: 'bge-m3',
      },
    } as never);
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const path = new URL(input.toString()).pathname;
      const body = path.endsWith('/health')
        ? { status: 'available' }
        : path.endsWith('/stats')
          ? { numberOfDocuments: 10, isIndexing: false }
          : {};
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;

    const result = await request('POST', '/api/enrichment/test-meili', {
      meilisearch_url: 'http://meili.test:7700',
    });
    expect(result.body).toMatchObject({
      ok: false,
      semanticReady: false,
      semantic: {
        embedderName: 'caption',
        model: 'bge-m3',
        meilisearchReachable: true,
        embedderConfigured: false,
      },
    });
  });
});
