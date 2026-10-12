/**
 * The plans behind a text search's ranked window (#4431, #4514).
 *
 * Each statement exists to avoid one row read per match, and a plan that
 * quietly reintroduces it still returns the right rows — only slower, by
 * minutes on production. So the shape is pinned here, with the planner's
 * statistics and without them (production's plan flipped once they went stale):
 *
 *  - the window is ranked on the inverted index alone (the month narrowing
 *    aside, which is a list built once), and only its hits are joined, probing
 *    `asset_search` and `assets` by key;
 *  - the facet columns of those results are read once, by key: `assets` by
 *    rowid and each side table by asset id, never by walking a table.
 *
 * None may contain `0:=`, the per-row FTS5 rowid probe that re-runs the whole
 * `MATCH` (see `search.query-plan.text.test.ts`).
 */

import { describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { createTestDatabase } from '../sqlite/test-sqlite.test-helpers.ts';
import { ftsWindowSql, mapleIdRowsSql } from './search.ranked.ts';
import { assetFacetRowsSql, sideFacetRowsSql } from './search.facets.top.ts';
import { windowColumnsSql, type BoundStatement } from './search.sql.ts';
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

async function withDb(
  body: (db: Database) => void,
  statistics?: 'analyzed' | 'none',
): Promise<void> {
  using handle = await createTestDatabase();
  seedSearchLibrary(handle.db);
  if (statistics !== undefined) handle.db.exec('ANALYZE');
  if (statistics === 'none') handle.db.exec('DELETE FROM sqlite_stat1');
  body(handle.db);
}

const QUERIES: SearchQuery[] = [
  { placeQuery: 'group of people' },
  { placeQuery: 'harbour', month: '6' },
  { placeQuery: 'harbour', hidden: 'all' },
  { placeQuery: 'harbour', rating: '3', camera: 'apple' },
];

describe('the window is ranked on the inverted index, then probed by key', () => {
  for (const statistics of ['analyzed', 'none'] as const) {
    for (const q of QUERIES) {
      test(`${JSON.stringify(q)}${statistics === 'none' ? ' without statistics' : ''}`, async () => {
        await withDb((db) => {
          const plan = planOf(db, ftsWindowSql(translate(q), 4_000));
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
        }, statistics);
      });
    }
  }
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

describe("another engine's ranked ids become rows by key", () => {
  for (const q of QUERIES) {
    test(JSON.stringify(q), async () => {
      await withDb((db) => {
        const plan = planOf(db, mapleIdRowsSql(translate(q), ['maple-a', 'maple-b']));
        expect(plan[0]).toMatch(
          /^SEARCH assets USING (COVERING )?INDEX assets_maple_id \(maple_id=\?\)/,
        );
        expect(plan.some((line) => line.includes('assets_fts'))).toBe(false);
        expect(plan.filter((line) => /^SCAN assets\b(?!_)/.test(line))).toEqual([]);
      });
    });
  }
});

describe("a window's page is re-read under its filters by key (#4545)", () => {
  for (const statistics of ['analyzed', 'none'] as const) {
    for (const q of QUERIES) {
      test(`${JSON.stringify(q)}${statistics === 'none' ? ' without statistics' : ''}`, async () => {
        await withDb((db) => {
          const plan = planOf(
            db,
            windowColumnsSql(translate(q), [
              '0123456789abcdef01234567',
              '89abcdef0123456789abcdef',
            ]),
          );
          expect(plan[0]).toMatch(/^SCAN page VIRTUAL TABLE/);
          // One equality probe per id: the primary key, or an index whose other
          // columns the filters pin to single values.
          expect(plan[1]).toMatch(
            /^SEARCH assets USING (COVERING )?INDEX \S+ \((\w+=\? AND )*id=\?( AND \w+=\?)*\)$/,
          );
          expect(plan.some((line) => line.includes('assets_fts'))).toBe(false);
          expect(plan.filter((line) => /^SCAN assets\b(?!_)/.test(line))).toEqual([]);
        }, statistics);
      });
    }
  }
});

const STORED_QUERIES: SearchQuery[] = [
  {},
  { month: '6' },
  { hidden: 'all' },
  { rating: '3', camera: 'apple' },
  { subjects: 'dog', ext: 'dng' },
  { placeQuery: 'harbour' },
];

describe("a collection's stored ids are re-read under its filters by key (#4571)", () => {
  for (const statistics of ['analyzed', 'none'] as const) {
    for (const q of STORED_QUERIES) {
      test(`${JSON.stringify(q)}${statistics === 'none' ? ' without statistics' : ''}`, async () => {
        await withDb((db) => {
          const plan = planOf(
            db,
            windowColumnsSql(translate(q), [
              '0123456789abcdef01234567',
              '89abcdef0123456789abcdef',
            ]),
          );
          expect(plan[0]).toMatch(/^SCAN page VIRTUAL TABLE/);
          expect(plan[1]).toMatch(
            /^SEARCH assets USING (COVERING )?INDEX \S+ \((\w+=\? AND )*id=\?( AND \w+=\?)*\)$/,
          );
          expect(plan.some((line) => line.includes('assets_fts'))).toBe(false);
          expect(plan.filter((line) => /^SCAN assets\b(?!_)/.test(line))).toEqual([]);
        }, statistics);
      });
    }
  }
});
