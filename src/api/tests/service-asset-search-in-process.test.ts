/**
 * `POST /api/search/assets` with the in-process engine (#4463): a hybrid request takes the child's
 * fused candidates through the request's own scope; a lexical one, or any request while the child
 * is down, answers from the database's full-text path.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { createServiceApiKey } from '../src/auth/service-api-keys.ts';
import { insertUser } from '../src/db/repos/auth.users.repo.ts';
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
import { setInProcessSearchForTests } from '../src/search/search-pool.ts';
import { fakeInProcessSearch } from '../src/search/search.test-helpers.ts';

let live: LiveTestDatabase;
let serviceKey = '';

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
});

afterEach(() => {
  setInProcessSearchForTests(null);
  live.close();
});

describe('POST /api/search/assets with the in-process engine', () => {
  it('ranks by the fused order under the request scope, with fused scores', async () => {
    setInProcessSearchForTests(fakeInProcessSearch(['private', 'still', 'gone', 'clip']));

    const body = await (await request({ query: 'heating repair', limit: 1 })).json();

    expect(body).toMatchObject({
      modeRequested: 'hybrid',
      modeUsed: 'hybrid',
      total: 1,
      more: true,
    });
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

  it('returns a hidden asset only when includeHidden is set', async () => {
    setInProcessSearchForTests(fakeInProcessSearch(['private', 'still']));

    const hiddenOut = await (await request({ query: 'furnace' })).json();
    const hiddenIn = await (await request({ query: 'furnace', includeHidden: true })).json();

    expect(hiddenOut.results.map((hit: { assetId: string }) => hit.assetId)).toEqual(['still']);
    expect(hiddenIn.results.map((hit: { assetId: string }) => hit.assetId)).toEqual([
      'private',
      'still',
    ]);
  });

  it('answers a lexical request, and any request while the child is down, from the database', async () => {
    const engine = fakeInProcessSearch(['clip']);
    setInProcessSearchForTests(engine);
    const lexical = await (await request({ query: 'furnace', mode: 'lexical' })).json();
    setInProcessSearchForTests(fakeInProcessSearch(null));
    const down = await (await request({ query: 'furnace' })).json();

    expect(engine.queries).toEqual([]);
    expect(lexical).toMatchObject({ modeUsed: 'lexical', fallbackReason: null });
    expect(down).not.toHaveProperty('more');
    expect(down).not.toHaveProperty('capped');
    expect(down).toMatchObject({
      modeUsed: 'lexical',
      fallbackReason: 'search_engine_unavailable',
    });
    expect(down.results.map((hit: { assetId: string }) => hit.assetId).sort()).toEqual([
      'clip',
      'still',
    ]);
  });

  describe('the ranked window', () => {
    const fillers = (count: number, prefix = 'filler') =>
      Array.from({ length: count }, (_, index) => `${prefix}-${index}`);
    const ids = (body: { results: Array<{ assetId: string }> }) =>
      body.results.map((hit) => hit.assetId);

    it('finds scoped matches the child ranks between 150 and 2,000', async () => {
      const ranking = [...fillers(150), 'clip', ...fillers(1849, 'late'), 'still'];
      setInProcessSearchForTests(fakeInProcessSearch(ranking));

      const body = await (
        await request({ query: 'furnace', filters: { mediaTypes: ['video'] } })
      ).json();
      const dated = await (await request({ query: 'furnace', from: '2025-07-02' })).json();

      expect(ids(body)).toEqual(['clip']);
      expect(body).toMatchObject({ total: 1, more: false, capped: false });
      expect(ids(dated)).toEqual(['still']);
    });

    it('says a full window has more, and returns only the requested limit of it', async () => {
      const libraryId = insertFolder(live.db, { path: '/bulk', slug: 'bulk' });
      const bulk = fillers(100, 'bulk');
      bulk.forEach((mapleId) =>
        seedSearchAsset(live.db, libraryId, { mapleId, filename: `${mapleId}.dng` }),
      );
      setInProcessSearchForTests(fakeInProcessSearch([...bulk, ...fillers(200)]));

      const body = await (await request({ query: 'furnace', limit: 100 })).json();

      expect(body.results).toHaveLength(100);
      expect(body).toMatchObject({ total: 100, more: true, capped: false });
    });

    it('never reports a total larger than the results it delivers', async () => {
      const libraryId = insertFolder(live.db, { path: '/bulk', slug: 'bulk' });
      const bulk = fillers(150, 'bulk');
      bulk.forEach((mapleId) =>
        seedSearchAsset(live.db, libraryId, { mapleId, filename: `${mapleId}.dng` }),
      );
      setInProcessSearchForTests(fakeInProcessSearch(bulk));

      const body = await (await request({ query: 'furnace', limit: 20 })).json();

      expect(body.results).toHaveLength(20);
      expect(body).toMatchObject({ total: 20, more: true });
    });

    it('says capped when the child still had hits past the deepest window', async () => {
      setInProcessSearchForTests(fakeInProcessSearch(fillers(5_200)));

      const body = await (
        await request({ query: 'furnace', filters: { mediaTypes: ['video'] } })
      ).json();

      expect(body).toMatchObject({ results: [], total: 0, more: false, capped: true });
    });

    it('still refuses a query over 500 characters', async () => {
      setInProcessSearchForTests(fakeInProcessSearch(['clip']));

      expect((await request({ query: 'x'.repeat(501) })).status).toBe(400);
    });
  });
});
