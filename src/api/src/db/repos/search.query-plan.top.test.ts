/**
 * The plans behind a broad text search's facets (#4431).
 *
 * Each of the three statements exists to avoid one row read per match, and a
 * plan that quietly reintroduces it still returns the right rows — only slower,
 * by the second on production. So the shape is pinned here:
 *
 *  - the score-only ranking reads the inverted index and nothing else (the
 *    month narrowing aside, which is a list built once);
 *  - the join of the best matches is led by those matches, probing
 *    `asset_search` and `assets` by key;
 *  - the exact total reads the inverted index and the `assets_unlisted` index,
 *    never an asset per match.
 *
 * None may contain `0:=`, the per-row FTS5 rowid probe that re-runs the whole
 * `MATCH` (see `search.query-plan.text.test.ts`).
 */

import { describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { createTestDatabase } from '../sqlite/test-sqlite.test-helpers.ts';
import { bestHitsSql, hitRowsSql } from './search.ranked.ts';
import type { BoundStatement } from './search.sql.ts';
import { textOnlyCountSql } from './search.text-count.ts';
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

async function withDb(body: (db: Database) => void): Promise<void> {
  using handle = await createTestDatabase();
  seedSearchLibrary(handle.db);
  body(handle.db);
}

const QUERIES: SearchQuery[] = [
  { placeQuery: 'group of people' },
  { placeQuery: 'harbour', month: '6' },
  { placeQuery: 'harbour', hidden: 'all' },
  { placeQuery: 'harbour', rating: '3', camera: 'apple' },
];

describe('the score-only ranking reads the inverted index alone', () => {
  for (const q of QUERIES) {
    test(JSON.stringify(q), async () => {
      await withDb((db) => {
        const plan = planOf(db, bestHitsSql(translate(q), 4_000));
        expect(plan[0]).toBe('SCAN assets_fts VIRTUAL TABLE INDEX 0:M1');
        expect(plan.filter((line) => line.includes('0:='))).toEqual([]);
        const outside = plan.filter(
          (line) => !line.includes('assets_fts') && !line.includes('TEMP B-TREE FOR ORDER BY'),
        );
        expect(outside.length === 0 || plan.includes('LIST SUBQUERY 1')).toBe(true);
        expect(plan.some((line) => line.includes('assets_live_id'))).toBe(false);
      });
    });
  }
});

describe('the best matches lead their own join', () => {
  for (const q of QUERIES) {
    test(JSON.stringify(q), async () => {
      await withDb((db) => {
        const plan = planOf(
          db,
          hitRowsSql(translate(q), [{ sr: 1, rank: -1 }], 'assets.rowid AS r', 10),
        );
        expect(plan[0]).toBe('SCAN json_each VIRTUAL TABLE INDEX 1:');
        expect(plan[1]).toBe('SEARCH asset_search USING INTEGER PRIMARY KEY (rowid=?)');
        expect(plan[2]).toMatch(/^SEARCH assets USING (COVERING )?INDEX \S+ \(.*id=\?.*\)$/);
        expect(plan.some((line) => line.includes('assets_fts'))).toBe(false);
        expect(plan.some((line) => line.startsWith('SCAN assets'))).toBe(false);
      });
    });
  }
});

describe('the exact total reads no asset per match', () => {
  test('without a month: matches less the unlisted', async () => {
    await withDb((db) => {
      const plan = planOf(db, textOnlyCountSql(translate({ placeQuery: 'group of people' })));
      expect(plan).toContain('SCAN assets USING INDEX assets_unlisted');
      expect(plan.filter((line) => line.startsWith('SCAN assets_fts'))).toEqual([
        'SCAN assets_fts VIRTUAL TABLE INDEX 0:M1',
        'SCAN assets_fts VIRTUAL TABLE INDEX 0:M1',
      ]);
      expect(plan.some((line) => line.includes('assets_live_id'))).toBe(false);
      expect(plan.filter((line) => line.includes('0:='))).toEqual([]);
    });
  });

  test("with a month: the month's rows, counted on the inverted index", async () => {
    await withDb((db) => {
      const plan = planOf(db, textOnlyCountSql(translate({ placeQuery: 'harbour', month: '6' })));
      expect(plan[0]).toBe('SCAN assets_fts VIRTUAL TABLE INDEX 0:M1');
      expect(plan).toContain(
        'SEARCH assets USING INDEX assets_live_month (captured_month=? AND hidden=?)',
      );
      expect(plan.some((line) => line.includes('assets_live_id'))).toBe(false);
      expect(plan.filter((line) => line.includes('0:='))).toEqual([]);
    });
  });
});
