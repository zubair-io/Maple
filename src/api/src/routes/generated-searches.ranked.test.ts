/**
 * A For You card with free text is a ranked collection (#4514): the in-process engine ranks it,
 * SQL filters the hits, and `total` is that window — never a count of every match. While the
 * selected engine is still loading the card answers with its stored preview and says so; it does
 * not fall back to ranking the whole library in the database.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { ObjectId } from '../db/object-id.ts';
import {
  createLiveTestDatabase,
  insertFolder,
  run,
  type LiveTestDatabase,
} from '../db/sqlite/test-sqlite.test-helpers.ts';
import { insertPerson } from '../db/repos/people.test-helpers.ts';
import { seedSearchAsset, type SeedAsset } from '../db/repos/search.test-helpers.ts';
import { setSqliteHandleForTests } from '../db/sqlite/index.ts';
import { recordReadWaves } from '../db/sqlite/read-waves.test-helpers.ts';
import { invalidateLibraryRoots } from '../indexer/libraries.cache.ts';
import { setInProcessSearchForTests } from '../search/search-pool.ts';
import { fakeInProcessSearch } from '../search/search.test-helpers.ts';
import { generatedSearchesRoutes } from './generated-searches.ts';

const app = new Elysia().use(generatedSearchesRoutes);

let live: LiveTestDatabase;
let libraryId: string;
const ids = new Map<string, string>();

beforeEach(async () => {
  live = await createLiveTestDatabase();
  libraryId = insertFolder(live.db, { path: '/srv/city', slug: 'city' });
  invalidateLibraryRoots();
  const people = new Map([['Hidden', insertPerson(live.db, { name: 'Hidden', hidden: true })]]);
  ids.clear();
  for (const [name, over] of [
    ['tower', {}],
    ['street', {}],
    ['faced', { people: ['Hidden'] }],
    ['screenshot', { isScreenshot: true }],
    ['bridge', {}],
  ] as Array<[string, Partial<SeedAsset>]>) {
    ids.set(
      name,
      seedSearchAsset(
        live.db,
        libraryId,
        {
          mapleId: name,
          filename: `${name}.jpg`,
          searchBlob: `busy city ${name}`,
          capturedAt: '2018-08-15T12:00:00.000Z',
          ...over,
        },
        people,
      ),
    );
  }
});

afterEach(() => {
  setInProcessSearchForTests(null);
  live.close();
  invalidateLibraryRoots();
});

function seedCard(firstPage: string[] | null = null): string {
  const id = new ObjectId().toHexString();
  run(
    live.db,
    `INSERT INTO generated_searches
       (id, library_id, generated_for, generated_at, model, attempts,
        theme, title, subtitle, query, result_count, cover_asset_id, first_page_ids)
     VALUES (?, ?, '2026-10-12', '2026-10-12T03:00:00.000Z', 'm', 1, 't', 'City', NULL, ?, 3,
             NULL, ?)`,
    id,
    libraryId,
    JSON.stringify({ placeQuery: 'busy city streets, tall buildings, and urban cityscapes' }),
    firstPage === null ? null : JSON.stringify(firstPage),
  );
  return id;
}

async function get(path: string) {
  const recorded = recordReadWaves(live.handle);
  setSqliteHandleForTests(recorded.handle);
  const res = await app.handle(new Request(`http://localhost${path}`));
  setSqliteHandleForTests(live.handle);
  return { status: res.status, body: await res.json(), statements: recorded.waves.flat() };
}

const names = (body: { results: Array<{ _id: string }> }) =>
  body.results.map((row) => [...ids].find(([, id]) => id === row._id)?.[0]);

describe('a free-text collection with the in-process engine', () => {
  it('pages its ranked window, filtered live, with the window as its total', async () => {
    const engine = fakeInProcessSearch([
      'bridge',
      'faced',
      'gone',
      'screenshot',
      'tower',
      'street',
    ]);
    setInProcessSearchForTests(engine);
    const id = seedCard();

    const first = await get(`/api/generated-searches/${id}/assets?limit=2`);
    const second = await get(`/api/generated-searches/${id}/assets?limit=2&offset=2`);

    expect(names(first.body)).toEqual(['bridge', 'tower']);
    expect(names(second.body)).toEqual(['street']);
    expect([first.body.total, second.body.total]).toEqual([3, 3]);
    expect(first.body.more).toBe(false);
    expect(engine.queries[0]).toEqual({
      query: 'busy city streets, tall buildings, and urban cityscapes',
      k: 100,
    });
  });

  it('reads nothing but the window, every asset read on the bulk lane, and counts nothing', async () => {
    setInProcessSearchForTests(fakeInProcessSearch(['bridge', 'tower', 'street']));
    const { statements } = await get(`/api/generated-searches/${seedCard()}/assets?limit=30`);

    expect(statements.some((sql) => sql.includes('assets_fts'))).toBe(false);
    expect(statements.some((sql) => /COUNT\(\*\)/.test(sql))).toBe(false);
    const assetReads = statements.filter((sql) => /\bFROM assets\b/.test(sql));
    expect(assetReads.length).toBeGreaterThan(0);
    expect(assetReads.every((sql) => sql.startsWith('bulk: '))).toBe(true);
  });

  it('widens a thinned window until the engine runs dry, then reports no more', async () => {
    const window = Array.from({ length: 100 }, (_, index) => `missing${index}`);
    const engine = fakeInProcessSearch(['tower', ...window]);
    setInProcessSearchForTests(engine);

    const { body } = await get(`/api/generated-searches/${seedCard()}/assets?limit=1`);

    expect(engine.queries.map((query) => query.k)).toEqual([100, 400]);
    expect(body).toMatchObject({ total: 1, more: false, capped: false });
  });
});

describe('a free-text collection while the selected engine is loading', () => {
  it('pages the stored preview, flagged pending, with one total on every page', async () => {
    setInProcessSearchForTests(fakeInProcessSearch(null));
    const id = seedCard([ids.get('street')!, ids.get('faced')!, ids.get('tower')!]);

    const first = await get(`/api/generated-searches/${id}/assets?limit=1`);
    const second = await get(`/api/generated-searches/${id}/assets?limit=1&offset=1`);
    const deeper = await get(`/api/generated-searches/${id}/assets?limit=30&offset=30`);

    expect(names(first.body)).toEqual(['street']);
    expect(names(second.body)).toEqual(['tower']);
    const pending = { total: 2, more: true, snapshot: true, pending: true };
    expect(first.body).toMatchObject(pending);
    expect(second.body).toMatchObject(pending);
    expect(deeper.body).toEqual({ ...pending, more: false, results: [] });
    for (const { statements } of [first, second, deeper]) {
      expect(statements.some((sql) => sql.includes('assets_fts'))).toBe(false);
    }
  });

  it('shortens a stored theme longer than a search accepts rather than refusing the card', async () => {
    const engine = fakeInProcessSearch(['bridge']);
    setInProcessSearchForTests(engine);
    const id = new ObjectId().toHexString();
    run(
      live.db,
      `INSERT INTO generated_searches
         (id, library_id, generated_for, generated_at, model, attempts,
          theme, title, subtitle, query, result_count, cover_asset_id, first_page_ids)
       VALUES (?, ?, '2026-10-12', '2026-10-12T03:00:00.000Z', 'm', 1, 't', 'Long', NULL, ?, 1,
               NULL, NULL)`,
      id,
      libraryId,
      JSON.stringify({ placeQuery: 'busy city streets '.repeat(100).trim() }),
    );

    const { status, body } = await get(`/api/generated-searches/${id}/assets`);

    expect(status).toBe(200);
    expect(body.total).toBe(1);
    expect(engine.queries[0]!.query.length).toBeLessThanOrEqual(1_000);
    expect('busy city streets '.repeat(100).startsWith(`${engine.queries[0]!.query} `)).toBe(true);
  });

  it('answers an empty pending page for a card stored before previews existed', async () => {
    setInProcessSearchForTests(fakeInProcessSearch(null));

    const { body } = await get(`/api/generated-searches/${seedCard()}/assets`);

    expect(body).toEqual({ total: 0, results: [], more: false, snapshot: true, pending: true });
  });
});
