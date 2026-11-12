/**
 * The plans behind folding RAW+JPEG stacks (#5849), with the planner's statistics and without.
 *
 * The fold is the residual `stack_primary_id IS NULL`, which matches nearly every row. The count
 * and the timeline histogram must still answer from `assets_live` and `assets_live_captured_ym`
 * alone, and a grid page must still walk `assets_live_captured` and stop at its limit. Statistics
 * are what make this worth pinning: `sqlite_stat1` sees one row per non-null pointer and rates
 * `IS NULL` as nearly unique, so a fold the planner may seek on sends the histogram to a skip-scan
 * of `assets_live` that reads every live row for its month and sorts them (the 1M-asset benchmark,
 * `scripts/sqlite-bench/raw-jpeg-stacks.ts`, shows the same flip).
 */

import { describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { createTestDatabase, run } from '../sqlite/test-sqlite.test-helpers.ts';
import { facetStatements } from './search.facets.sql.ts';
import { countSql, pageSql, timedBucketsSql, type BoundStatement } from './search.sql.ts';
import { buildSearchWhere, type SearchWhere } from './search.where.ts';
import { seedSearchAsset, seedSearchLibrary } from './search.test-helpers.ts';

const PAIRS = 150;
const SINGLES = 200;

function planOf(db: Database, statement: BoundStatement): string {
  const rows = db
    .query(`EXPLAIN QUERY PLAN ${statement.sql}`)
    .all(...(statement.params as never[])) as Array<{ detail: string }>;
  return rows.map((row) => row.detail).join(' | ');
}

/**
 * Whether a statement reads a column out of an `assets` row rather than out of an index. SQLite
 * opens the table cursor either way, so the opens prove nothing; a `Column` on it is a row read.
 */
function readsAssetRows(db: Database, statement: BoundStatement): boolean {
  const table = db
    .query<{ rootpage: number }, []>("SELECT rootpage FROM sqlite_master WHERE name = 'assets'")
    .get();
  const ops = db.query(`EXPLAIN ${statement.sql}`).all(...(statement.params as never[])) as Array<{
    opcode: string;
    p1: number;
    p2: number;
  }>;
  const cursors = new Set(
    ops.filter((op) => op.opcode === 'OpenRead' && op.p2 === table?.rootpage).map((op) => op.p1),
  );
  return ops.some((op) => op.opcode === 'Column' && cursors.has(op.p1));
}

function folded(): SearchWhere {
  const built = buildSearchWhere({}, [], null, { stackRawJpeg: true });
  if ('error' in built) throw new Error(built.error);
  return built;
}

/** The shared library plus a year of RAW+JPEG pairs and singles, the JPEGs paired as the sweep would. */
function seedStackedLibrary(db: Database): void {
  const { libraryId } = seedSearchLibrary(db);
  for (let k = 0; k < PAIRS + SINGLES; k += 1) {
    const month = String((k % 12) + 1).padStart(2, '0');
    const capturedAt = `2025-${month}-10T12:00:00.000Z`;
    const path = `stacks/${month}`;
    const raw = seedSearchAsset(db, libraryId, { filename: `IMG_${k}.CR3`, path, capturedAt });
    if (k >= PAIRS) continue;
    const jpeg = seedSearchAsset(db, libraryId, { filename: `IMG_${k}.JPG`, path, capturedAt });
    run(db, 'UPDATE assets SET stack_primary_id = ? WHERE id = ?', raw, jpeg);
  }
}

async function withDb(body: (db: Database) => void, statistics?: 'analyzed'): Promise<void> {
  using handle = await createTestDatabase();
  seedStackedLibrary(handle.db);
  if (statistics !== undefined) handle.db.exec('ANALYZE');
  body(handle.db);
}

for (const statistics of [undefined, 'analyzed'] as const) {
  describe(`folding RAW+JPEG stacks keeps every plan, ${statistics ?? 'no'} statistics`, () => {
    test('the count and the timeline histogram never read an asset row', async () => {
      await withDb((db) => {
        expect(planOf(db, countSql(folded()))).toBe(
          'SEARCH assets USING INDEX assets_live (live_location_count>?)',
        );
        expect(readsAssetRows(db, countSql(folded()))).toBe(false);
        expect(planOf(db, timedBucketsSql(folded()))).toBe(
          'SEARCH assets USING INDEX assets_live_captured_ym (captured_year>?)',
        );
        expect(readsAssetRows(db, timedBucketsSql(folded()))).toBe(false);
      }, statistics);
    });

    test('a grid page still walks the ordered live index and stops at the limit', async () => {
      await withDb((db) => {
        expect(planOf(db, pageSql(folded(), 'captured_desc', 200, 0))).toBe(
          'SCAN assets USING INDEX assets_live_captured',
        );
      }, statistics);
    });

    test('facet groups count files, so they keep their index-only shape', async () => {
      await withDb((db) => {
        const statements = facetStatements(folded());
        expect(statements.cameras.sql).not.toContain('stack_primary_id');
        expect(statements.total.sql).toContain('+assets.stack_primary_id IS NULL');
        expect(planOf(db, statements.cameras)).toContain(
          'SCAN assets USING INDEX assets_facet_camera',
        );
      }, statistics);
    });
  });
}

test('the fold drops exactly the paired JPEGs from the count', async () => {
  await withDb((db) => {
    const unfolded = buildSearchWhere({});
    if ('error' in unfolded) throw new Error(unfolded.error);
    const count = (statement: BoundStatement) =>
      (db.query(statement.sql).get(...(statement.params as never[])) as { n: number }).n;
    expect(count(countSql(unfolded)) - count(countSql(folded()))).toBe(PAIRS);
  });
});
