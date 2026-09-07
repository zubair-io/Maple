import { afterEach, describe, expect, it } from 'bun:test';
import {
  ASSETS_INDEX,
  createMeilisearchClient,
  type MeilisearchAssetDoc,
} from './meilisearch-client.ts';
import {
  EMBEDDER_PROBE_TTL_MS,
  MeilisearchEmbedderPolicyError,
  _configureEmbeddingGateForTests,
  withEmbedderPolicyGate,
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

const doc: MeilisearchAssetDoc = {
  id: 'gate-test',
  searchBlob: 'gate test',
  folderId: '64b64c16ab08e6c474227abc',
  capturedAt: null,
  deletedAt: null,
};

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

function statusRoutes(probe: Route): Route[] {
  return [
    { method: 'GET', pathPrefix: '/health', body: { status: 'available' } },
    {
      method: 'GET',
      pathPrefix: `/indexes/${ASSETS_INDEX}/settings/embedders`,
      body: { caption: { source: 'ollama', model: 'bge-m3' } },
    },
    {
      method: 'GET',
      pathPrefix: `/indexes/${ASSETS_INDEX}/stats`,
      body: { numberOfDocuments: 3, numberOfEmbeddedDocuments: 0, isIndexing: false },
    },
    probe,
  ];
}

function documentRoutes(task: { uid: number; status: string; error?: unknown }): Route[] {
  return [
    {
      method: 'POST',
      pathPrefix: `/indexes/${ASSETS_INDEX}/documents`,
      status: 202,
      body: { taskUid: task.uid },
    },
    { method: 'GET', pathPrefix: `/tasks/${task.uid}`, body: task },
  ];
}

/** A client over a fake Meilisearch whose route table can be edited after
 * construction — `makeFakeFetch` reads `routes` on every call, so a test can
 * "fix the policy" mid-flight by swapping the search probe. */
function harness(routes: Route[], opts: { semantic?: boolean } = {}) {
  const { fetchImpl, calls } = makeFakeFetch({ routes });
  const pauses: string[] = [];
  let clock = 1_000_000;
  _configureEmbeddingGateForTests({
    pauseStage: async (reason) => {
      pauses.push(reason);
    },
    now: () => clock,
  });
  const client = createMeilisearchClient({
    url: 'http://meili.local:7700',
    fetchImpl,
    semantic: opts.semantic ?? true,
    embedderModel: 'bge-m3',
    taskPollIntervalMs: 0,
  });
  return { client, calls, pauses, routes, advance: (ms: number) => void (clock += ms) };
}

const pathOf = (call: CapturedRequest): string => new URL(call.url).pathname;
const documentWrites = (calls: CapturedRequest[]): CapturedRequest[] =>
  calls.filter((c) => c.method === 'POST' && pathOf(c) === `/indexes/${ASSETS_INDEX}/documents`);
const probes = (calls: CapturedRequest[]): CapturedRequest[] =>
  calls.filter((c) => c.method === 'POST' && pathOf(c) === `/indexes/${ASSETS_INDEX}/search`);

afterEach(() => {
  _configureEmbeddingGateForTests(null);
});

describe('withEmbedderPolicyGate (#3315)', () => {
  it('pauses the meili stage with the policy hint and submits nothing when the embedder is rejected', async () => {
    const { client, calls, pauses } = harness([
      ...statusRoutes(rejectedProbe),
      ...documentRoutes({ uid: 7, status: 'succeeded' }),
    ]);

    await expect(
      withEmbedderPolicyGate(client, () => client.upsertBatchOrThrow!([doc])),
    ).rejects.toBeInstanceOf(MeilisearchEmbedderPolicyError);

    expect(documentWrites(calls)).toHaveLength(0);
    expect(pauses).toHaveLength(1);
    expect(pauses[0]).toContain('Paused automatically');
    expect(pauses[0]).toContain('Rejected URI');
    expect(pauses[0]).toContain(EMBEDDING_POLICY_KEY);
    expect(pauses[0]).toContain('resume this stage');
  });

  it('lets writes flow on a healthy probe and trusts that verdict for a minute', async () => {
    const { client, calls, pauses, advance } = harness([
      ...statusRoutes(healthyProbe),
      ...documentRoutes({ uid: 7, status: 'succeeded' }),
    ]);

    await withEmbedderPolicyGate(client, () => client.upsertBatchOrThrow!([doc]));
    await withEmbedderPolicyGate(client, () => client.upsertBatchOrThrow!([doc]));
    expect(documentWrites(calls)).toHaveLength(2);
    expect(probes(calls)).toHaveLength(1);

    advance(EMBEDDER_PROBE_TTL_MS.healthy);
    await withEmbedderPolicyGate(client, () => client.upsertBatchOrThrow!([doc]));
    expect(documentWrites(calls)).toHaveLength(3);
    expect(probes(calls)).toHaveLength(2);
    expect(pauses).toHaveLength(0);
  });

  it('is a passthrough when semantic search is off — no embedder, nothing to probe', async () => {
    const { client, calls, pauses } = harness(
      [...statusRoutes(rejectedProbe), ...documentRoutes({ uid: 7, status: 'succeeded' })],
      { semantic: false },
    );

    await withEmbedderPolicyGate(client, () => client.upsertBatchOrThrow!([doc]));

    expect(documentWrites(calls)).toHaveLength(1);
    expect(probes(calls)).toHaveLength(0);
    expect(calls.some((c) => pathOf(c) === '/health')).toBe(false);
    expect(pauses).toHaveLength(0);
  });

  it('re-checks a rejection quickly, so a resume after the policy fix goes through', async () => {
    const { client, calls, pauses, routes, advance } = harness([
      ...statusRoutes(rejectedProbe),
      ...documentRoutes({ uid: 7, status: 'succeeded' }),
    ]);
    const gated = () => withEmbedderPolicyGate(client, () => client.upsertBatchOrThrow!([doc]));

    await expect(gated()).rejects.toBeInstanceOf(MeilisearchEmbedderPolicyError);
    // Same claim batch, moments later: the cached rejection stops the write
    // without another probe.
    await expect(gated()).rejects.toBeInstanceOf(MeilisearchEmbedderPolicyError);
    expect(probes(calls)).toHaveLength(1);
    expect(documentWrites(calls)).toHaveLength(0);

    // Operator restarts Meilisearch with the corrected policy and resumes.
    routes.splice(routes.indexOf(rejectedProbe), 1, healthyProbe);
    advance(EMBEDDER_PROBE_TTL_MS.rejected);
    await gated();
    expect(probes(calls)).toHaveLength(2);
    expect(documentWrites(calls)).toHaveLength(1);
    expect(pauses).toHaveLength(2);
  });

  it('pauses when the task itself reports the rejection after a healthy probe, and stops the batch', async () => {
    const { client, calls, pauses } = harness([
      ...statusRoutes(healthyProbe),
      ...documentRoutes({
        uid: 8,
        status: 'failed',
        error: { code: 'vector_embedding_error', message: rejected },
      }),
    ]);
    const gated = () => withEmbedderPolicyGate(client, () => client.upsertBatchOrThrow!([doc]));

    const failure = await gated().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(MeilisearchEmbedderPolicyError);
    expect((failure as Error).message).toContain(EMBEDDING_POLICY_KEY);
    expect(documentWrites(calls)).toHaveLength(1);
    // The task's own failure poll: exactly one GET, no waiting out the timeout.
    expect(calls.filter((c) => pathOf(c) === '/tasks/8')).toHaveLength(1);
    expect(pauses).toHaveLength(1);

    // The next write in the same batch is refused up front — remembered
    // rejection, no new probe, no new submission.
    await expect(gated()).rejects.toBeInstanceOf(MeilisearchEmbedderPolicyError);
    expect(documentWrites(calls)).toHaveLength(1);
    expect(probes(calls)).toHaveLength(1);
  });

  it('propagates unrelated write failures untouched, without pausing', async () => {
    const { client, pauses } = harness([
      ...statusRoutes(healthyProbe),
      ...documentRoutes({ uid: 9, status: 'failed', error: { message: 'invalid document' } }),
    ]);

    await expect(
      withEmbedderPolicyGate(client, () => client.upsertBatchOrThrow!([doc])),
    ).rejects.toThrow('task 9 failed');
    expect(pauses).toHaveLength(0);
  });
});
