import { describe, expect, it } from 'bun:test';
import {
  ASSETS_INDEX,
  createMeilisearchClient,
  type MeilisearchAssetDoc,
} from './meilisearch-client.ts';
import { makeFakeFetch } from './meilisearch-test-harness.ts';

const sampleDoc: MeilisearchAssetDoc = {
  id: 'task-test',
  searchBlob: 'task test',
  folderId: '64b64c16ab08e6c474227abc',
  capturedAt: null,
  deletedAt: null,
};

describe('Meilisearch asynchronous tasks', () => {
  it('reports configured state from an explicit URL', () => {
    const client = createMeilisearchClient({
      url: 'http://meili.local:7700',
      fetchImpl: globalThis.fetch.bind(globalThis),
    });
    expect(client.isConfigured()).toBe(true);
  });

  it('reads configured state from MAPLE_MEILISEARCH_URL', () => {
    const prior = process.env.MAPLE_MEILISEARCH_URL;
    process.env.MAPLE_MEILISEARCH_URL = 'http://meili.local:7700';
    try {
      expect(createMeilisearchClient().isConfigured()).toBe(true);
    } finally {
      if (prior === undefined) delete process.env.MAPLE_MEILISEARCH_URL;
      else process.env.MAPLE_MEILISEARCH_URL = prior;
    }
  });

  it('waits for an accepted bulk upsert task to succeed', async () => {
    const { fetchImpl, calls } = makeFakeFetch({
      routes: [
        {
          method: 'POST',
          pathPrefix: `/indexes/${ASSETS_INDEX}/documents`,
          status: 202,
          body: { taskUid: 42 },
        },
        {
          method: 'GET',
          pathPrefix: '/tasks/42',
          body: { uid: 42, status: 'succeeded' },
        },
      ],
    });
    const client = createMeilisearchClient({
      url: 'http://meili.local:7700',
      fetchImpl,
      taskPollIntervalMs: 0,
    });

    await client.upsertBatchOrThrow!([sampleDoc]);

    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
      `/indexes/${ASSETS_INDEX}/documents`,
      '/tasks/42',
    ]);
  });

  it('surfaces a failed asynchronous bulk upsert task', async () => {
    const { fetchImpl } = makeFakeFetch({
      routes: [
        {
          method: 'POST',
          pathPrefix: `/indexes/${ASSETS_INDEX}/documents`,
          status: 202,
          body: { taskUid: 43 },
        },
        {
          method: 'GET',
          pathPrefix: '/tasks/43',
          body: { uid: 43, status: 'failed', error: { message: 'invalid document' } },
        },
      ],
    });
    const client = createMeilisearchClient({
      url: 'http://meili.local:7700',
      fetchImpl,
      taskPollIntervalMs: 0,
    });

    expect(client.upsertBatchOrThrow!([sampleDoc])).rejects.toThrow('task 43 failed');
  });

  it('reports semantic embedder health and raw index populations', async () => {
    const { fetchImpl } = makeFakeFetch({
      routes: [
        { method: 'GET', pathPrefix: '/health', body: { status: 'available' } },
        {
          method: 'GET',
          pathPrefix: `/indexes/${ASSETS_INDEX}/settings/embedders`,
          body: { caption: { source: 'ollama', model: 'nomic-embed-text' } },
        },
        {
          method: 'GET',
          pathPrefix: `/indexes/${ASSETS_INDEX}/stats`,
          body: { numberOfDocuments: 10, numberOfEmbeddedDocuments: 7, isIndexing: true },
        },
        {
          method: 'POST',
          pathPrefix: `/indexes/${ASSETS_INDEX}/search`,
          body: { hits: [], estimatedTotalHits: 0 },
        },
      ],
    });
    const client = createMeilisearchClient({
      url: 'http://meili.local:7700',
      fetchImpl,
      semantic: true,
    });

    const status = await client.semanticStatus!();

    expect(status.meilisearchReachable).toBe(true);
    expect(status.embedderConfigured).toBe(true);
    expect(status.embedderReachable).toBe(true);
    expect(status.indexedDocumentCount).toBe(10);
    expect(status.vectorizedDocumentCount).toBe(7);
    expect(status.isIndexing).toBe(true);
    expect(status.error).toBeNull();
  });
});
