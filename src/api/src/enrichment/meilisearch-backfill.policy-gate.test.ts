// The vector backfill under Meilisearch's embedder address policy (#3315),
// end to end against a real Mongo (skip-passes without one): the batch is
// refused before it is submitted, the `meili` stage's worker_config row is
// paused with the reason, the cursor is retained, and a resume after the
// policy fix lets the same batch through and clears the reason.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { ObjectId } from 'mongodb';
import { closeDb, getDb, isDbConnected } from '../db/client.ts';
import { withTestDb } from '../db/test-db.test-helpers.ts';
import { WorkerConfigRepo, type WorkerConfigDoc } from '../workers/worker-config.repo.ts';
import { runMeilisearchBackfill } from './meilisearch-backfill.ts';
import {
  ASSETS_INDEX,
  createMeilisearchClient,
  setMeilisearchClientForTests,
} from './meilisearch-client.ts';
import {
  EMBEDDER_PROBE_TTL_MS,
  _configureEmbeddingGateForTests,
} from './meilisearch-embedding-gate.ts';
import { EMBEDDING_POLICY_KEY } from './meilisearch-embedding-policy.ts';
import {
  makeFakeFetch,
  type CapturedRequest,
  type FakeFetchOpts,
} from './meilisearch-test-harness.ts';

type Route = NonNullable<FakeFetchOpts['routes']>[number];

const rejected =
  'Index `assets`: While embedding documents for embedder `caption`: runtime error: could not reach embedding server: bad uri: Rejected URI';

const rejectedProbe: Route = {
  method: 'POST',
  pathPrefix: `/indexes/${ASSETS_INDEX}/search`,
  status: 400,
  body: { code: 'vector_embedding_error', message: rejected },
};
const healthyProbe: Route = {
  method: 'POST',
  pathPrefix: `/indexes/${ASSETS_INDEX}/search`,
  body: { hits: [], estimatedTotalHits: 0 },
};

/** Ordered most-specific first: `makeFakeFetch` matches on path PREFIX and
 * the first hit wins, so the bare `POST /indexes` (create index) must sit
 * below the document and search routes it would otherwise swallow. */
function fakeMeilisearch(probe: Route): Route[] {
  return [
    {
      method: 'POST',
      pathPrefix: `/indexes/${ASSETS_INDEX}/documents`,
      status: 202,
      body: { taskUid: 2 },
    },
    { method: 'GET', pathPrefix: '/tasks/2', body: { uid: 2, status: 'succeeded' } },
    probe,
    { method: 'POST', pathPrefix: '/indexes', status: 409, body: { code: 'index_already_exists' } },
    {
      method: 'GET',
      pathPrefix: `/indexes/${ASSETS_INDEX}/settings/embedders`,
      body: { caption: { source: 'ollama', model: 'bge-m3' } },
    },
    { method: 'GET', pathPrefix: `/indexes/${ASSETS_INDEX}/settings`, body: {} },
    {
      method: 'PATCH',
      pathPrefix: `/indexes/${ASSETS_INDEX}/settings`,
      status: 202,
      body: { taskUid: 1 },
    },
    { method: 'GET', pathPrefix: '/tasks/1', body: { uid: 1, status: 'succeeded' } },
    {
      method: 'GET',
      pathPrefix: `/indexes/${ASSETS_INDEX}/stats`,
      body: { numberOfDocuments: 0, numberOfEmbeddedDocuments: 0, isIndexing: false },
    },
    { method: 'GET', pathPrefix: '/health', body: { status: 'available' } },
  ];
}

const documentWrites = (calls: CapturedRequest[]): CapturedRequest[] =>
  calls.filter(
    (c) => c.method === 'POST' && new URL(c.url).pathname === `/indexes/${ASSETS_INDEX}/documents`,
  );

withTestDb(`maple_test_meili_backfill_policy_${process.pid}`);

let mongoReachable = false;

beforeAll(async () => {
  await closeDb();
});

beforeEach(async () => {
  try {
    await getDb();
    mongoReachable = isDbConnected();
  } catch {
    mongoReachable = false;
    return;
  }
  await (await getDb()).dropDatabase();
});

afterEach(() => {
  setMeilisearchClientForTests(null);
  _configureEmbeddingGateForTests(null);
});

afterAll(async () => {
  const db = await getDb().catch(() => null);
  if (db) await db.dropDatabase();
  await closeDb();
});

async function seedAsset(mapleId: string): Promise<void> {
  const db = await getDb();
  await db.collection('assets').insertOne({
    _id: new ObjectId(),
    maple_id: mapleId,
    fileinfo: [
      { library_id: new ObjectId(), path: '', filename: `${mapleId}.jpg`, deleted_at: null },
    ],
    description: 'a red bicycle outside a bike shop',
  });
}

async function meiliConfig(): Promise<ReturnType<WorkerConfigRepo['load']>> {
  const db = await getDb();
  return new WorkerConfigRepo(db.collection<WorkerConfigDoc>('worker_config')).load('meili');
}

describe('vector backfill — embedder policy gate (#3315)', () => {
  it('refuses the batch, pauses the meili stage with the reason, keeps the cursor, and recovers on resume', async () => {
    if (!mongoReachable) return;
    await seedAsset('asset-policy-1');
    const routes = fakeMeilisearch(rejectedProbe);
    const { fetchImpl, calls } = makeFakeFetch({ routes });
    let clock = 5_000_000;
    // Real pause side effect (writes worker_config through the DB); only
    // the clock is controlled so the rejected verdict's short TTL can elapse.
    _configureEmbeddingGateForTests({ now: () => clock });
    setMeilisearchClientForTests(
      createMeilisearchClient({
        url: 'http://meili.local:7700',
        fetchImpl,
        semantic: true,
        embedderModel: 'bge-m3',
        taskPollIntervalMs: 0,
      }),
    );

    const refused = await runMeilisearchBackfill(50, true);

    expect(refused.retryable).toBe(true);
    expect(refused.blocked).toBe(false);
    expect(refused.complete).toBe(false);
    expect(refused.upserted).toBe(0);
    expect(refused.retryableError).toContain('Paused automatically');
    expect(refused.retryableError).toContain(EMBEDDING_POLICY_KEY);
    expect(documentWrites(calls)).toHaveLength(0);
    const pausedConfig = await meiliConfig();
    expect(pausedConfig?.paused).toBe(true);
    expect(pausedConfig?.pause_reason).toContain(EMBEDDING_POLICY_KEY);

    // Operator restarts Meilisearch with the corrected policy and resumes
    // the stage; the retained cursor lets the same batch land.
    routes.splice(routes.indexOf(rejectedProbe), 1, healthyProbe);
    clock += EMBEDDER_PROBE_TTL_MS.rejected;
    const db = await getDb();
    await new WorkerConfigRepo(db.collection<WorkerConfigDoc>('worker_config')).patch('meili', {
      paused: false,
    });

    const landed = await runMeilisearchBackfill(50, false);

    expect(landed.retryable).toBe(false);
    expect(landed.upserted).toBe(1);
    expect(landed.complete).toBe(true);
    expect(documentWrites(calls)).toHaveLength(1);
    const resumedConfig = await meiliConfig();
    expect(resumedConfig?.paused).toBe(false);
    expect(resumedConfig).not.toHaveProperty('pause_reason');
  });
});
