/**
 * #4443 — the list and facets requests a search screen fires together share
 * one query embedding: the second caller for the same text awaits the Ollama
 * call already in flight rather than starting its own.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { listRoute } from './list.ts';
import { facetsRoute } from './facets.ts';
import { _resetCacheForTests } from './total-cache.ts';
import {
  ASSETS_INDEX,
  createMeilisearchClient,
  setMeilisearchClientForTests,
} from '../../enrichment/meilisearch-client.ts';
import { seedSearchAsset } from '../../db/repos/search.test-helpers.ts';
import {
  createLiveTestDatabase,
  insertFolder,
  type LiveTestDatabase,
} from '../../db/sqlite/test-sqlite.test-helpers.ts';

const MODEL = 'bge-m3:latest';
const VECTOR = [0.5, 0.25];
const EMBED_DELAY_MS = 40;

let live: LiveTestDatabase;
let servers: Array<ReturnType<typeof Bun.serve>> = [];
let searches: Array<Record<string, unknown>> = [];
let embedCalls = 0;

beforeEach(async () => {
  live = await createLiveTestDatabase();
  const libraryId = insertFolder(live.db, { slug: 'winter', path: '/lib' });
  seedSearchAsset(live.db, libraryId, {
    filename: 'snowy-field.dng',
    mapleId: 'maple-snowy-field',
    searchBlob: 'field',
  });
  _resetCacheForTests();
  embedCalls = 0;
});

afterEach(() => {
  setMeilisearchClientForTests(null);
  for (const server of servers) server.stop(true);
  servers = [];
  searches = [];
  live.close();
  _resetCacheForTests();
});

function serve(fetch: (req: Request) => Response | Promise<Response>): string {
  const server = Bun.serve({ port: 0, fetch });
  servers.push(server);
  return `http://127.0.0.1:${server.port}`;
}

function useSidecars(): void {
  const ollamaUrl = serve(async () => {
    embedCalls += 1;
    await Bun.sleep(EMBED_DELAY_MS);
    return Response.json({ embeddings: [VECTOR] });
  });
  const meiliUrl = serve(async (req) => {
    if (req.method === 'GET') {
      return Response.json({
        caption: { source: 'ollama', model: MODEL, url: `${ollamaUrl}/api/embed` },
      });
    }
    expect(new URL(req.url).pathname).toBe(`/indexes/${ASSETS_INDEX}/search`);
    searches.push((await req.json()) as Record<string, unknown>);
    return Response.json({ hits: [{ id: 'maple-snowy-field' }], estimatedTotalHits: 1 });
  });
  setMeilisearchClientForTests(
    createMeilisearchClient({
      url: meiliUrl,
      semantic: true,
      embedderUrl: ollamaUrl,
      embedderModel: MODEL,
    }),
  );
}

describe('a search page fired as list + facets together', () => {
  it('embeds the query once and ranks both requests with that vector', async () => {
    useSidecars();
    const app = new Elysia().use(listRoute).use(facetsRoute);

    const [list, facets] = await Promise.all([
      app.handle(new Request('http://localhost/?placeQuery=snowy%20winter&limit=30')),
      app.handle(new Request('http://localhost/facets?placeQuery=snowy%20winter')),
    ]);

    expect(list.status).toBe(200);
    expect(facets.status).toBe(200);
    expect(embedCalls).toBe(1);
    expect(searches).toHaveLength(2);
    const limits = searches.map((search) => search.limit).sort((a, b) => Number(a) - Number(b));
    expect(limits).toEqual([30, 2_000]);
    for (const search of searches) {
      expect(search).toMatchObject({
        q: 'snowy winter',
        vector: VECTOR,
        hybrid: { embedder: 'caption' },
      });
    }
  });

  it('serves a repeat of the same query from the remembered vector', async () => {
    useSidecars();
    const app = new Elysia().use(listRoute).use(facetsRoute);
    const page = () =>
      Promise.all([
        app.handle(new Request('http://localhost/?placeQuery=snowy%20winter&limit=30')),
        app.handle(new Request('http://localhost/facets?placeQuery=snowy%20winter')),
      ]);

    await page();
    await page();

    expect(embedCalls).toBe(1);
    expect(searches.every((search) => Array.isArray(search.vector))).toBe(true);
  });
});
