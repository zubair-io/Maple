/**
 * The plans a text search must keep, now that `assets_live_month` exists
 * (#4413).
 *
 * The index made a month filter cheap and made one plan catastrophic. Given
 * a selective index on `assets`, SQLite would rather start there and probe
 * the full-text index by rowid for each asset — and an FTS5 rowid probe
 * re-evaluates the whole `MATCH` every time. At 335k assets that took the
 * subjects and people facets from 0.6 s to 8–9 s each, and a month-led count
 * whose rowid list was not wrapped in `+` ran for over ten minutes. The rows
 * come back right either way, so only the plan can catch it.
 *
 * `0:M1` is SQLite reporting a MATCH-driven scan of the inverted index. The
 * bad plan reports `0:=M1` — a MATCH plus a rowid equality — which is the
 * per-row probe, and no text statement may contain it.
 */

import { describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { createTestDatabase } from '../sqlite/test-sqlite.test-helpers.ts';
import { facetCandidatesSql, facetStatements, scopedToCandidates } from './search.facets.sql.ts';
import { countSql, pageSql, type BoundStatement } from './search.sql.ts';
import { buildSearchWhere, type SearchWhere } from './search.where.ts';
import { seedSearchLibrary } from './search.test-helpers.ts';
import type { SearchQuery } from '../../routes/search/query-schema.ts';

function planOf(db: Database, statement: BoundStatement): string[] {
  const rows = db
    .query(`EXPLAIN QUERY PLAN ${statement.sql}`)
    .all(...(statement.params as never[])) as Array<{ detail: string }>;
  return rows.map((row) => row.detail);
}

function translate(q: SearchQuery): SearchWhere {
  const built = buildSearchWhere(q);
  if ('error' in built) throw new Error(built.error);
  return built;
}

/** Every statement a text search issues before facets are scoped. */
function textStatements(where: SearchWhere): Array<[string, BoundStatement]> {
  return [
    ['page', pageSql(where, 'captured_desc', 30, 0)],
    ['count', countSql(where)],
    ['facet candidates', facetCandidatesSql(where)],
    ...Object.entries(facetStatements(where)).map(([name, statement]): [string, BoundStatement] => [
      `facet ${name}`,
      statement,
    ]),
  ];
}

const TEXT_QUERIES: SearchQuery[] = [
  { placeQuery: 'scenic orange and red autumn foliage', month: '10' },
  { placeQuery: 'harbour', month: '6', hidden: 'all' },
  { placeQuery: 'harbour', month: '6', hidden: 'only' },
  { placeQuery: 'harbour', month: '6', rating: '3' },
  { placeQuery: 'harbour' },
];

async function withDb<T>(body: (db: Database) => T): Promise<T> {
  using handle = await createTestDatabase();
  seedSearchLibrary(handle.db);
  return body(handle.db);
}

describe('a text search scans the inverted index once, first', () => {
  for (const q of TEXT_QUERIES) {
    test(`every statement for ${JSON.stringify(q)}`, async () => {
      await withDb((db) => {
        for (const [name, statement] of textStatements(translate(q))) {
          const plan = planOf(db, statement);
          // The page ranks inside a materialised CTE (#4419); what matters is
          // the first thing read, which the `MATERIALIZE` header only names.
          const firstRead = plan.find((line) => !line.startsWith('MATERIALIZE'));
          expect({ name, first: firstRead }).toEqual({
            name,
            first: 'SCAN assets_fts VIRTUAL TABLE INDEX 0:M1',
          });
          expect({ name, probes: plan.filter((line) => line.includes('0:=')) }).toEqual({
            name,
            probes: [],
          });
        }
      });
    });
  }
});

describe('a month narrows the inverted index before any join', () => {
  test('through assets_live_month, as a list checked per hit', async () => {
    await withDb((db) => {
      const where = translate({ placeQuery: 'harbour', month: '6' });
      for (const [name, statement] of textStatements(where)) {
        const plan = planOf(db, statement).join(' | ');
        expect({ name, narrowed: plan.includes('LIST SUBQUERY') }).toEqual({
          name,
          narrowed: true,
        });
        expect({ name, index: plan.includes('assets USING INDEX assets_live_month') }).toEqual({
          name,
          index: true,
        });
      }
    });
  });

  test('a text search without a month is not narrowed', async () => {
    await withDb((db) => {
      const statement = countSql(translate({ placeQuery: 'harbour' }));
      expect(statement.sql).not.toContain('assets_live_month');
      expect(planOf(db, statement).join(' | ')).not.toContain('LIST SUBQUERY');
    });
  });

  test('a month without text uses the index directly', async () => {
    await withDb((db) => {
      const plan = planOf(db, countSql(translate({ month: '6' }))).join(' | ');
      expect(plan).toContain(
        'assets USING INDEX assets_live_month (captured_month=? AND hidden=?)',
      );
    });
  });
});

describe('facets scoped to a candidate set probe assets by rowid', () => {
  test('every grouping, the subjects and people facets included', async () => {
    await withDb((db) => {
      const where = scopedToCandidates(translate({ placeQuery: 'harbour', month: '6' }), [1, 2]);
      for (const [name, statement] of Object.entries(facetStatements(where))) {
        const plan = planOf(db, statement);
        expect({ name, first: plan[0] }).toEqual({
          name,
          first: 'SEARCH assets USING INTEGER PRIMARY KEY (rowid=?)',
        });
        expect({ name, fts: plan.some((line) => line.includes('assets_fts')) }).toEqual({
          name,
          fts: false,
        });
      }
    });
  });
});

describe('a ranked page scores ids first and reads rows for the page only', () => {
  for (const q of TEXT_QUERIES) {
    test(`the plan for ${JSON.stringify(q)}`, async () => {
      await withDb((db) => {
        const plan = planOf(db, pageSql(translate(q), 'captured_desc', 30, 0));
        expect(plan.slice(0, 2)).toEqual([
          'MATERIALIZE ranked',
          'SCAN assets_fts VIRTUAL TABLE INDEX 0:M1',
        ]);
        expect(plan.filter((line) => line.includes('assets_fts'))).toHaveLength(1);
        const afterRanking = plan.slice(plan.indexOf('SCAN ranked'));
        expect(afterRanking.filter((line) => /^(SCAN|SEARCH) assets\b/.test(line))).toEqual([
          'SEARCH assets USING INDEX sqlite_autoindex_assets_1 (id=?)',
        ]);
      });
    });
  }

  test('the scores are materialised once, not re-planned per reference', async () => {
    await withDb((db) => {
      const statement = pageSql(translate({ placeQuery: 'harbour' }), 'captured_desc', 30, 0);
      expect(statement.sql).toContain('ranked AS MATERIALIZED');
      expect(planOf(db, statement).filter((line) => line === 'MATERIALIZE ranked')).toHaveLength(1);
    });
  });
});
