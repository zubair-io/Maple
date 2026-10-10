/**
 * `POST /api/search/assets` with the in-process engine selected (#4463): a hybrid request takes
 * the child's fused candidates through the request's own scope; a lexical one, or any request
 * while the child is down, answers exactly as before.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { createServiceApiKey } from '../src/auth/service-api-keys.ts';
import { insertUser } from '../src/db/repos/auth.users.repo.ts';
import {
  setMeilisearchClientForTests,
  type MeilisearchClient,
} from '../src/enrichment/meilisearch-client.ts';
import {
  _resetServiceSearchRateLimitsForTests,
  serviceAssetSearchRoutes,
} from '../src/routes/service-asset-search.ts';
import { seedSearchAsset } from '../src/db/repos/search.test-helpers.ts';
import {
  createLiveTestDatabase,
  insertFolder,
  type LiveTestDatabase,
} from '../src/db/sqlite/test-sqlite.test-helpers.ts';
import {
  resetSearchEngineSelectionForTests,
  saveSearchEngine,
} from '../src/search/search-engine-selection.ts';
import { setInProcessSearchForTests } from '../src/search/search-pool.ts';
import { fakeInProcessSearch } from '../src/search/search.test-helpers.ts';

let live: LiveTestDatabase;
let serviceKey = '';

const UNCONFIGURED_MEILI: MeilisearchClient = {
  isConfigured: () => false,
  semanticConfigured: () => false,
  health: async () => false,
  ensureIndex: async () => {},
  upsert: async () => {},
  upsertOrThrow: async () => {},
  tombstone: async () => {},
  search: async () => ({ ids: [], estimatedTotal: 0 }),
};

function request(body: Record<string, unknown>): Promise<Response> {
  return new Elysia().use(serviceAssetSearchRoutes).handle(
    new Request('http://localhost/api/search/assets', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${serviceKey}` },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(async () => {
  live = await createLiveTestDatabase();
  const libraryId = insertFolder(live.db, { path: '/lib', slug: 'service-in-process' });
  const createdBy = await insertUser({
    email: 'owner@maple.test',
    role: 'owner',
    created_at: new Date().toISOString(),
    last_seen_at: null,
  });
  serviceKey = (await createServiceApiKey({ name: 'in-process', createdBy })).key;
  seedSearchAsset(live.db, libraryId, {
    mapleId: 'clip',
    filename: 'clip.mov',
    mediaKind: 'video',
    capturedAt: '2025-07-01T00:00:00.000Z',
    searchBlob: 'furnace',
  });
  seedSearchAsset(live.db, libraryId, {
    mapleId: 'still',
    filename: 'still.dng',
    capturedAt: '2025-07-02T00:00:00.000Z',
    searchBlob: 'furnace',
  });
  seedSearchAsset(live.db, libraryId, {
    mapleId: 'private',
    filename: 'private.dng',
    hidden: true,
    searchBlob: 'furnace',
  });
  _resetServiceSearchRateLimitsForTests();
  setMeilisearchClientForTests(UNCONFIGURED_MEILI);
  resetSearchEngineSelectionForTests();
  await saveSearchEngine('in-process');
});

afterEach(() => {
  setInProcessSearchForTests(null);
  setMeilisearchClientForTests(null);
  resetSearchEngineSelectionForTests();
  live.close();
});

describe('POST /api/search/assets with the in-process engine', () => {
  it('ranks by the fused order under the request scope, with fused scores', async () => {
    setInProcessSearchForTests(fakeInProcessSearch(['private', 'still', 'gone', 'clip']));

    const body = await (await request({ query: 'heating repair', limit: 1 })).json();

    expect(body).toMatchObject({ modeRequested: 'hybrid', modeUsed: 'hybrid', total: 2 });
    expect(body.fallbackReason).toBeNull();
    expect(body.results).toEqual([{ assetId: 'still', score: 1 / 62 }]);
  });

  it('applies the media type and capture window in SQL', async () => {
    setInProcessSearchForTests(fakeInProcessSearch(['private', 'still', 'clip']));

    const videos = await (
      await request({ query: 'furnace', filters: { mediaTypes: ['video'] } })
    ).json();
    const july2 = await (await request({ query: 'furnace', from: '2025-07-02' })).json();

    expect(videos.results.map((hit: { assetId: string }) => hit.assetId)).toEqual(['clip']);
    expect(july2.results.map((hit: { assetId: string }) => hit.assetId)).toEqual(['still']);
  });

  it('leaves a lexical request and a down child on the existing fallback path', async () => {
    const engine = fakeInProcessSearch(['clip']);
    setInProcessSearchForTests(engine);
    const lexical = await (await request({ query: 'furnace', mode: 'lexical' })).json();
    setInProcessSearchForTests(fakeInProcessSearch(null));
    const down = await (await request({ query: 'furnace' })).json();

    expect(engine.queries).toEqual([]);
    expect(lexical).toMatchObject({
      modeUsed: 'lexical',
      fallbackReason: 'meilisearch_unavailable',
    });
    expect(down).toMatchObject({ modeUsed: 'lexical', fallbackReason: 'meilisearch_unavailable' });
    expect(down.results.map((hit: { assetId: string }) => hit.assetId).sort()).toEqual([
      'clip',
      'still',
    ]);
  });
});
