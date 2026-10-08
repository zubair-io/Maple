/**
 * #4437 — a text search on `GET /api/search` reaches Meilisearch with the
 * query vector Maple embedded through the configured Ollama endpoint, and a
 * cold model costs the user a keyword-only page rather than a stalled one.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { listRoute } from './list.ts';
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
const DEADLINE_MS = 60;
const SNOWY_ID = 'maple-snowy-field';

let live: LiveTestDatabase;
let servers: Array<ReturnType<typeof Bun.serve>> = [];
let searches: Array<Record<string, unknown>> = [];

beforeEach(async () => {
  live = await createLiveTestDatabase();
  const libraryId = insertFolder(live.db, { slug: 'winter', path: '/lib' });
  seedSearchAsset(live.db, libraryId, {
    filename: 'snowy-field.dng',
    mapleId: SNOWY_ID,
    searchBlob: 'field',
  });
  _resetCacheForTests();
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

function useSidecars(embedDelayMs: number): void {
  const ollamaUrl = serve(async () => {
    await Bun.sleep(embedDelayMs);
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
    return Response.json({ hits: [{ id: SNOWY_ID }], estimatedTotalHits: 1 });
  });
  setMeilisearchClientForTests(
    createMeilisearchClient({
      url: meiliUrl,
      semantic: true,
      embedderUrl: ollamaUrl,
      embedderModel: MODEL,
      queryEmbedDeadlineMs: DEADLINE_MS,
    }),
  );
}

async function searchFilenames(): Promise<string[]> {
  const res = await new Elysia()
    .use(listRoute)
    .handle(new Request('http://localhost/?placeQuery=winter'));
  expect(res.status).toBe(200);
  const body = await res.json();
  return body.results.map((r: { filename: string }) => r.filename);
}

describe('GET /api/search — hybrid query vector (#4437)', () => {
  it('ranks with the vector Maple embedded', async () => {
    useSidecars(0);

    expect(await searchFilenames()).toEqual(['snowy-field.dng']);
    expect(searches[0]).toMatchObject({
      q: 'winter',
      vector: VECTOR,
      hybrid: { embedder: 'caption' },
    });
  });

  it('answers keyword-only from Meilisearch when the embedding is slow', async () => {
    useSidecars(DEADLINE_MS * 5);

    expect(await searchFilenames()).toEqual(['snowy-field.dng']);
    expect(searches[0]!.hybrid).toBeUndefined();
    expect(searches[0]!.vector).toBeUndefined();
  });
});
