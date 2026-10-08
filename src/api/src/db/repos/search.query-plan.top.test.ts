/**
 * The plans behind a broad text search's facets (#4431).
 *
 * Each of the three statements exists to avoid one row read per match, and a
 * plan that quietly reintroduces it still returns the right rows — only slower,
 * by the second on production. So the shape is pinned here:
 *
 *  - the first results are ranked on the inverted index alone (the month
 *    narrowing aside, which is a list built once), and only those are joined,
 *    probing `asset_search` and `assets` by key;
 *  - the exact total reads the inverted index and the `assets_unlisted` index,
 *    never an asset per match;
 *  - the facet columns of those results are read once, by key: `assets` by
 *    rowid and each side table by asset id, never by walking a table.
 *
 * None may contain `0:=`, the per-row FTS5 rowid probe that re-runs the whole
 * `MATCH` (see `search.query-plan.text.test.ts`).
 */

import { describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { createTestDatabase } from '../sqlite/test-sqlite.test-helpers.ts';
import { firstRankedSql } from './search.ranked.ts';
import { assetFacetRowsSql, sideFacetRowsSql } from './search.facets.top.ts';
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

describe('the first results are ranked on the inverted index, then probed by key', () => {
  for (const q of QUERIES) {
    test(JSON.stringify(q), async () => {
      await withDb((db) => {
        const plan = planOf(db, firstRankedSql(translate(q), 4_000, 2_000));
        const reads = plan.filter(
          (line) => /^(SCAN|SEARCH) /.test(line) && line !== 'SCAN CONSTANT ROW',
        );
        // The ranking is the first table read, and the only full-text one.
        expect(reads[0]).toBe('SCAN assets_fts VIRTUAL TABLE INDEX 0:M1');
        expect(plan.filter((line) => line.includes('assets_fts'))).toEqual([
          'SCAN assets_fts VIRTUAL TABLE INDEX 0:M1',
        ]);
        expect(plan.filter((line) => line.includes('0:='))).toEqual([]);
        // Every asset is reached by key from a hit, never by walking the table
        // or one of its indexes.
        expect(reads.filter((line) => /^SCAN assets\b(?!_)/.test(line))).toEqual([]);
        expect(plan).toContain('SEARCH asset_search USING INTEGER PRIMARY KEY (rowid=?)');
        expect(
          reads.filter(
            (line) => line.startsWith('SEARCH assets ') && !/(id=\?|rowid=\?)/.test(line),
          ),
        ).toEqual(
          q.month === undefined
            ? []
            : ['SEARCH assets USING INDEX assets_live_month (captured_month=? AND hidden=?)'],
        );
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

describe('the facet columns of the first results are read by key', () => {
  test('assets by rowid, each side table by asset id', async () => {
    await withDb((db) => {
      const assets = [{ r: 1, id: '0123456789abcdef01234567' }];
      const reads: Array<[string, BoundStatement]> = [
        ['assets', assetFacetRowsSql(assets)],
        ...Object.entries(sideFacetRowsSql(assets)),
      ];
      const leads = reads.map(([name, statement]) => [name, planOf(db, statement)[0]]);
      expect(leads).toEqual([
        ['assets', 'SEARCH assets USING INTEGER PRIMARY KEY (rowid=?)'],
        [
          'extensions',
          'SEARCH l USING INDEX sqlite_autoindex_asset_locations_1 (asset_id=? AND ordinal=?)',
        ],
        ['details', 'SEARCH d USING INDEX sqlite_autoindex_asset_detail_1 (asset_id=?)'],
        [
          'subjects',
          'SEARCH s USING COVERING INDEX sqlite_autoindex_asset_subjects_1 (asset_id=?)',
        ],
        ['people', 'SEARCH f USING INDEX sqlite_autoindex_faces_1 (asset_id=?)'],
      ]);
      for (const [, statement] of reads) {
        expect(
          planOf(db, statement).filter((line) => /^SCAN (assets|l|d|s|f)\b/.test(line)),
        ).toEqual([]);
      }
    });
  });
});
