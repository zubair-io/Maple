/**
 * A text search's facets — the first results of its list, read once and
 * counted in TypeScript (#4413, #4431) — must answer exactly what the
 * per-facet full-text join answers whenever those results are every match.
 *
 * The comparison runs both against the fixture library for each facet, rather
 * than restating expected buckets: the per-facet statements are what every
 * other facet test already pins, and they still serve every search without
 * text, so agreeing with them row for row is the property that matters.
 */

import { describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { createTestDatabase, testSqliteDb } from '../sqlite/test-sqlite.test-helpers.ts';
import { facetStatements } from './search.facets.sql.ts';
import { facetRowsOf } from './search.facets.top.ts';
import { firstRanked } from './search.ranked.ts';
import { countSql } from './search.sql.ts';
import { searchFacets } from './search.facets.ts';
import { buildSearchWhere, type SearchWhere } from './search.where.ts';
import { seedSearchLibrary } from './search.test-helpers.ts';
import type { SqliteDb } from './db-handle.ts';
import type { SearchQuery } from '../../routes/search/query-schema.ts';

function where(q: SearchQuery, excluded: readonly string[] = []): SearchWhere {
  const built = buildSearchWhere(q, excluded);
  if ('error' in built) throw new Error(built.error);
  return built;
}

/** Rows as sorted, key-ordered JSON, so neither column nor tie order can flake. */
function canonical(rows: readonly object[]): string[] {
  return rows.map((row) => JSON.stringify(Object.fromEntries(Object.entries(row).sort()))).sort();
}

function rowsOf(db: Database, statement: { sql: string; params: unknown[] }): string[] {
  return canonical(db.query(statement.sql).all(...(statement.params as never[])) as object[]);
}

const TEXT_QUERIES: SearchQuery[] = [
  { placeQuery: 'harbour' },
  { placeQuery: 'new york bridge' },
  { placeQuery: 'a' },
  { placeQuery: 'harbour', hidden: 'all' },
  { placeQuery: 'private', hidden: 'only' },
  { placeQuery: 'new york', camera: 'iphone' },
  { placeQuery: 'new york -bridge', rating: '3' },
  { placeQuery: '"paper lanterns"' },
  { placeQuery: 'zzzznomatch' },
];

describe('text facets over the first results', () => {
  for (const q of TEXT_QUERIES) {
    test(`every facet agrees with the per-facet join for ${JSON.stringify(q)}`, async () => {
      using handle = await createTestDatabase();
      seedSearchLibrary(handle.db);
      const built = where(q);
      const db = testSqliteDb(handle.db);
      const ranked = await firstRanked(db, built, 10_000);
      const counted = await facetRowsOf(db, ranked);

      const direct = facetStatements(built);
      for (const name of Object.keys(counted) as Array<keyof typeof counted>) {
        expect({ name, rows: canonical(counted[name]) }).toEqual({
          name,
          rows: rowsOf(handle.db, direct[name]),
        });
      }
      const count = handle.db
        .query(countSql(built).sql)
        .get(...(countSql(built).params as never[]));
      expect(ranked.length).toBe((count as { n: number }).n);
    });
  }

  test('an excluded person stays excluded', async () => {
    using handle = await createTestDatabase();
    const library = seedSearchLibrary(handle.db);
    const db = testSqliteDb(handle.db);
    const result = await searchFacets(
      where({ placeQuery: 'albany' }, [library.people.get('Ada')!]),
      db,
    );
    expect(result.total).toBe(0);
    expect(result.people).toEqual([]);
  });

  test('a text query reads the inverted index twice and each table once', async () => {
    using handle = await createTestDatabase();
    seedSearchLibrary(handle.db);
    const inner = testSqliteDb(handle.db);
    const issued: string[] = [];
    const recording: SqliteDb = {
      read: (sql, params) => {
        issued.push(sql);
        return inner.read(sql, params);
      },
      write: (sql, params) => inner.write(sql, params),
      transaction: (statements) => inner.transaction(statements),
    };
    const result = await searchFacets(where({ placeQuery: 'new york' }), recording);
    expect(result.total).toBe(3);
    // The exact total and the ranking of the first results read the inverted
    // index (#4431); then one read of `assets` and one per side table.
    expect(issued.filter((sql) => sql.includes('MATCH')).length).toBe(2);
    expect(issued.length).toBe(7);
  });
});
