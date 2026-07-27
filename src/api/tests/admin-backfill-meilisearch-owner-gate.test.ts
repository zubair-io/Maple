/**
 * POST /api/admin/enrichment/backfill-meilisearch — owner gate (#2353).
 * Split out of `admin-backfill-meilisearch.test.ts` to stay under the
 * repo's 600-line file budget (see CONTRIBUTING.md § "File-size budget").
 *
 * The route is owner-gated: a `?reset=true` call discards backfill progress
 * and re-scans the whole library, so it must not be reachable by any member.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { Elysia } from 'elysia';
import { MongoClient, ObjectId, type Db } from 'mongodb';
import {
  setMeilisearchClientForTests,
  type MeilisearchClient,
} from '../src/enrichment/meilisearch-client.ts';
import { signAccessToken } from '../src/auth/tokens.ts';

const TEST_DB = `maple_test_meili_backfill_owner_gate_${process.pid}`;
process.env.MAPLE_MONGO_DB = TEST_DB;
process.env.MAPLE_JWT_SECRET = 'x'.repeat(32);
const MONGO_URI = process.env.MAPLE_MONGO_URI ?? 'mongodb://localhost:27017';

let mongo: MongoClient | null = null;
let mongoReachable = false;
let db: Db | null = null;

const ownerJwt = await signAccessToken(
  { sub: new ObjectId().toHexString(), email: 'o@m.c', role: 'owner' },
  'x'.repeat(32),
);
const memberJwt = await signAccessToken(
  { sub: new ObjectId().toHexString(), email: 'm@m.c', role: 'member' },
  'x'.repeat(32),
);

function ownerAuthed(init: RequestInit = {}): RequestInit {
  return {
    ...init,
    headers: {
      ...(init.headers as Record<string, string> | undefined),
      authorization: `Bearer ${ownerJwt}`,
    },
  };
}

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

function makeUnconfiguredMeili(): MeilisearchClient {
  return {
    isConfigured: () => false,
    semanticConfigured: () => false,
    health: async () => false,
    ensureIndex: async () => {},
    upsert: async () => {},
    upsertOrThrow: async () => {},
    upsertBatchOrThrow: async () => {},
    tombstoneBatchOrThrow: async () => {},
    tombstone: async () => {},
    search: async () => ({ ids: [], estimatedTotal: 0 }),
  };
}

beforeAll(async () => {
  mongo = await tryConnect();
  mongoReachable = mongo !== null;
  if (!mongoReachable) {
    console.log('[admin-backfill-meilisearch-owner-gate.test] skipping: MongoDB unreachable');
    return;
  }
  db = mongo!.db(TEST_DB);
  await db.dropDatabase();
  const { closeDb } = await import('../src/db/client.ts');
  await closeDb();
});

beforeEach(async () => {
  if (!mongoReachable) return;
  await db!.collection('meilisearch_backfill_state').deleteMany({});
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

describe('POST /api/admin/enrichment/backfill-meilisearch — owner gate (#2353)', () => {
  it('rejects an unauthenticated request with 401', async () => {
    if (!mongoReachable) return;
    const { meilisearchBackfillRoutes } =
      await import('../src/routes/admin-backfill-meilisearch.ts');
    const app = new Elysia().use(meilisearchBackfillRoutes);
    const r = await app.handle(
      new Request('http://localhost/api/admin/enrichment/backfill-meilisearch', {
        method: 'POST',
      }),
    );
    expect(r.status).toBe(401);
  });

  it('rejects a member-role token with 403', async () => {
    if (!mongoReachable) return;
    const { meilisearchBackfillRoutes } =
      await import('../src/routes/admin-backfill-meilisearch.ts');
    const app = new Elysia().use(meilisearchBackfillRoutes);
    const r = await app.handle(
      new Request('http://localhost/api/admin/enrichment/backfill-meilisearch', {
        method: 'POST',
        headers: { authorization: `Bearer ${memberJwt}` },
      }),
    );
    expect(r.status).toBe(403);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe('owner role required');
  });

  it('allows an owner-role token through to the batch-run path (200)', async () => {
    if (!mongoReachable) return;
    setMeilisearchClientForTests(makeUnconfiguredMeili());
    const { meilisearchBackfillRoutes } =
      await import('../src/routes/admin-backfill-meilisearch.ts');
    const app = new Elysia().use(meilisearchBackfillRoutes);
    const r = await app.handle(
      new Request(
        'http://localhost/api/admin/enrichment/backfill-meilisearch',
        ownerAuthed({ method: 'POST' }),
      ),
    );
    // Semantic search isn't configured, so the handler 400s — but that's the
    // business-logic path, not the auth gate, confirming the owner token got
    // past `requireOwner`.
    expect(r.status).toBe(400);
  });
});
