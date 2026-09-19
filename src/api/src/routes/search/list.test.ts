/**
 * #2358 — the Meilisearch-backed `placeQuery` path in `list.ts` didn't
 * thread the caller's `hidden` mode into `meili.search`, so Meili always
 * excluded hidden docs from its candidate id set (its own default). The
 * re-fetch's `hidden` predicate for `hidden=only` then intersected against
 * an already hidden-free id set and always came back empty; `hidden=all`
 * had the same problem in the other direction — a hidden asset could never
 * surface even though the database filter placed no constraint on it.
 *
 * Uses the `setMeilisearchClientForTests` seam (same pattern as
 * `workers/stages/meili.test.ts`) with a fake client that reproduces the
 * filter builder's hidden handling (default exclusion, `includeHidden`,
 * and the `onlyHidden` pushdown). That makes this test actually exercise
 * the database-side intersection, not just assert on the options object
 * passed to `search`.
 *
 * Real SQLite, installed as the process-wide handle so the route's own
 * `searchByMapleIds` and `libraryMaps` calls reach it.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { listRoute } from './list.ts';
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

const VISIBLE_ID = 'maple-visible-1';
const HIDDEN_ID = 'maple-hidden-1';

afterEach(() => {
  setMeilisearchClientForTests(null);
});

/** One visible asset and one hidden one, both matching whatever Meili says. */
function seed(live: LiveTestDatabase): void {
  const libraryId = insertFolder(live.db, { slug: 'search-list', path: '/lib' });
  const capturedAt = '2026-05-10T00:00:00.000Z';
  seedSearchAsset(live.db, libraryId, {
    filename: 'visible.dng',
    mapleId: VISIBLE_ID,
    capturedAt,
  });
  seedSearchAsset(live.db, libraryId, {
    filename: 'hidden.dng',
    mapleId: HIDDEN_ID,
    hidden: true,
    capturedAt,
  });
}

/** Reproduces the filter builder's hidden handling against the live index:
 * `onlyHidden` narrows the candidate set to the hidden doc alone
 * (`hidden = true`), `includeHidden` returns both, and the default
 * excludes the hidden candidate entirely. */
function fakeMeiliClient(): {
  client: MeilisearchClient;
  calls: MeilisearchSearchOptions[];
} {
  const calls: MeilisearchSearchOptions[] = [];
  const client: MeilisearchClient = {
    isConfigured: () => true,
    semanticConfigured: () => false,
    health: async () => true,
    ensureIndex: async () => {},
    upsert: async () => {},
    upsertOrThrow: async () => {},
    tombstone: async () => {},
    search: async (_q, opts = {}) => {
      calls.push(opts);
      const ids =
        opts.onlyHidden === true
          ? [HIDDEN_ID]
          : opts.includeHidden === true
            ? [VISIBLE_ID, HIDDEN_ID]
            : [VISIBLE_ID];
      return { ids, estimatedTotal: ids.length };
    },
  };
  return { client, calls };
}

/** Filenames the route answered with, in response order. */
async function filenames(url: string): Promise<string[]> {
  const app = new Elysia().use(listRoute);
  const res = await app.handle(new Request(url));
  expect(res.status).toBe(200);
  const body = await res.json();
  return (body.results as Array<{ filename: string }>).map((r) => r.filename);
}

describe('GET /api/search — placeQuery hidden mode (#2358)', () => {
  it('hidden=only returns the hidden match via the Meili path', async () => {
    using live = await createLiveTestDatabase();
    seed(live);
    const { client, calls } = fakeMeiliClient();
    setMeilisearchClientForTests(client);

    expect(await filenames('http://localhost/?placeQuery=museum&hidden=only')).toEqual([
      'hidden.dng',
    ]);
    expect(calls[0]?.onlyHidden).toBe(true);
  });

  it('hidden=all includes both the visible and hidden match', async () => {
    using live = await createLiveTestDatabase();
    seed(live);
    const { client, calls } = fakeMeiliClient();
    setMeilisearchClientForTests(client);

    const names = await filenames('http://localhost/?placeQuery=museum&hidden=all');
    expect(names.sort()).toEqual(['hidden.dng', 'visible.dng']);
    expect(calls[0]?.includeHidden).toBe(true);
  });

  it('default hidden mode still excludes the hidden match', async () => {
    using live = await createLiveTestDatabase();
    seed(live);
    const { client, calls } = fakeMeiliClient();
    setMeilisearchClientForTests(client);

    expect(await filenames('http://localhost/?placeQuery=museum')).toEqual(['visible.dng']);
    expect(calls[0]?.includeHidden).toBe(false);
    expect(calls[0]?.onlyHidden).toBe(false);
  });
});
