import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { MongoClient, ObjectId, type Db } from 'mongodb';
import {
  setMeilisearchClientForTests,
  type MeilisearchAssetDoc,
  type MeilisearchClient,
} from '../src/enrichment/meilisearch-client.ts';
import { MeilisearchTaskError } from '../src/enrichment/meilisearch-transport.ts';
import { signAccessToken } from '../src/auth/tokens.ts';

const TEST_DB = `maple_test_meili_resilience_${process.pid}`;
process.env.MAPLE_MONGO_DB = TEST_DB;
process.env.MAPLE_JWT_SECRET = 'x'.repeat(32);
const URI = process.env.MAPLE_MONGO_URI ?? 'mongodb://localhost:27017';
let mongo: MongoClient | null = null;
let db: Db | null = null;
const folder = new ObjectId();

// admin-meilisearch-status is owner-gated (#2353).
const ownerJwt = await signAccessToken(
  { sub: new ObjectId().toHexString(), email: 'o@m.c', role: 'owner' },
  'x'.repeat(32),
);
const memberJwt = await signAccessToken(
  { sub: new ObjectId().toHexString(), email: 'm@m.c', role: 'member' },
  'x'.repeat(32),
);

beforeAll(async () => {
  mongo = new MongoClient(URI, { serverSelectionTimeoutMS: 1500 });
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
});

