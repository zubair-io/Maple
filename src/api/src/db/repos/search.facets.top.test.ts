/**
 * Facets of a broad text search describe its most relevant matches (#4431).
 *
 * Two properties. With at most `topMatches` matches nothing changes: the
 * buckets count every match, as they always did. With more, the buckets count
 * exactly the first `topMatches` rows of the result list — same order, same
 * tie-breaks, every filter applied — and `scope` says so.
 *
 * The library is built for ties, so the boundary of the first `k` rows falls
 * among equal `bm25()` scores and the capture date and id decide it.
 */

import { describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import {
  createTestDatabase,
  insertFolder,
  testSqliteDb,
} from '../sqlite/test-sqlite.test-helpers.ts';
import { FTS_RANK_SQL } from './search.fts.ts';
import { facetStatements, scopedToCandidates } from './search.facets.sql.ts';
import { searchFacets } from './search.facets.ts';
import { firstRankedRowids } from './search.ranked.ts';
import { countSql, statement } from './search.sql.ts';
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

/** The result list's first `k` rows, by the order the list itself uses. */
function listHead(db: Database, where: SearchWhere, k: number): number[] {
  const head = statement(
    `assets.rowid AS r, ${FTS_RANK_SQL}`,
    where,
    'ORDER BY rank ASC, assets.captured_at DESC, assets.id LIMIT ?',
    undefined,
    [k],
  );
  const rows = db.query(head.sql).all(...(head.params as never[])) as Array<{ r: number }>;
  return rows.map((row) => row.r);
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

describe('the first k results of a text search', () => {
  for (const [name, q, excludeAda] of QUERIES) {
    test(`${name}: are the list's first k rows, for every k`, async () => {
      await withLibrary(async (db, ada) => {
        const where = translate(q, excludeAda ? [ada] : []);
        const handle = testSqliteDb(db);
        for (const k of [1, 2, 3, 5, 8, 13, 40, 200]) {
          expect({ k, rows: await firstRankedRowids(handle, where, k) }).toEqual({
            k,
            rows: listHead(db, where, k),
          });
        }
      });
    });
  }
});

describe('facets of a broad text search', () => {
  for (const [name, q, excludeAda] of QUERIES) {
    test(`${name}: count exactly the list's first k rows`, async () => {
      await withLibrary(async (db, ada) => {
        const where = translate(q, excludeAda ? [ada] : []);
        const count = countSql(where);
        const total = (db.query(count.sql).get(...(count.params as never[])) as { n: number }).n;
        for (const k of [3, 10]) {
          const facets = await searchFacets(where, testSqliteDb(db), k);
          const head = listHead(db, where, k);
          const expected = facetStatements(scopedToCandidates(where, head));
          const covered = Math.min(k, total);
          expect(facets.total).toBe(total);
          expect(facets.scope).toEqual(
            total > k ? { kind: 'top', limit: k, of: total } : { kind: 'all' },
          );
          expect(facets.cameras.reduce((sum, row) => sum + row.count, 0)).toBe(covered);
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
        }
      });
    });
  }

  test('at most k matches: every match, exactly as before', async () => {
    await withLibrary(async (db) => {
      const where = translate({ placeQuery: 'group of people' });
      const direct = facetStatements(where);
      const facets = await searchFacets(where, testSqliteDb(db), 1_000);
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
      const facets = await searchFacets(translate({ rating: '2' }), testSqliteDb(db), 1);
      expect(facets.scope).toEqual({ kind: 'all' });
      expect(facets.total).toBeGreaterThan(1);
    });
  });
});
