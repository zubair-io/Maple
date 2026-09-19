/**
 * Integration tests for `/api/generated-searches`.
 *
 * This is the contract the Apple widget, the Maple TV shelf, and the settings
 * page all consume, so it is exercised through the Elysia routes rather than
 * by calling the repo directly.
 *
 * The exclusion test is the important one: nothing in the stored document
 * mentions the hidden person, and the doc is deliberately written with
 * `excludeHiddenPeople: 'false'` to simulate data from an earlier worker
 * version. The exclusion has to come from re-deriving the query at request
 * time.
 *
 * The handlers reach `sqliteDb()` with no override, so each test installs its
 * own database as the process-wide handle for the block.
 */

import { describe, it, expect, afterEach, beforeEach } from 'bun:test';
import { Elysia } from 'elysia';
import { ObjectId } from '../db/object-id.ts';
import {
  createLiveTestDatabase,
  insertFolder,
  run,
  type LiveTestDatabase,
} from '../db/sqlite/test-sqlite.test-helpers.ts';
import { insertPerson } from '../db/sqlite/repos/people.test-helpers.ts';
import { seedSearchAsset, type SeedAsset } from '../db/sqlite/repos/search.test-helpers.ts';
import { invalidateLibraryRoots } from '../indexer/libraries.cache.ts';
import { generatedSearchesRoutes } from './generated-searches.ts';
import { generatedSearchConfigRoutes } from '../workers/generated-search/routes.ts';
import { _resetRunNowForTests, _awaitRunNowForTests } from '../workers/generated-search/run-now.ts';

const app = new Elysia().use(generatedSearchesRoutes).use(generatedSearchConfigRoutes);

let live: LiveTestDatabase;
let libraryId: string;
/** Person name → id, shared across one test's fixtures. */
let people: Map<string, string>;

beforeEach(async () => {
  live = await createLiveTestDatabase();
  libraryId = insertFolder(live.db, { path: '/srv/trips', slug: 'trips' });
  people = new Map();
  invalidateLibraryRoots();
});

afterEach(() => {
  live.close();
  invalidateLibraryRoots();
});

async function get(path: string) {
  const res = await app.handle(new Request(`http://localhost${path}`));
  return { status: res.status, body: await res.json() };
}

