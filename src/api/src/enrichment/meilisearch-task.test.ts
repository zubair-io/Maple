import { describe, expect, it } from 'bun:test';
import {
  ASSETS_INDEX,
  createMeilisearchClient,
  type MeilisearchAssetDoc,
} from './meilisearch-client.ts';
import { assetsIndexSettingsMatch } from './meilisearch-index-settings.ts';
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

  it('waits for a single-asset upsert before the worker can stamp it complete', async () => {
    const { fetchImpl, calls } = makeFakeFetch({
      routes: [
        {
          method: 'POST',
          pathPrefix: `/indexes/${ASSETS_INDEX}/documents`,
          status: 202,
          body: { taskUid: 41 },
        },
        {
          method: 'GET',
          pathPrefix: '/tasks/41',
          body: { uid: 41, status: 'succeeded' },
        },
      ],
    });
    const client = createMeilisearchClient({
      url: 'http://meili.local:7700',
      fetchImpl,
      taskPollIntervalMs: 0,
    });

    await client.upsertOrThrow(sampleDoc);

    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
      `/indexes/${ASSETS_INDEX}/documents`,
      '/tasks/41',
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
          body: {
            uid: 43,
            status: 'failed',
            error: { message: 'invalid document' },
          },
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

  it('tolerates an asynchronous create-index race, then applies settings', async () => {
    const { fetchImpl, calls } = makeFakeFetch({
      routes: [
        {
          method: 'POST',
          pathPrefix: '/indexes',
          status: 202,
          body: { taskUid: 45 },
        },
        {
          method: 'GET',
          pathPrefix: '/tasks/45',
          body: {
            uid: 45,
            status: 'failed',
            error: {
              message: 'Index `assets` already exists.',
              code: 'index_already_exists',
              type: 'invalid_request',
            },
          },
        },
        {
          method: 'PATCH',
          pathPrefix: `/indexes/${ASSETS_INDEX}/settings`,
          status: 202,
          body: { taskUid: 46 },
        },
        {
          method: 'GET',
          pathPrefix: '/tasks/46',
          body: { uid: 46, status: 'succeeded' },
        },
      ],
    });
    const client = createMeilisearchClient({
      url: 'http://meili.local:7700',
      fetchImpl,
      taskPollIntervalMs: 0,
    });

    await client.ensureIndex();

    expect(calls.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual([
      'POST /indexes',
      'GET /tasks/45',
      `GET /indexes/${ASSETS_INDEX}/settings`,
      `PATCH /indexes/${ASSETS_INDEX}/settings`,
      'GET /tasks/46',
    ]);
  });

  it('does not enqueue a settings task when the managed settings are unchanged', async () => {
    const matchingSettings = {
      searchableAttributes: ['filename', 'searchBlob', 'description', 'people', 'ocrText'],
      // Meilisearch stores filterableAttributes in a BTreeSet and returns it
      // alphabetically sorted from GET /settings, never in submission order —
      // this mock reproduces that so the no-op check is exercised honestly.
      filterableAttributes: [
        'deletedAt',
        'folderId',
        'hidden',
        'isScreenshot',
        'mediaType',
        'people',
        'visionActivity',
        'visionSceneType',
        'visionSubjects',
      ],
      sortableAttributes: ['capturedAt'],
      embedders: {
        caption: {
          source: 'ollama',
          url: 'http://ollama.lan:11434/api/embed',
          model: 'bge-m3',
          documentTemplate: '{{ doc.searchBlob }} {{ doc.description }} {{ doc.people }}',
          dimensions: 1024,
        },
      },
    };
    const { fetchImpl, calls } = makeFakeFetch({
      routes: [
        {
          method: 'POST',
          pathPrefix: '/indexes',
          status: 409,
          body: { code: 'index_already_exists' },
        },
        {
          method: 'GET',
          pathPrefix: `/indexes/${ASSETS_INDEX}/settings`,
          body: matchingSettings,
        },
      ],
    });
    const client = createMeilisearchClient({
      url: 'http://meili.local:7700',
      fetchImpl,
      semantic: true,
      embedderUrl: 'http://ollama.lan:11434',
      embedderModel: 'bge-m3',
    });

    await client.ensureIndex();

    expect(calls.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual([
      'POST /indexes',
      `GET /indexes/${ASSETS_INDEX}/settings`,
    ]);
  });

  it('honors the configured asynchronous task timeout', async () => {
    const { fetchImpl } = makeFakeFetch({
      routes: [
        {
          method: 'POST',
          pathPrefix: `/indexes/${ASSETS_INDEX}/documents`,
          status: 202,
          body: { taskUid: 44 },
        },
        {
          method: 'GET',
          pathPrefix: '/tasks/44',
          body: { uid: 44, status: 'processing' },
        },
      ],
    });
    const client = createMeilisearchClient({
      url: 'http://meili.local:7700',
      fetchImpl,
      taskPollIntervalMs: 0,
      taskTimeoutMs: 0,
    });

    expect(client.upsertBatchOrThrow!([sampleDoc])).rejects.toThrow('task 44 timed out');
  });

  it('matches filterable/sortable attributes Meilisearch returned in sorted (not submission) order', () => {
    const expected = {
      searchableAttributes: ['filename', 'description', 'people'],
      // Submission order, as `assetsIndexSettings` would produce it.
      filterableAttributes: ['people', 'folderId', 'hidden'],
      sortableAttributes: ['capturedAt', 'addedAt'],
      embedders: null,
    };
    const actual = {
      searchableAttributes: ['filename', 'description', 'people'],
      // What GET /settings actually returns — alphabetically sorted, since
      // Meilisearch stores these fields as a BTreeSet.
      filterableAttributes: ['folderId', 'hidden', 'people'],
      sortableAttributes: ['addedAt', 'capturedAt'],
      embedders: null,
    };
    expect(assetsIndexSettingsMatch(actual, expected)).toBe(true);
  });

  it('rejects a reordered searchableAttributes — its order is ranking-significant', () => {
    const expected = {
      searchableAttributes: ['filename', 'description', 'people'],
      filterableAttributes: ['folderId'],
      sortableAttributes: ['capturedAt'],
      embedders: null,
    };
    const actual = {
      searchableAttributes: ['description', 'filename', 'people'],
      filterableAttributes: ['folderId'],
      sortableAttributes: ['capturedAt'],
      embedders: null,
    };
    expect(assetsIndexSettingsMatch(actual, expected)).toBe(false);
  });

  it('reports semantic embedder health and raw index populations', async () => {
    const { fetchImpl } = makeFakeFetch({
      routes: [
        { method: 'GET', pathPrefix: '/health', body: { status: 'available' } },
        {
          method: 'GET',
          pathPrefix: `/indexes/${ASSETS_INDEX}/settings/embedders`,
          body: { caption: { source: 'ollama', model: 'bge-m3' } },
        },
        {
          method: 'GET',
          pathPrefix: `/indexes/${ASSETS_INDEX}/stats`,
          body: {
            numberOfDocuments: 10,
            numberOfEmbeddedDocuments: 7,
            isIndexing: true,
          },
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
