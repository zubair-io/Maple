/**
 * A text search's facets describe the ranking its list uses (#4431): when
 * Meilisearch serves the list, the most relevant matches are Meilisearch's,
 * fetched with the same filters and counted with every database filter but the
 * text; when it cannot — not configured, a filter it cannot express, a failure
 * — the facets fall back to the database's own ranking, as the list does.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { facetsRoute } from './facets.ts';
import {
  setMeilisearchClientForTests,
  type MeilisearchClient,
  type MeilisearchSearchOptions,
} from '../../enrichment/meilisearch-client.ts';
import { seedSearchAsset } from '../../db/repos/search.test-helpers.ts';
import {
  createLiveTestDatabase,
  insertFolder,
  type LiveTestDatabase,
} from '../../db/sqlite/test-sqlite.test-helpers.ts';

let live: LiveTestDatabase;
let libraryId: string;

beforeEach(async () => {
  live = await createLiveTestDatabase();
  libraryId = insertFolder(live.db, { slug: 'facets-meili', path: '/lib' });
  const assets: Array<[string, string, string]> = [
    ['maple-a', 'Canon', 'greyson beach'],
    ['maple-b', 'Canon', 'greyson dunes'],
    ['maple-c', 'SONY', 'greyson harbour'],
    ['maple-d', 'Apple', 'unrelated meadow'],
  ];
  for (const [mapleId, cameraMake, searchBlob] of assets) {
    seedSearchAsset(live.db, libraryId, {
      mapleId,
      cameraMake,
      cameraModel: 'M',
      rating: mapleId === 'maple-a' ? 5 : 1,
      searchBlob,
    });
  }
});

afterEach(() => {
  setMeilisearchClientForTests(null);
  live.close();
});

function fakeMeili(answer: () => Promise<{ ids: string[]; estimatedTotal: number }>): {
  client: MeilisearchClient;
  calls: Array<{ q: string; opts: MeilisearchSearchOptions }>;
} {
  const calls: Array<{ q: string; opts: MeilisearchSearchOptions }> = [];
  const client: MeilisearchClient = {
    isConfigured: () => true,
    semanticConfigured: () => false,
    health: async () => true,
    ensureIndex: async () => {},
    upsert: async () => {},
    upsertOrThrow: async () => {},
    tombstone: async () => {},
    search: async (q, opts = {}) => {
      calls.push({ q, opts });
      return answer();
    },
  };
  return { client, calls };
}

async function facets(query: string): Promise<{
  total: number;
  scope: unknown;
  cameras: Array<{ make: string | null; model: string | null; count: number }>;
}> {
  const app = new Elysia().use(facetsRoute);
  const res = await app.handle(new Request(`http://localhost/facets?${query}`));
  expect(res.status).toBe(200);
  return res.json();
}

describe('GET /api/search/facets — the ranking behind a text search', () => {
  it("counts Meilisearch's best matches when Meilisearch serves the list", async () => {
    // Meilisearch ranks the meadow first (typo-tolerant or semantic hits need
    // not share a word with the query) and claims 5,000 matches in all.
    const { client, calls } = fakeMeili(async () => ({
      ids: ['maple-d', 'maple-c', 'maple-missing'],
      estimatedTotal: 5_000,
    }));
    setMeilisearchClientForTests(client);

    const body = await facets('placeQuery=greyson&sceneType=outdoor');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.q).toBe('greyson');
    expect(calls[0]?.opts).toMatchObject({ offset: 0, limit: 2_000, sceneType: 'outdoor' });
    expect(body.total).toBe(5_000);
    expect(body.scope).toEqual({ kind: 'top', limit: 3, of: 5_000 });
    // Rows come from the ids, filters applied: sceneType=outdoor matches no
    // seeded asset, so nothing survives the mapping.
    expect(body.cameras).toEqual([]);
  });

  it('reports the cut Meilisearch actually made, not the one it was asked for', async () => {
    // Meilisearch's default `pagination.maxTotalHits` is 1,000: asked for 2,000
    // it returns 1,000, with an estimated total of every match. The scope must
    // say 1,000 — the client's note prints it.
    const ids = ['maple-c', 'maple-d', ...Array.from({ length: 998 }, (_, i) => `maple-x${i}`)];
    const { client, calls } = fakeMeili(async () => ({ ids, estimatedTotal: 8_217 }));
    setMeilisearchClientForTests(client);

    const body = await facets('placeQuery=greyson');
    expect(calls[0]?.opts.limit).toBe(2_000);
    expect(body.total).toBe(8_217);
    expect(body.scope).toEqual({ kind: 'top', limit: 1_000, of: 8_217 });
    expect(body.cameras.map((row) => [row.make, row.count]).sort()).toEqual([
      ['Apple', 1],
      ['SONY', 1],
    ]);
  });

  it('maps the ids to rows and counts them, every match when Meilisearch has no more', async () => {
    const { client } = fakeMeili(async () => ({
      ids: ['maple-d', 'maple-c'],
      estimatedTotal: 2,
    }));
    setMeilisearchClientForTests(client);

    const body = await facets('placeQuery=greyson');
    expect(body.total).toBe(2);
    expect(body.scope).toEqual({ kind: 'all' });
    expect(body.cameras.map((row) => [row.make, row.count]).sort()).toEqual([
      ['Apple', 1],
      ['SONY', 1],
    ]);
  });

  it('falls back to the database ranking when Meilisearch fails', async () => {
    const { client, calls } = fakeMeili(async () => {
      throw new Error('meilisearch timed out');
    });
    setMeilisearchClientForTests(client);

    const body = await facets('placeQuery=greyson');
    expect(calls).toHaveLength(1);
    expect(body.total).toBe(3);
    expect(body.scope).toEqual({ kind: 'all' });
    expect(body.cameras.map((row) => [row.make, row.count]).sort()).toEqual([
      ['Canon', 2],
      ['SONY', 1],
    ]);
  });

  it('does not keep a fallback cached once Meilisearch answers again', async () => {
    let failing = true;
    const { client, calls } = fakeMeili(async () => {
      if (failing) throw new Error('meilisearch timed out');
      return { ids: ['maple-d', 'maple-c'], estimatedTotal: 4_000 };
    });
    setMeilisearchClientForTests(client);

    const fallback = await facets('placeQuery=greyson');
    expect(fallback.scope).toEqual({ kind: 'all' });
    expect(fallback.total).toBe(3);

    failing = false;
    const ranked = await facets('placeQuery=greyson');
    expect(calls).toHaveLength(2);
    expect(ranked.total).toBe(4_000);
    expect(ranked.scope).toEqual({ kind: 'top', limit: 2, of: 4_000 });

    // A Meilisearch answer is cached as usual: no third search.
    await facets('placeQuery=greyson');
    expect(calls).toHaveLength(2);
  });

  /** One more asset matching "greyson" with a 5 rating, after the first answer. */
  function addMatch(): void {
    seedSearchAsset(live.db, libraryId, {
      mapleId: 'maple-late',
      cameraMake: 'Canon',
      cameraModel: 'M',
      rating: 5,
      searchBlob: 'greyson late',
    });
  }

  it('caches the database ranking when Meilisearch is not configured', async () => {
    setMeilisearchClientForTests({
      ...fakeMeili(async () => ({ ids: [], estimatedTotal: 0 })).client,
      isConfigured: () => false,
    });
    const first = await facets('placeQuery=greyson');
    addMatch();
    const second = await facets('placeQuery=greyson');
    // Served from the cache: the asset added in between is not counted.
    expect(second.total).toBe(first.total);
    expect(first.total).toBe(3);
  });

  it('caches the database ranking for a filter Meilisearch cannot express', async () => {
    const { client, calls } = fakeMeili(async () => ({ ids: ['maple-d'], estimatedTotal: 1 }));
    setMeilisearchClientForTests(client);
    const first = await facets('placeQuery=greyson&rating=4');
    addMatch();
    const second = await facets('placeQuery=greyson&rating=4');
    expect(calls).toHaveLength(0);
    expect(first.total).toBe(1);
    expect(second.total).toBe(1);
  });

  it('does not cache the stand-in when Meilisearch fails a search it should serve', async () => {
    const { client, calls } = fakeMeili(async () => {
      throw new Error('meilisearch timed out');
    });
    setMeilisearchClientForTests(client);
    await facets('placeQuery=greyson');
    addMatch();
    const second = await facets('placeQuery=greyson');
    expect(calls).toHaveLength(2);
    expect(second.total).toBe(4);
  });

  it('never asks Meilisearch for a filter it cannot express', async () => {
    const { client, calls } = fakeMeili(async () => ({ ids: ['maple-d'], estimatedTotal: 1 }));
    setMeilisearchClientForTests(client);

    const body = await facets('placeQuery=greyson&rating=4');
    expect(calls).toHaveLength(0);
    expect(body.total).toBe(1);
    expect(body.cameras).toEqual([{ make: 'Canon', model: 'M', count: 1 }]);
  });

  it('never asks Meilisearch for a search without text', async () => {
    const { client, calls } = fakeMeili(async () => ({ ids: [], estimatedTotal: 0 }));
    setMeilisearchClientForTests(client);

    const body = await facets('rating=1');
    expect(calls).toHaveLength(0);
    expect(body.scope).toEqual({ kind: 'all' });
  });
});
