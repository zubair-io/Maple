import { describe, expect, it } from 'bun:test';
import { explainEmbeddingPolicyError } from './meilisearch-embedding-policy.ts';
import { MeilisearchSearchError } from './meilisearch-search-error.ts';
import { readMeilisearchSemanticStatus } from './meilisearch-semantic-status.ts';
import { MeilisearchTaskError, waitForMeilisearchTask } from './meilisearch-transport.ts';
import { makeFakeFetch } from './meilisearch-test-harness.ts';

const rejected =
  'While embedding documents: could not reach embedding server: bad uri: Rejected URI';
const policyKey = 'MEILI_EXPERIMENTAL_ALLOWED_IP_NETWORKS';

function config(fetchImpl: typeof fetch) {
  return {
    url: 'http://meili.local:7700',
    apiKey: undefined,
    fetchImpl,
    taskPollIntervalMs: 0,
    taskTimeoutMs: 1000,
  };
}

describe('Meilisearch embedding IP policy diagnostics (#3315)', () => {
  it('preserves unrelated connection and URI errors without policy advice', () => {
    for (const message of ['connection refused', 'bad uri: invalid port', 'Rejected document']) {
      expect(explainEmbeddingPolicyError(message)).toBe(message);
    }
  });

  it('keeps the upstream search status and code while explaining the remedy', () => {
    const error = new MeilisearchSearchError(
      400,
      JSON.stringify({
        code: 'vector_embedding_error',
        type: 'invalid_request',
        message: rejected,
      }),
    );
    expect(error.details.status).toBe(400);
    expect(error.details.code).toBe('vector_embedding_error');
    expect(error.details.message).toContain(rejected);
    expect(error.message).toContain(policyKey);
    expect(error.message).toContain('allow only');
  });

  it('explains failed indexing tasks without retrying or reconfiguring the index', async () => {
    const { fetchImpl, calls } = makeFakeFetch({
      routes: [
        {
          method: 'GET',
          pathPrefix: '/tasks/12',
          body: {
            uid: 12,
            status: 'failed',
            error: { code: 'vector_embedding_error', message: rejected },
          },
        },
      ],
    });
    let failure: unknown;
    try {
      await waitForMeilisearchTask(
        config(fetchImpl),
        {
          ok: true,
          status: 202,
          body: { taskUid: 12 },
          errorText: null,
        },
        'upsert',
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(MeilisearchTaskError);
    expect((failure as MeilisearchTaskError).code).toBe('vector_embedding_error');
    expect((failure as Error).message).toContain(policyKey);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('GET');
  });

  it('reports failed semantic readiness even when the Meilisearch server is healthy', async () => {
    const { fetchImpl } = makeFakeFetch({
      routes: [
        { method: 'GET', pathPrefix: '/health', body: { status: 'available' } },
        {
          method: 'GET',
          pathPrefix: '/indexes/assets/settings/embedders',
          body: { caption: { source: 'ollama', model: 'bge-m3' } },
        },
        {
          method: 'GET',
          pathPrefix: '/indexes/assets/stats',
          body: { numberOfDocuments: 3, numberOfEmbeddedDocuments: 0, isIndexing: false },
        },
        {
          method: 'POST',
          pathPrefix: '/indexes/assets/search',
          status: 400,
          body: { code: 'vector_embedding_error', message: rejected },
        },
      ],
    });
    const status = await readMeilisearchSemanticStatus(
      {
        ...config(fetchImpl),
        semantic: true,
        embedderModel: 'bge-m3',
        semanticRatio: 0.5,
      },
      'assets',
      'caption',
    );
    expect(status.meilisearchReachable).toBe(true);
    expect(status.embedderConfigured).toBe(true);
    expect(status.embedderReachable).toBe(false);
    expect(status.error).toContain(policyKey);
  });
});
