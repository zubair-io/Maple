import { describe, expect, it } from 'bun:test';
import {
  explainEmbeddingPolicyError,
  isEmbeddingPolicyRejection,
} from './meilisearch-embedding-policy.ts';
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

  it('does not duplicate guidance when an error passes through multiple layers', () => {
    const explained = explainEmbeddingPolicyError(rejected);
    expect(explainEmbeddingPolicyError(explained)).toBe(explained);
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

describe('embedding policy rejection classification (#3315)', () => {
  it('recognises the rejection wherever it appears in a message', () => {
    expect(isEmbeddingPolicyRejection(rejected)).toBe(true);
    expect(isEmbeddingPolicyRejection(`meilisearch task 12 failed {"message":"${rejected}"}`)).toBe(
      true,
    );
    expect(isEmbeddingPolicyRejection('connection refused')).toBe(false);
    expect(isEmbeddingPolicyRejection(null)).toBe(false);
    expect(isEmbeddingPolicyRejection(undefined)).toBe(false);
  });

  it('flags the rejection on the semantic status so writers can gate on it', async () => {
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
      { ...config(fetchImpl), semantic: true, embedderModel: 'bge-m3', semanticRatio: 0.5 },
      'assets',
      'caption',
    );
    expect(status.embedderPolicyRejected).toBe(true);
  });

  it('does not flag an ordinary outage as a policy rejection', async () => {
    const { fetchImpl } = makeFakeFetch({
      routes: [{ method: 'GET', pathPrefix: '/health', status: 503, body: { status: 'down' } }],
    });
    const status = await readMeilisearchSemanticStatus(
      { ...config(fetchImpl), semantic: true, embedderModel: 'bge-m3', semanticRatio: 0.5 },
      'assets',
      'caption',
    );
    expect(status.meilisearchReachable).toBe(false);
    expect(status.embedderPolicyRejected).toBe(false);
  });

  it('fails a policy-rejected task on the first poll that reports it, flagged for callers', async () => {
    const { fetchImpl, calls } = makeFakeFetch({
      routes: [
        {
          method: 'GET',
          pathPrefix: '/tasks/13',
          body: {
            uid: 13,
            status: 'failed',
            error: { code: 'vector_embedding_error', message: rejected },
          },
        },
      ],
    });
    // A generous timeout the waiter must NOT sit out: the task is already
    // failed, so one poll is the whole wait.
    const failure = await waitForMeilisearchTask(
      { ...config(fetchImpl), taskTimeoutMs: 10 * 60 * 1000 },
      { ok: true, status: 202, body: { taskUid: 13 }, errorText: null },
      'batch upsert',
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(MeilisearchTaskError);
    expect((failure as MeilisearchTaskError).policyRejected).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('leaves policyRejected false on a task that failed for another reason', async () => {
    const { fetchImpl } = makeFakeFetch({
      routes: [
        {
          method: 'GET',
          pathPrefix: '/tasks/14',
          body: { uid: 14, status: 'failed', error: { code: 'invalid_document_fields' } },
        },
      ],
    });
    const failure = await waitForMeilisearchTask(
      config(fetchImpl),
      { ok: true, status: 202, body: { taskUid: 14 }, errorText: null },
      'batch upsert',
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(MeilisearchTaskError);
    expect((failure as MeilisearchTaskError).policyRejected).toBe(false);
  });
});
