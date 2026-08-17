/**
 * The Meilisearch `placeQuery` branch applied the caller's capture-date
 * window ONLY as a Mongo predicate on the ids Meilisearch had already
 * returned. Meilisearch ranks the whole corpus, hands back one page of
 * `limit` ids, and the date predicate then runs against that page — so a
 * match outside the first page was invisible even though it satisfied both
 * the text query and the window.
 *
 * Two observable symptoms, both reported against a live library where
 * `summer greyson` and `last summer greyson` each rendered an empty grid
 * under a "9,331 RESULTS" header:
 *
 *   1. Zero rows despite in-window matches existing.
 *   2. A `total` taken from Meilisearch's `estimatedTotalHits`, which knows
 *      nothing about the window — identical for every date range, and
 *      wildly larger than the number of rows the grid can ever show.
 *
 * Same shape as #2358 (hidden mode not threaded into `meili.search`, Mongo
 * intersection always empty). The pushdown machinery already exists:
 * `capturedFrom`/`capturedBefore` on `MeilisearchSearchOptions`, a
 * `capturedAt` clause in `meilisearch-filter.ts`, and `capturedAt` in the
 * index's `filterableAttributes` since settings v4. This branch just never
 * passed them.
 *
 * The fake client below reproduces the real `buildFilter` date semantics
 * (`capturedAt >= from`, `capturedAt < before`) against a seeded corpus and
 * pages the survivors, so the test exercises the pushdown end to end rather
 * than only asserting on the options object.
 *
 * Real Mongo required — soft-skips when unreachable, matching `list.test.ts`.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { ObjectId, type Db } from 'mongodb';
import { listRoute } from './list.ts';
import { closeDb, getDb, isDbConnected } from '../../db/client.ts';
import {
  setMeilisearchClientForTests,
  type MeilisearchClient,
  type MeilisearchSearchOptions,
} from '../../enrichment/meilisearch-client.ts';
import { withTestDb } from '../../db/test-db.test-helpers.ts';

withTestDb(`maple_test_search_meili_dates_${process.pid}`);

let db: Db | null = null;
let mongoReachable = false;

/** Captured inside the "last summer" window (2025-06-01 … 2025-08-31). */
const IN_WINDOW_ID = 'maple-in-window';
/** Captured years earlier, but ranked ahead of it by relevance. */
const OUT_OF_WINDOW_ID = 'maple-out-of-window';

const IN_WINDOW_AT = '2025-07-15T12:00:00.000Z';
const OUT_OF_WINDOW_AT = '2020-01-05T12:00:00.000Z';

beforeEach(async () => {
  try {
    db = await getDb();
    mongoReachable = isDbConnected();
  } catch {
    mongoReachable = false;
    return;
  }
  if (!mongoReachable || !db) return;
  await db.collection('assets').deleteMany({});
});

afterEach(() => {
  setMeilisearchClientForTests(null);
});

afterAll(async () => {
  if (db) await db.dropDatabase();
  await closeDb();
});

function asset(mapleId: string, filename: string, capturedAt: string): Record<string, unknown> {
  return {
    maple_id: mapleId,
    fileinfo: [{ path: '', filename, library_id: new ObjectId(), deleted_at: null }],
    size: 1,
    mtime: 1,
    rating: 0,
    flag: 0,
    color_label: '',
    indexed_at: 'now',
    deleted_at: null,
    hidden: false,
    exif: { captured_at: capturedAt },
  };
}

async function seed(d: Db): Promise<void> {
  await d
    .collection('assets')
    .insertMany([
      asset(OUT_OF_WINDOW_ID, 'out-of-window.dng', OUT_OF_WINDOW_AT),
      asset(IN_WINDOW_ID, 'in-window.dng', IN_WINDOW_AT),
    ] as never);
}

/**
 * Stands in for the real index: applies the `capturedAt` clauses the way
 * `meilisearch-filter.ts` builds them, then pages the survivors in relevance
 * order. `OUT_OF_WINDOW_ID` ranks first, so a `limit` of 1 returns only it
 * whenever the window fails to reach the query.
 */
function fakeMeiliClient(): {
  client: MeilisearchClient;
  calls: MeilisearchSearchOptions[];
} {
  const calls: MeilisearchSearchOptions[] = [];
  const corpus = [
    { id: OUT_OF_WINDOW_ID, capturedAt: OUT_OF_WINDOW_AT },
    { id: IN_WINDOW_ID, capturedAt: IN_WINDOW_AT },
  ];
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
      const matched = corpus.filter(
        (doc) =>
          (opts.capturedFrom === undefined || doc.capturedAt >= opts.capturedFrom) &&
          (opts.capturedBefore === undefined || doc.capturedAt < opts.capturedBefore),
      );
      const offset = opts.offset ?? 0;
      const limit = opts.limit ?? 100;
      return {
        ids: matched.slice(offset, offset + limit).map((doc) => doc.id),
        estimatedTotal: matched.length,
      };
    },
  };
  return { client, calls };
}