function seedCollection(over: Record<string, unknown> = {}): string {
  const id = new ObjectId().toHexString();
  const row = {
    library_id: libraryId,
    generated_for: '2026-08-17',
    generated_at: '2026-08-17T06:00:00.000Z',
    model: 'test-model',
    attempts: 1,
    theme: 'summer sprinklers',
    title: 'Running Through Sprinklers',
    subtitle: 'Back-garden afternoons',
    query: { month: '8' } as unknown,
    result_count: 2,
    cover_asset_id: 'a',
    ...over,
  };
  run(
    live.db,
    `INSERT INTO generated_searches
       (id, library_id, generated_for, generated_at, model, attempts,
        theme, title, subtitle, query, result_count, cover_asset_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    row.library_id as string,
    row.generated_for as string,
    row.generated_at as string,
    row.model as string,
    row.attempts as number,
    row.theme as string,
    row.title as string,
    row.subtitle as string,
    JSON.stringify(row.query),
    row.result_count as number,
    row.cover_asset_id as string,
  );
  return id;
}

/** One August-2018 asset in the fixture library. */
function seedAsset(name: string, over: Partial<SeedAsset> = {}): string {
  return seedSearchAsset(
    live.db,
    libraryId,
    {
      filename: `${name}.jpg`,
      path: 'p',
      capturedAt: '2018-08-15T12:00:00.000Z',
      description: `caption for ${name}`,
      ...over,
    },
    people,
  );
}

describe('GET /api/generated-searches', () => {
  it('returns the day’s collections as cards', async () => {
    seedCollection();
    const { status, body } = await get(`/api/generated-searches?libraryId=${libraryId}`);

    expect(status).toBe(200);
    expect(body.results).toHaveLength(1);
    expect(body.results[0].title).toBe('Running Through Sprinklers');
    // The stored query rides along so a client can deep-link into /search.
    expect(body.results[0].query).toEqual({ month: '8' });
  });

  it('returns an empty list for a library with no collections', async () => {
    const { status, body } = await get(
      '/api/generated-searches?libraryId=507f1f77bcf86cd799439099',
    );
    expect(status).toBe(200);
    expect(body.results).toEqual([]);
  });
});

describe('GET /api/generated-searches/:id/assets', () => {
  it('runs the stored query and returns matching assets', async () => {
    const id = seedCollection();
    seedAsset('a');
    seedAsset('b');

    const { status, body } = await get(`/api/generated-searches/${id}/assets`);
    expect(status).toBe(200);
    expect(body.total).toBe(2);
    expect(body.results).toHaveLength(2);
  });

  it('pages with limit + offset, and reports the full total on every page', async () => {
    const id = seedCollection();
    // Distinct capture instants so `captured_desc` gives a stable order to
    // page through — otherwise a tie makes "page 2 continues page 1"
    // unverifiable rather than merely unordered.
    for (let i = 0; i < 5; i++) {
      seedAsset(`p${i}`, { capturedAt: `2018-08-1${i}T12:00:00.000Z` });
    }

    const first = await get(`/api/generated-searches/${id}/assets?limit=2&offset=0`);
    const second = await get(`/api/generated-searches/${id}/assets?limit=2&offset=2`);
    const last = await get(`/api/generated-searches/${id}/assets?limit=2&offset=4`);

    // `total` is the whole collection on every page — that is what lets a
    // client know it has more to fetch.
    expect(first.body.total).toBe(5);
    expect(second.body.total).toBe(5);
    expect(last.body.total).toBe(5);

    expect(first.body.results).toHaveLength(2);
    expect(second.body.results).toHaveLength(2);
    expect(last.body.results).toHaveLength(1);

    // The pages partition the collection: no repeats, nothing skipped. Keyed
    // on `_id` rather than `id` — the latter is derived from the library root
    // path, which this suite doesn't seed.
    const ids = [...first.body.results, ...second.body.results, ...last.body.results].map(
      (r: { _id: string }) => r._id,
    );
    expect(new Set(ids).size).toBe(5);
  });

  it('reads past the first page rather than capping the collection', async () => {
    const id = seedCollection();
    seedAsset('a');
    seedAsset('b');

    // An offset beyond the end is an empty page, not an error — a client that
    // races ahead of `total` gets a clean stop.
    const { status, body } = await get(`/api/generated-searches/${id}/assets?offset=99`);
    expect(status).toBe(200);
    expect(body.total).toBe(2);
    expect(body.results).toEqual([]);
  });

  it('404s for an unknown collection', async () => {
    const { status } = await get(`/api/generated-searches/${new ObjectId().toHexString()}/assets`);
    expect(status).toBe(404);
  });

  it('400s on a malformed id rather than throwing', async () => {
    const { status } = await get('/api/generated-searches/not-an-id/assets');
    expect(status).toBe(400);
  });

  it('excludes hidden people even when the stored doc tries to opt out', async () => {
    // Pre-registered under the name the fixture asset references, so the
    // seeder reuses this hidden person rather than minting a visible one.
    people.set('Hidden', insertPerson(live.db, { name: 'Hidden', hidden: true }));

    // Simulates a doc written by an earlier worker version.
    const id = seedCollection({ query: { month: '8', excludeHiddenPeople: 'false' } });
    seedAsset('visible');
    seedAsset('has-hidden-face', { people: ['Hidden'] });

    const { body } = await get(`/api/generated-searches/${id}/assets`);
    expect(body.total).toBe(1);
  });
});

describe('POST /api/workers/generated-search/run', () => {
  it('starts a pass and refuses a concurrent second one', async () => {
    // Stubbed runner: a real pass hits the database + Ollama with timing that
    // varies under the full suite. The route contract under test is only the
    // immediate started/refused response and the in-flight guard.
    let release: () => void = () => {};
    _resetRunNowForTests(
      () =>
        new Promise((r) => {
          release = () => r({ libraries: 0, saved: 0, pruned: 0, skipped: false });
        }),
    );

    const first = await app.handle(
      new Request('http://localhost/api/workers/generated-search/run', { method: 'POST' }),
    );
    expect((await first.json()).started).toBe(true);

    const second = await app.handle(
      new Request('http://localhost/api/workers/generated-search/run', { method: 'POST' }),
    );
    expect(await second.json()).toEqual({ started: false, reason: 'already-running' });

    release();
    await _awaitRunNowForTests();
    _resetRunNowForTests();
  });
});
