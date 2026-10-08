/**
 * A text search's facets group a candidate set resolved once (#4413), and must
 * answer exactly what the per-facet full-text join answered before.
 *
 * The comparison runs both shapes against the fixture library for each facet,
 * rather than restating expected buckets: the per-facet statements are what
 * every other facet test already pins, so agreeing with them row for row is the
 * property that matters.
 */

import { describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { createTestDatabase, testSqliteDb } from '../sqlite/test-sqlite.test-helpers.ts';
import { facetCandidatesSql, facetStatements, scopedToCandidates } from './search.facets.sql.ts';
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

/** A statement's rows in a stable order, so a tie in `ORDER BY count` cannot flake. */
function rowsOf(db: Database, statement: { sql: string; params: unknown[] }): string[] {
  const rows = db.query(statement.sql).all(...(statement.params as never[]));
  return rows.map((row) => JSON.stringify(row)).sort();
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

describe('facets over a candidate set', () => {
  for (const q of TEXT_QUERIES) {
    test(`every facet agrees with the per-facet join for ${JSON.stringify(q)}`, async () => {
      using handle = await createTestDatabase();
      seedSearchLibrary(handle.db);
      const built = where(q);
      const candidates = facetCandidatesSql(built);
      const rowids = (
        handle.db.query(candidates.sql).all(...(candidates.params as never[])) as Array<{
          r: number;
        }>
      ).map((row) => row.r);

      const direct = facetStatements(built);
      const scoped = facetStatements(scopedToCandidates(built, rowids));
      for (const name of Object.keys(direct) as Array<keyof typeof direct>) {
        expect({ name, rows: rowsOf(handle.db, scoped[name]) }).toEqual({
          name,
          rows: rowsOf(handle.db, direct[name]),
        });
      }
      const count = handle.db
        .query(countSql(built).sql)
        .get(...(countSql(built).params as never[]));
      expect(rowids.length).toBe((count as { n: number }).n);
    });
  }

  test('an excluded person stays excluded through the candidate set', async () => {
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

  test('a text query evaluates its MATCH for the total and the candidates, not per facet', async () => {
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
    // The exact total and the score-only ranking read the inverted index
    // (#4431); the join of the best matches and the twelve groupings do not.
    expect(issued.filter((sql) => sql.includes('MATCH')).length).toBe(2);
    expect(issued.length).toBe(15);
  });
});