describe('GET /api/search — capture-date window reaches Meilisearch', () => {
  it('returns an in-window match that relevance ranked outside the first page', async () => {
    if (!mongoReachable || !db) return;
    await seed(db);
    const { client } = fakeMeiliClient();
    setMeilisearchClientForTests(client);

    const app = new Elysia().use(listRoute);
    // `last summer` resolves to 2025-06-01 … 2025-08-31 and is stripped from
    // the text, exactly as the live query did. `limit=1` reproduces a first
    // page that the out-of-window doc would otherwise consume on its own.
    const res = await app.handle(
      new Request('http://localhost/?placeQuery=last%20summer%20greyson&limit=1'),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results.map((r: { filename: string }) => r.filename)).toEqual(['in-window.dng']);
  });

  it('passes the resolved window to Meilisearch rather than post-filtering', async () => {
    if (!mongoReachable || !db) return;
    await seed(db);
    const { client, calls } = fakeMeiliClient();
    setMeilisearchClientForTests(client);

    const app = new Elysia().use(listRoute);
    const res = await app.handle(
      new Request('http://localhost/?placeQuery=last%20summer%20greyson&limit=1'),
    );
    expect(res.status).toBe(200);
    await res.json();
    expect(calls[0]?.capturedFrom).toBe('2025-06-01T00:00:00.000Z');
    // Exclusive upper bound: the day after the inclusive end date, so the
    // whole of Aug 31 is kept without an end-of-month special case.
    expect(calls[0]?.capturedBefore).toBe('2025-09-01T00:00:00.000Z');
  });

  /**
   * `meilisearch-filter.ts` interpolates the date bounds straight into the
   * filter expression (`capturedAt >= "${capturedFrom}"`) — it escapes
   * `folderId` and person names but trusts the caller for these. That held
   * while `service-asset-search.ts` was the only caller, because it
   * canonicalises via `parseUtcDate(...)!.toISOString()`.
   *
   * `from`/`to` on the wire are `t.Optional(t.String())` with no date
   * validation, and `widenFromDate`/`widenToDate` return a non-`YYYY-MM-DD`
   * string unmodified. So a bound carrying a double quote would close the
   * literal early and append attacker-chosen clauses — enough to lift the
   * `hidden` exclusion or the `folderId` scope. Both bounds are normalised
   * to a canonical ISO instant, which cannot carry a quote.
   */
  it('never forwards an unparseable date bound to Meilisearch', async () => {
    if (!mongoReachable || !db) return;
    await seed(db);
    const { client, calls } = fakeMeiliClient();
    setMeilisearchClientForTests(client);

    const app = new Elysia().use(listRoute);
    const injected = '2024-01-01" OR hidden = true OR capturedAt >= "1900-01-01';
    const res = await app.handle(
      new Request(
        `http://localhost/?placeQuery=greyson&from=${encodeURIComponent(injected)}` +
          `&to=${encodeURIComponent(injected)}`,
      ),
    );
    expect(res.status).toBe(200);
    await res.json();
    expect(calls[0]?.capturedFrom).toBeUndefined();
    expect(calls[0]?.capturedBefore).toBeUndefined();
  });

  it('normalises a valid bare date bound to a canonical ISO instant', async () => {
    if (!mongoReachable || !db) return;
    await seed(db);
    const { client, calls } = fakeMeiliClient();
    setMeilisearchClientForTests(client);

    const app = new Elysia().use(listRoute);
    const res = await app.handle(
      new Request('http://localhost/?placeQuery=greyson&from=2025-06-01&to=2025-08-31'),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(calls[0]?.capturedFrom).toBe('2025-06-01T00:00:00.000Z');
    expect(calls[0]?.capturedBefore).toBe('2025-09-01T00:00:00.000Z');
    expect(body.results.map((r: { filename: string }) => r.filename)).toEqual(['in-window.dng']);
  });

  it('reports a total that reflects the window, not the whole text match', async () => {
    if (!mongoReachable || !db) return;
    await seed(db);
    const { client } = fakeMeiliClient();
    setMeilisearchClientForTests(client);

    const app = new Elysia().use(listRoute);
    const res = await app.handle(
      new Request('http://localhost/?placeQuery=last%20summer%20greyson&limit=1'),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    // The corpus holds two text matches; only one is inside the window. A
    // total of 2 here is the "9,331 RESULTS above an empty grid" bug.
    expect(body.total).toBe(1);
  });
});
