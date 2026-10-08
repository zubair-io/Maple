/**
 * A text search's page, ranked on ids before rows are read, against the
 * single statement it replaced (#4419).
 *
 * The rewrite is only worth having if nobody can tell: same rows, same order,
 * same scores. The library here is built for ties — four blob shapes over
 * ninety assets, so most matches share a `bm25()` score and the capture date
 * and id decide the order — with undated, duplicated, hidden, rated, dead and
 * person-tagged assets mixed in, and every page boundary of every query is
 * compared against the old statement, which is restated below as it was.
 */

import { describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { createTestDatabase, insertFolder } from '../sqlite/test-sqlite.test-helpers.ts';
import { FTS_RANK_SQL } from './search.fts.ts';
import { pageSql, seekPredicate, statement, type BoundStatement } from './search.sql.ts';
import { buildSearchWhere, type BoundPredicate, type SearchWhere } from './search.where.ts';
import { searchPage } from './search.page.ts';
import { seedSearchAsset, type SeedAsset } from './search.test-helpers.ts';
import type { SearchQuery } from '../../routes/search/query-schema.ts';

function legacyPageSql(
  where: SearchWhere,
  limit: number,
  offset: number,
  seek?: BoundPredicate,
): BoundStatement {
  return statement(
    `assets.id, assets.size, assets.mtime, assets.indexed_at,
           assets.rating, assets.flag, assets.color_label, assets.has_xmp, assets.hidden,
           assets.exif, assets.place, assets.owner_id,
           ${FTS_RANK_SQL}`,
    where,
    `ORDER BY rank ASC, assets.captured_at DESC, assets.id\n   LIMIT ? OFFSET ?`,
    seek,
    [limit, offset],
  );
}

const BLOBS = [
  'autumn foliage orange red maple',
  'autumn foliage orange',
  'red barn autumn',
  'harbour boats at dawn',
];

function capturedAt(index: number): string | null {
  if (index % 7 === 0) return null;
  const day = String((index % 5) + 1).padStart(2, '0');
  return `2024-${String((index % 12) + 1).padStart(2, '0')}-${day}T10:00:00.000Z`;
}

function fixture(index: number): SeedAsset {
  return {
    searchBlob: BLOBS[index % BLOBS.length]!,
    capturedAt: capturedAt(index),
    hidden: index % 9 === 0,
    rating: index % 6,
    deletedAt: index % 17 === 0 ? '2024-07-01T00:00:00.000Z' : null,
    locationMissingSince: index % 23 === 0 ? '2024-07-01T00:00:00.000Z' : null,
    people: index % 4 === 0 ? ['Ada'] : index % 5 === 0 ? ['Grace'] : [],
  };
}

async function withTiedLibrary(
  body: (db: Database, people: Map<string, string>) => Promise<void>,
): Promise<void> {
  using handle = await createTestDatabase();
  const libraryId = insertFolder(handle.db, { slug: 'tied' });
  const people = new Map<string, string>();
  for (let index = 0; index < 90; index++) {
    seedSearchAsset(handle.db, libraryId, fixture(index), people);
  }
  await body(handle.db, people);
}

function rows(db: Database, bound: BoundStatement): unknown[] {
  return db.query(bound.sql).all(...(bound.params as never[]));
}

function translate(q: SearchQuery, excluded: readonly string[] = []): SearchWhere {
  const built = buildSearchWhere(q, excluded);
  if ('error' in built) throw new Error(built.error);
  return built;
}

const QUERIES: Array<[string, SearchQuery, excludeAda?: boolean]> = [
  ['broad', { placeQuery: 'autumn foliage orange red' }],
  ['single term', { placeQuery: 'autumn' }],
  ['phrase', { placeQuery: '"orange red"' }],
  ['negation', { placeQuery: 'autumn -barn' }],
  ['hidden included', { placeQuery: 'autumn', hidden: 'all' }],
  ['hidden only', { placeQuery: 'autumn', hidden: 'only' }],
  ['rating', { placeQuery: 'autumn foliage', rating: '3' }],
  ['month', { placeQuery: 'autumn', month: '3' }],
  ['month and hidden', { placeQuery: 'autumn red', month: '5', hidden: 'all' }],
  ['excluded people', { placeQuery: 'autumn foliage' }, true],
  ['no match', { placeQuery: 'zeppelin' }],
];

describe('a ranked page matches the statement it replaced', () => {
  for (const [name, q, excludeAda] of QUERIES) {
    test(`${name}, at every page boundary`, async () => {
      await withTiedLibrary(async (db, people) => {
        const where = translate(q, excludeAda ? [people.get('Ada')!] : []);
        for (const limit of [1, 7, 30, 200]) {
          for (const offset of [0, 1, 6, 7, 29, 64, 300]) {
            expect({
              limit,
              offset,
              rows: rows(db, pageSql(where, 'captured_desc', limit, offset)),
            }).toEqual({ limit, offset, rows: rows(db, legacyPageSql(where, limit, offset)) });
          }
        }
      });
    });
  }

  test('a seek predicate still narrows the candidates the same way', async () => {
    await withTiedLibrary(async (db) => {
      const where = translate({ placeQuery: 'autumn foliage' });
      for (const cursor of [
        { v: '2024-06-03T10:00:00.000Z', i: '0'.repeat(24), d: 'desc' as const },
        { v: null, i: '0'.repeat(24), d: 'desc' as const },
        { v: '2024-02-02T10:00:00.000Z', i: 'f'.repeat(24), d: 'asc' as const },
      ]) {
        const seek = seekPredicate(cursor);
        expect(rows(db, pageSql(where, 'captured_desc', 10, 0, seek))).toEqual(
          rows(db, legacyPageSql(where, 10, 0, seek)),
        );
      }
    });
  });

  test('a page asking for no rows returns none', async () => {
    await withTiedLibrary(async (db) => {
      const where = translate({ placeQuery: 'autumn' });
      expect(rows(db, pageSql(where, 'captured_desc', 0, 0))).toEqual([]);
      expect(rows(db, pageSql(where, 'captured_desc', 0, 5))).toEqual([]);
    });
  });

  test('ties are actually exercised, so the tie-breaks are what is compared', async () => {
    await withTiedLibrary(async (db) => {
      const page = rows(db, pageSql(translate({ placeQuery: 'autumn' }), 'captured_desc', 200, 0));
      const ranks = (page as Array<{ rank: number }>).map((row) => row.rank);
      expect(new Set(ranks).size).toBeLessThan(ranks.length / 5);
    });
  });

  test('searchPage still refuses a cursor on a text query', async () => {
    const cursor = { v: null, i: '0'.repeat(24), d: 'desc' as const };
    const unread = { read: async () => [] } as never;
    await expect(
      searchPage(
        translate({ placeQuery: 'autumn' }),
        { sort: 'captured_desc', limit: 5, skip: 0, cursor },
        unread,
      ),
    ).rejects.toThrow('relevance-ordered');
  });
});
