/**
 * Backfill generation reset on a document-shape change (#2384).
 *
 * `runBackfillBatch` short-circuits on `state.completed_at`, so a deployment
 * whose previous backfill finished would treat the v8 migration as already
 * done and re-upsert nothing — the operator sees "complete" and the index
 * silently keeps v7 documents. The stored shape version makes the state
 * self-invalidating so nobody has to remember to pass `reset=true`.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { MongoClient, type Db } from 'mongodb';

const TEST_DB = `maple_test_meili_backfill_gen_${process.pid}`;
process.env.MAPLE_MONGO_DB = TEST_DB;
const MONGO_URI = process.env.MAPLE_MONGO_URI ?? 'mongodb://localhost:27017';

let mongo: MongoClient | null = null;
let reachable = false;
let db: Db | null = null;

beforeAll(async () => {
  const c = new MongoClient(MONGO_URI, {
    serverSelectionTimeoutMS: 1500,
    connectTimeoutMS: 1500,
  });
  try {
    await c.connect();
    await c.db('admin').command({ ping: 1 });
    mongo = c;
    reachable = true;
  } catch {
    try {
      await c.close();
    } catch {}
    console.log('[meilisearch-backfill-shape-generation.test] skipping: MongoDB unreachable');
    return;
  }
  db = mongo.db(TEST_DB);
  await db.dropDatabase();
  const { closeDb } = await import('../src/db/client.ts');
  await closeDb();
});

beforeEach(async () => {
  if (!reachable) return;
  await db!.collection('meilisearch_backfill_state').deleteMany({});
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

async function seedState(extra: Record<string, unknown>): Promise<void> {
  await db!.collection('meilisearch_backfill_state').insertOne({
    _id: 'assets' as never,
    cursor: null,
    scanned: 0,
    upserted: 0,
    skipped: 0,
    errors: 0,
    started_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    completed_at: null,
    ...extra,
  });
}

describe('backfill state generation', () => {
  it('discards a completed state written under an older document shape', async () => {
    if (!reachable) return;
    const { loadBackfillStateForTests } = await import('../src/enrichment/meilisearch-backfill.ts');
    const { ASSET_DOC_SHAPE_VERSION } =
      await import('../src/enrichment/meilisearch-embedder-template.ts');
    await seedState({
      scanned: 999,
      upserted: 999,
      completed_at: '2026-01-01T00:00:00.000Z',
      doc_shape_version: ASSET_DOC_SHAPE_VERSION - 1,
    });

    const state = await loadBackfillStateForTests(false);

    expect(state.completed_at).toBeNull();
    expect(state.scanned).toBe(0);
    expect(state.doc_shape_version).toBe(ASSET_DOC_SHAPE_VERSION);
  });

  it('discards a completed state that predates shape stamping', async () => {
    if (!reachable) return;
    const { loadBackfillStateForTests } = await import('../src/enrichment/meilisearch-backfill.ts');
    await seedState({ scanned: 5, upserted: 5, completed_at: '2026-01-01T00:00:00.000Z' });

    expect((await loadBackfillStateForTests(false)).completed_at).toBeNull();
  });

  it('resumes an in-progress state of the current shape', async () => {
    if (!reachable) return;
    const { loadBackfillStateForTests } = await import('../src/enrichment/meilisearch-backfill.ts');
    const { ASSET_DOC_SHAPE_VERSION } =
      await import('../src/enrichment/meilisearch-embedder-template.ts');
    await seedState({ scanned: 42, upserted: 42, doc_shape_version: ASSET_DOC_SHAPE_VERSION });

    expect((await loadBackfillStateForTests(false)).scanned).toBe(42);
  });

  it('stamps the current shape on a brand-new state', async () => {
    if (!reachable) return;
    const { loadBackfillStateForTests } = await import('../src/enrichment/meilisearch-backfill.ts');
    const { ASSET_DOC_SHAPE_VERSION } =
      await import('../src/enrichment/meilisearch-embedder-template.ts');
    expect((await loadBackfillStateForTests(false)).doc_shape_version).toBe(
      ASSET_DOC_SHAPE_VERSION,
    );
  });
});
