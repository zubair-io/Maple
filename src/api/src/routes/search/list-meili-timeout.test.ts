/**
 * #4420 — a configured Meilisearch sidecar that accepts the connection but
 * never answers must not hold `GET /api/search` open. The search request is
 * bounded, and a timeout takes the same fallback as any other Meili failure:
 * the route answers from the database's own full-text path.
 *
 * Both cases run against a real HTTP server rather than a fake client so the
 * abort is exercised end to end through the transport.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { listRoute } from './list.ts';
import { _resetCacheForTests } from './total-cache.ts';
import {
  createMeilisearchClient,
  setMeilisearchClientForTests,
} from '../../enrichment/meilisearch-client.ts';
import { seedSearchAsset } from '../../db/repos/search.test-helpers.ts';
import {
  createLiveTestDatabase,
  insertFolder,
  type LiveTestDatabase,
} from '../../db/sqlite/test-sqlite.test-helpers.ts';

const TEST_REQUEST_TIMEOUT_MS = 100;
const MEILI_ONLY_ID = 'maple-meili-only';

let live: LiveTestDatabase;
let server: ReturnType<typeof Bun.serve> | null = null;

beforeEach(async () => {
  live = await createLiveTestDatabase();
  const libraryId = insertFolder(live.db, { slug: 'timeout', path: '/lib' });
  seedSearchAsset(live.db, libraryId, {
    filename: 'database-match.dng',
    mapleId: 'maple-database-match',
    searchBlob: 'greyson beach',
  });
  // Only a Meili answer can surface this row: its text never matches the
  // database's full-text query.
  seedSearchAsset(live.db, libraryId, {
    filename: 'meili-only.dng',
    mapleId: MEILI_ONLY_ID,
    searchBlob: 'unrelated',
  });
  _resetCacheForTests();
});

afterEach(() => {
  setMeilisearchClientForTests(null);
  server?.stop(true);
  server = null;
  live.close();
  _resetCacheForTests();
});

function useSidecar(handler: () => Response | Promise<Response>): void {
  server = Bun.serve({ port: 0, fetch: handler });
  setMeilisearchClientForTests(
    createMeilisearchClient({
      url: `http://127.0.0.1:${server.port}`,
      requestTimeoutMs: TEST_REQUEST_TIMEOUT_MS,
    }),
  );
}

async function searchFilenames(): Promise<string[]> {
  const res = await new Elysia()
    .use(listRoute)
    .handle(new Request('http://localhost/?placeQuery=greyson'));
  expect(res.status).toBe(200);
  const body = await res.json();
  return body.results.map((r: { filename: string }) => r.filename);
}

describe('GET /api/search — Meilisearch request timeout', () => {
  it('falls back to the database when the sidecar never responds', async () => {
    useSidecar(() => new Promise<Response>(() => {}));

    const started = performance.now();
    const filenames = await searchFilenames();
    const elapsedMs = performance.now() - started;

    expect(filenames).toEqual(['database-match.dng']);
    expect(elapsedMs).toBeLessThan(TEST_REQUEST_TIMEOUT_MS * 20);
  });

  it('still ranks from Meilisearch when the sidecar answers', async () => {
    useSidecar(() => Response.json({ hits: [{ id: MEILI_ONLY_ID }], estimatedTotalHits: 1 }));

    expect(await searchFilenames()).toEqual(['meili-only.dng']);
  });
});