beforeEach(async () => {
  if (!db) return;
  for (const collection of [
    'assets',
    'people',
    'meilisearch_backfill_state',
    'meilisearch_backfill_failures',
    'meilisearch_backfill_leases',
  ]) {
    await db.collection(collection).deleteMany({});
  }
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

function row(id: string) {
  return {
    maple_id: id,
    folder_id: folder,
    filename: `${id}.jpg`,
    size: 1,
    mtime: 1,
    rating: 0,
    flag: 0,
    color_label: '',
    indexed_at: new Date().toISOString(),
    deleted_at: null,
  };
}

function client(options: { reject?: string; transient?: boolean } = {}) {
  const upserts: MeilisearchAssetDoc[] = [];
  const fake: MeilisearchClient = {
    isConfigured: () => true,
    semanticConfigured: () => true,
    health: async () => true,
    ensureIndex: async () => {},
    upsert: async () => {},
    upsertOrThrow: async () => {},
    upsertBatchOrThrow: async (docs) => {
      if (options.transient) throw new Error('temporary batch failure');
      if (options.reject && docs.some((doc) => doc.id === options.reject)) {
        throw new MeilisearchTaskError('invalid document', 'invalid_document_fields');
      }
      upserts.push(...docs);
    },
    tombstone: async () => {},
    tombstoneBatchOrThrow: async () => {},
    search: async () => ({ ids: [], estimatedTotal: 0 }),
  };
  return { fake, upserts };
}

describe('semantic backfill resilience', () => {
  it('reports confirmed live coverage separately from raw tombstone-inclusive stats', async () => {
    if (!db) return;
    const liveFile = {
      library_id: folder,
      path: '',
      filename: 'covered.jpg',
      deleted_at: null,
      missing_since: null,
    };
    await db.collection('assets').insertMany([
      { ...row('covered'), fileinfo: [liveFile], semantic_vector_fingerprint: 'current' },
      { ...row('pending'), fileinfo: [{ ...liveFile, filename: 'pending.jpg' }] },
      {
        ...row('tombstone'),
        deleted_at: new Date().toISOString(),
        fileinfo: [{ ...liveFile, deleted_at: new Date().toISOString() }],
        semantic_vector_fingerprint: 'current',
      },
    ]);
    const meili = client();
    meili.fake.semanticFingerprint = () => 'current';
    meili.fake.semanticStatus = async () => ({
      configured: true,
      enabled: true,
      embedderName: 'caption',
      model: 'bge-m3',
      semanticRatio: 0.5,
      meilisearchReachable: true,
      embedderConfigured: true,
      embedderReachable: true,
      indexedDocumentCount: 3,
      vectorizedDocumentCount: 3,
      isIndexing: false,
      error: null,
    });
    setMeilisearchClientForTests(meili.fake);
    const { adminMeilisearchStatusRoutes } =
      await import('../src/routes/admin-meilisearch-status.ts');
    const { Elysia } = await import('elysia');
    const response = await new Elysia().use(adminMeilisearchStatusRoutes).handle(
      new Request('http://localhost/api/admin/enrichment/meilisearch-status', {
        headers: { authorization: `Bearer ${ownerJwt}` },
      }),
    );
    expect(await response.json()).toMatchObject({
      documents: {
        live: 2,
        indexedRaw: 3,
        vectorizedRaw: 3,
        vectorizedLive: 1,
        vectorCoverage: 0.5,
      },
    });
  });

  it('isolates and dead-letters one invalid document while committing siblings', async () => {
    if (!db) return;
    await db.collection('assets').insertMany([row('valid'), row('invalid')]);
    const meili = client({ reject: 'invalid' });
    setMeilisearchClientForTests(meili.fake);
    const { runMeilisearchBackfill } = await import('../src/enrichment/meilisearch-backfill.ts');

    expect(await runMeilisearchBackfill(10, false)).toMatchObject({
      complete: true,
      retryable: false,
      upserted: 1,
      errors: 1,
    });
    expect(meili.upserts.map((doc) => doc.id)).toEqual(['valid']);
    expect(
      await db.collection('meilisearch_backfill_failures').findOne({ maple_id: 'invalid' }),
    ).toMatchObject({ attempts: 1 });
  });

  it('blocks after five transient failures and can rearm without losing its cursor', async () => {
    if (!db) return;
    await db.collection('assets').insertOne(row('blocked'));
    setMeilisearchClientForTests(client({ transient: true }).fake);
    const { runMeilisearchBackfill, clearMeilisearchBackfillRetryState } =
      await import('../src/enrichment/meilisearch-backfill.ts');

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const result = await runMeilisearchBackfill(10, false);
      expect(result.blocked).toBe(attempt === 5);
      expect(result.nextCursor).toBeNull();
    }
    expect(
      await db.collection<{ _id: string }>('meilisearch_backfill_state').findOne({ _id: 'assets' }),
    ).toMatchObject({ scanned: 0, retry_attempts: 5 });
    await clearMeilisearchBackfillRetryState();
    expect(
      await db.collection<{ _id: string }>('meilisearch_backfill_state').findOne({ _id: 'assets' }),
    ).toMatchObject({ scanned: 0, retry_attempts: 0, blocked_at: null });
  });

  it('serializes admin, migration, and reset callers with a lease', async () => {
    if (!db) return;
    const { withMeilisearchBackfillLease, MeilisearchBackfillBusyError } =
      await import('../src/enrichment/meilisearch-backfill-lease.ts');
    let release!: () => void;
    let acquired!: () => void;
    const blocker = new Promise<void>((resolve) => (release = resolve));
    const signal = new Promise<void>((resolve) => (acquired = resolve));
    const first = withMeilisearchBackfillLease(async () => {
      acquired();
      await blocker;
    });
    await signal;
    await expect(withMeilisearchBackfillLease(async () => {})).rejects.toBeInstanceOf(
      MeilisearchBackfillBusyError,
    );
    release();
    await first;
  });
});

describe('GET /api/admin/enrichment/meilisearch-status — owner gate (#2353)', () => {
  it('rejects an unauthenticated request with 401', async () => {
    if (!db) return;
    const { adminMeilisearchStatusRoutes } =
      await import('../src/routes/admin-meilisearch-status.ts');
    const { Elysia } = await import('elysia');
    const response = await new Elysia()
      .use(adminMeilisearchStatusRoutes)
      .handle(new Request('http://localhost/api/admin/enrichment/meilisearch-status'));
    expect(response.status).toBe(401);
  });

  it('rejects a member-role token with 403', async () => {
    if (!db) return;
    const { adminMeilisearchStatusRoutes } =
      await import('../src/routes/admin-meilisearch-status.ts');
    const { Elysia } = await import('elysia');
    const response = await new Elysia().use(adminMeilisearchStatusRoutes).handle(
      new Request('http://localhost/api/admin/enrichment/meilisearch-status', {
        headers: { authorization: `Bearer ${memberJwt}` },
      }),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'owner role required' });
  });

  it('allows an owner-role token through (200)', async () => {
    if (!db) return;
    const { adminMeilisearchStatusRoutes } =
      await import('../src/routes/admin-meilisearch-status.ts');
    const { Elysia } = await import('elysia');
    const response = await new Elysia().use(adminMeilisearchStatusRoutes).handle(
      new Request('http://localhost/api/admin/enrichment/meilisearch-status', {
        headers: { authorization: `Bearer ${ownerJwt}` },
      }),
    );
    expect(response.status).toBe(200);
  });
});
