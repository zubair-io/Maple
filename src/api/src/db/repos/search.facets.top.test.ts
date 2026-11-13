/**
 * Facets of a text search describe its ranked window (#4431, #4514).
 *
 * Two properties. The buckets, counted in TypeScript over the window's rows,
 * are exactly what the per-facet statements answer for those rows. And the
 * facets of a search count exactly the window the list pages through — its
 * `total` is the window's size, never a count of every match.
 */

import { describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import {
  createTestDatabase,
  insertFolder,
  testSqliteDb,
} from '../sqlite/test-sqlite.test-helpers.ts';
import { facetStatements } from './search.facets.sql.ts';
import { searchFacets } from './search.facets.ts';
import { ftsRanker, rankWindow, RANKED_WINDOW_BASE } from './search.ranked.ts';
import { facetRowsOf } from './search.facets.top.ts';
import { buildSearchWhere, type SearchWhere } from './search.where.ts';
import { seedSearchAsset, type SeedAsset } from './search.test-helpers.ts';
import type { SearchQuery } from '../../routes/search/query-schema.ts';

const BLOBS = [
  'people standing ocean group front',
  'people group',
  'standing people beach',
  'autumn foliage orange red',
  'people autumn',
];
const CAMERAS = ['Canon', 'SONY', 'Apple', 'FUJIFILM'];

function fixture(index: number): SeedAsset {
  return {
    searchBlob: BLOBS[index % BLOBS.length]!,
    capturedAt:
      index % 7 === 0
        ? null
        : `2024-${String((index % 12) + 1).padStart(2, '0')}-0${(index % 5) + 1}T10:00:00.000Z`,
    cameraMake: CAMERAS[index % CAMERAS.length]!,
    cameraModel: `M${index % 3}`,
    hidden: index % 9 === 0,
    rating: index % 6,
    deletedAt: index % 17 === 0 ? '2024-07-01T00:00:00.000Z' : null,
    subjects: index % 2 === 0 ? ['person'] : ['water'],
    people: index % 4 === 0 ? ['Ada'] : index % 6 === 0 ? ['Grace'] : [],
  };
}

async function withLibrary(body: (db: Database, ada: string) => Promise<void>): Promise<void> {
  using handle = await createTestDatabase();
  const libraryId = insertFolder(handle.db, { slug: 'tied' });
  const people = new Map<string, string>();
  for (let index = 0; index < 120; index++) {
    seedSearchAsset(handle.db, libraryId, fixture(index), people);
  }
  await body(handle.db, people.get('Ada')!);
}

function translate(q: SearchQuery, excluded: readonly string[] = []): SearchWhere {
  const built = buildSearchWhere(q, excluded);
  if ('error' in built) throw new Error(built.error);
  return built;
}

/** `where` cut to the given rows — the per-facet statements' answer for them. */
function onlyRows(where: SearchWhere, rowids: readonly number[]): SearchWhere {
  return {
    ...where,
    match: { kind: 'none' },
    clauses: ['assets.rowid IN (SELECT value FROM json_each(?))'],
    params: [JSON.stringify(rowids)],
  };
}

function sorted(db: Database, bound: { sql: string; params: unknown[] }): string[] {
  return db
    .query(bound.sql)
    .all(...(bound.params as never[]))
    .map((row) => JSON.stringify(row))
    .sort();
}

const QUERIES: Array<[string, SearchQuery, excludeAda?: boolean]> = [
  ['broad', { placeQuery: 'group of people standing in front of the ocean' }],
  ['two words', { placeQuery: 'group of people' }],
  ['hidden included', { placeQuery: 'people ocean', hidden: 'all' }],
  ['hidden only', { placeQuery: 'people ocean', hidden: 'only' }],
  ['rating', { placeQuery: 'people autumn', rating: '4' }],
  ['camera', { placeQuery: 'people', camera: 'canon' }],
  ['month', { placeQuery: 'people autumn', month: '3' }],
  ['excluded people', { placeQuery: 'people standing' }, true],
];

/** Rows as sorted, key-ordered JSON, so neither column nor tie order can flake. */
function canonical(rows: readonly object[]): string[] {
  return rows.map((row) => JSON.stringify(Object.fromEntries(Object.entries(row).sort()))).sort();
}

describe('every facet of a window, counted in TypeScript', () => {
  for (const [name, q, excludeAda] of QUERIES) {
    test(`${name}: equals the per-facet statements over the same rows`, async () => {
      await withLibrary(async (db, ada) => {
        const where = translate(q, excludeAda ? [ada] : []);
        const handle = testSqliteDb(db);
        for (const k of [3, 10, 1_000]) {
          const ranked = (await ftsRanker(where, handle)(k))!.rows;
          const counted = await facetRowsOf(handle, ranked);
          const expected = facetStatements(
            onlyRows(
              where,
              ranked.map((row) => row.r),
            ),
          );
          for (const facet of Object.keys(counted) as Array<keyof typeof counted>) {
            const want = db
              .query(expected[facet].sql)
              .all(...(expected[facet].params as never[])) as object[];
            expect({ k, facet, rows: canonical(counted[facet]) }).toEqual({
              k,
              facet,
              rows: canonical(want),
            });
          }
        }
      });
    });
  }
});

describe('facets of a broad text search', () => {
  for (const [name, q, excludeAda] of QUERIES) {
    test(`${name}: count exactly the list's window`, async () => {
      await withLibrary(async (db, ada) => {
        const where = translate(q, excludeAda ? [ada] : []);
        const facets = await searchFacets(where, testSqliteDb(db));
        const window = (await rankWindow(ftsRanker(where, testSqliteDb(db)), RANKED_WINDOW_BASE))!;
        const expected = facetStatements(
          onlyRows(
            where,
            window.rows.map((row) => row.r),
          ),
        );
        expect(facets.total).toBe(window.rows.length);
        expect(facets.scope).toEqual({ kind: 'all' });
        expect(sorted(db, expected.cameras)).toEqual(
          facets.cameras
            .map((row) => JSON.stringify({ make: row.make, model: row.model, count: row.count }))
            .sort(),
        );
        expect(sorted(db, expected.subjects)).toEqual(
          facets.subjects.map((row) => JSON.stringify(row)).sort(),
        );
        expect(sorted(db, expected.people)).toEqual(
          facets.people.map((row) => JSON.stringify(row)).sort(),
        );
      });
    });
  }

  test('a window holding every match facets every match, exactly as before', async () => {
    await withLibrary(async (db) => {
      const where = translate({ placeQuery: 'group of people' });
      const direct = facetStatements(where);
      const facets = await searchFacets(where, testSqliteDb(db));
      expect(facets.scope).toEqual({ kind: 'all' });
      expect(
        facets.cameras
          .map((row) => JSON.stringify({ make: row.make, model: row.model, count: row.count }))
          .sort(),
      ).toEqual(sorted(db, direct.cameras));
      expect(facets.subjects.map((row) => JSON.stringify(row)).sort()).toEqual(
        sorted(db, direct.subjects),
      );
      expect(facets.total).toBe(
        (db.query(direct.total.sql).get(...(direct.total.params as never[])) as { n: number }).n,
      );
    });
  });

  test('a search without text is never cut', async () => {
    await withLibrary(async (db) => {
      const facets = await searchFacets(translate({ rating: '2' }), testSqliteDb(db));
      expect(facets.scope).toEqual({ kind: 'all' });
      expect(facets.total).toBeGreaterThan(1);
    });
  });
});
