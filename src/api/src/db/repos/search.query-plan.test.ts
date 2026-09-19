/**
 * The plans, not the clock.
 *
 * Three shapes in this port are the whole performance argument, and all three
 * fail silently: a wrong plan still returns the right rows, just slowly, and on
 * a fixture library of thirteen assets it returns them in microseconds either
 * way. A timing here would prove nothing, so these assert what SQLite says it
 * will do — which is the same thing that goes wrong at 335,000 rows.
 *
 *  1. A grid page walks the ordered live index and stops at the limit, even
 *     with a residual filter that tempts the planner elsewhere.
 *  2. A filter on a location keeps `assets` as the outer loop.
 *  3. Every facet's base predicate reads `live_location_count` as a column, so
 *     the partial indexes apply and the group keys are index-only.
 */

import { describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { createTestDatabase } from '../sqlite/test-sqlite.test-helpers.ts';
import { facetStatements } from './search.facets.sql.ts';
import { countSql, pageSql } from './search.sql.ts';
import { buildSearchWhere, type SearchWhere } from './search.where.ts';
import { seedSearchLibrary, type SeededLibrary } from './search.test-helpers.ts';
import type { SearchQuery } from '../../routes/search/query-schema.ts';

function planOf(db: Database, sql: string): string {
  const rows = db.query(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>;
  return rows.map((row) => row.detail).join(' | ');
}

function translate(q: SearchQuery): SearchWhere {
  const built = buildSearchWhere(q);
  if ('error' in built) throw new Error(built.error);
  return built;
}

async function withLibrary<T>(body: (db: Database, library: SeededLibrary) => Promise<T>) {
  using handle = await createTestDatabase();
  const library = seedSearchLibrary(handle.db);
  return await body(handle.db, library);
}

describe('the grid page walks the ordered live index', () => {
  test('unfiltered', async () => {
    await withLibrary(async (db) => {
      const plan = planOf(db, pageSql(translate({}), 'captured_desc', 200, 0).sql);
      expect(plan).toContain('assets USING INDEX assets_live_captured');
      // No sort step: the index is already in the order the page asks for, so
      // the scan abandons at the limit instead of ordering the whole library.
      expect(plan).not.toContain('TEMP B-TREE FOR ORDER BY');
    });
  });

  test('with a residual the planner would otherwise chase', async () => {
    await withLibrary(async (db) => {
      // This is the shape that surfaced the need for INDEXED BY during #3746:
      // given an equality residual, the planner prefers to seek a different
      // partial index and then sort the entire live set.
      const plan = planOf(
        db,
        pageSql(translate({ isScreenshot: 'false' }), 'captured_desc', 200, 0).sql,
      );
      expect(plan).toContain('assets USING INDEX assets_live_captured');
      expect(plan).not.toContain('TEMP B-TREE FOR ORDER BY');
    });
  });

  test('a text query leads with the inverted index instead', async () => {
    await withLibrary(async (db) => {
      const plan = planOf(
        db,
        pageSql(translate({ placeQuery: 'harbour' }), 'captured_desc', 200, 0).sql,
      );
      // `M1` is SQLite reporting that the MATCH constraint is driving the scan
      // rather than the table being read end to end.
      expect(plan).toContain('assets_fts VIRTUAL TABLE INDEX 0:M1');
      expect(plan).toContain('asset_search USING INTEGER PRIMARY KEY');
    });
  });
});

describe('a text query that cannot match costs nothing', () => {
  test('the statements prepare, which an INDEXED BY would not let them', async () => {
    await withLibrary(async (db) => {
      // `WHERE 0` is folded before planning, which strips every index
      // constraint with it — so a statement that also names an index fails to
      // prepare with "no query solution". `search.sql.ts` drops the hint for
      // this case; if it stops doing that, these throw rather than go slow.
      const where = translate({ placeQuery: '-boat' });
      const page = pageSql(where, 'captured_desc', 200, 0);
      expect(page.sql).not.toContain('INDEXED BY');
      expect(() => db.query(page.sql).all(...(page.params as never[]))).not.toThrow();
      const range = facetStatements(where).capture_range;
      expect(range.sql).not.toContain('INDEXED BY');
      expect(() => db.query(range.sql).all(...(range.params as never[]))).not.toThrow();
    });
  });

  test('no statement joins the inverted index to prove an empty answer', async () => {
    await withLibrary(async (db) => {
      void db;
      const where = translate({ placeQuery: '???' });
      const statements = Object.values(facetStatements(where)).map((s) => s.sql);
      for (const sql of [...statements, pageSql(where, 'captured_desc', 200, 0).sql]) {
        expect(sql).toContain('WHERE 0');
        expect(sql).not.toContain('assets_fts');
      }
    });
  });

  test('the loop is skipped rather than walked', async () => {
    await withLibrary(async (db) => {
      // `EXPLAIN QUERY PLAN` prints `SCAN assets` here and it is misleading:
      // the plan it describes is generated inside a block the bytecode jumps
      // over. The proof is one address further down — a `Goto` that lands past
      // the loop — and the clock agrees, at 0.01 ms against 6.51 ms for the
      // same count over 335,377 assets.
      const { sql } = countSql(translate({ placeQuery: '-boat' }));
      const ops = db.query(`EXPLAIN ${sql}`).all() as Array<{
        addr: number;
        opcode: string;
        p2: number;
      }>;
      const rewind = ops.find((op) => op.opcode === 'Rewind');
      const skip = ops.find((op) => op.opcode === 'Goto' && op.addr < (rewind?.addr ?? 0));
      expect(rewind).toBeDefined();
      expect(skip!.p2).toBeGreaterThan(rewind!.addr);
    });
  });
});

describe('a location filter is a semi-join', () => {
  test('library scope keeps assets as the outer loop', async () => {
    await withLibrary(async (db, library) => {
      const plan = planOf(
        db,
        pageSql(translate({ libraryId: library.libraryId }), 'captured_desc', 200, 0).sql,
      );
      // assets first, one keyed probe into the locations index per candidate.
      expect(plan.startsWith('SCAN assets USING INDEX assets_live_captured')).toBe(true);
      expect(plan).toContain('asset_locations_library_live');
      expect(plan).not.toContain('TEMP B-TREE FOR ORDER BY');
    });
  });

  test('no page statement joins asset_locations in its own FROM', async () => {
    await withLibrary(async (db, library) => {
      // The structural half of the same rule, and the half a fixture library
      // can actually hold. Whether the *planner* leads with `asset_locations`
      // depends on statistics it does not have at thirteen rows, so the plan
      // assertion above only bites at scale; this one bites immediately if
      // someone rewrites a location filter as a join. The measurement behind
      // the rule — 50.18 ms against 0.07 ms — is reproduced by
      // `scripts/sqlite-bench/search-compare.ts`.
      void db;
      for (const query of [
        { libraryId: library.libraryId },
        { q: 'harbour' },
        { pathPrefix: 'trips' },
        { ext: 'dng' },
      ]) {
        const { sql } = pageSql(translate(query), 'captured_desc', 200, 0);
        expect(sql).not.toContain('JOIN asset_locations');
        expect(sql).toContain('EXISTS (SELECT 1 FROM asset_locations');
      }
    });
  });
});

describe('every facet groups an index over the live predicate', () => {
  test('the count is a range seek on the live partial index', async () => {
    await withLibrary(async (db) => {
      expect(planOf(db, countSql(translate({})).sql)).toContain(
        'assets USING INDEX assets_live (live_location_count>?)',
      );
    });
  });

  test('camera, lens, place and screenshot never read an asset row', async () => {
    await withLibrary(async (db) => {
      const statements = facetStatements(translate({}));
      const expected: Array<[keyof typeof statements, string]> = [
        ['cameras', 'assets_facet_camera'],
        ['lenses', 'assets_facet_lens'],
        ['places', 'assets_facet_place_label'],
        ['is_screenshot', 'assets_facet_screenshot'],
      ];
      for (const [facet, index] of expected) {
        const plan = planOf(db, statements[facet].sql);
        expect(plan).toContain(`SCAN assets USING INDEX ${index}`);
        // A GROUP BY that needed a temporary b-tree would mean the index is
        // not in the group's own order, which is what makes these index-only.
        expect(plan).not.toContain('TEMP B-TREE FOR GROUP BY');
      }
    });
  });

  test('every facet index carries the hidden column', async () => {
    await withLibrary(async (db) => {
      // The filter nobody asks for: hidden assets are excluded unless the
      // caller opts in, so every facet carries `hidden = 0`. An index that
      // omits the column serves the group key and then fetches each candidate
      // row to test it, which reads the whole `assets` table — measured at
      // 57.6 ms against 2.5 ms for the camera facet over 60,000 assets, and
      // 18.3 ms against 1.0 ms for the count.
      //
      // Asserted against the index definition rather than the query plan
      // because `EXPLAIN QUERY PLAN` prints the same line either way: it names
      // the index, not whether the scan had to leave it.
      const indexes = [
        'assets_live',
        'assets_live_captured',
        'assets_live_captured_ym',
        'assets_facet_camera',
        'assets_facet_lens',
        'assets_facet_place',
        'assets_facet_place_label',
        'assets_facet_screenshot',
      ];
      for (const index of indexes) {
        const columns = (
          db.query(`PRAGMA index_info(${index})`).all() as Array<{ name: string | null }>
        ).map((row) => row.name);
        expect(columns).toContain('hidden');
      }
    });
  });

  test('the capture-range facet reads the date out of the index', async () => {
    await withLibrary(async (db) => {
      // Left to itself the planner seeks `assets_live`, which answers the live
      // predicate and nothing else, then reads every matching row for its
      // capture date: 41.2 ms against 3.3 ms over 60,000 assets.
      expect(planOf(db, facetStatements(translate({})).capture_range.sql)).toContain(
        'SCAN assets USING INDEX assets_live_captured',
      );
    });
  });

  test('the six that group another table read one index and never join', async () => {
    await withLibrary(async (db) => {
      // #3768. Each of these used to group its own index cheaply and then ask
      // `assets` one question per candidate row — live, and visible? — which
      // cost between 252 and 1,134 ms at 335,377 assets and could not be
      // indexed away, because the answer was not in the grouped table. It is
      // now (`ddl/facet-state.ts`), so an unfiltered facet has nothing left to
      // ask and the join is gone entirely.
      const statements = facetStatements(translate({}));
      const expected: Array<[keyof typeof statements, string]> = [
        ['extensions', 'asset_locations_facet_extension'],
        ['scene_types', 'asset_detail_scene_type'],
        ['activities', 'asset_detail_activity'],
        ['subjects', 'asset_subjects_facet'],
        ['people', 'faces_facet_person'],
      ];
      for (const [facet, index] of expected) {
        const plan = planOf(db, statements[facet].sql);
        expect(plan).toContain(index);
        expect(plan).not.toContain('assets');
        expect(plan).not.toContain('TEMP B-TREE FOR GROUP BY');
      }
      // The sixth is the ISO range, which needed no mirror — only an index
      // over the generated column it takes MIN/MAX of, named because the
      // planner prefers `assets_live` and then re-parses every exif payload:
      // 265 ms against 12 ms.
      expect(planOf(db, statements.iso_range.sql)).toContain(
        'SCAN assets USING INDEX assets_facet_iso',
      );
    });
  });

  test('a filtered facet joins again, with assets pinned as the outer loop', async () => {
    await withLibrary(async (db) => {
      // The other half of the rule. A camera filter is a question only
      // `assets` can answer, so the join comes back, and the mirrored
      // predicates come out — the join already restricts the facet to live,
      // visible assets, and repeating it from the satellite only persuades the
      // planner to lead with the satellite, which measured 383 ms against
      // 145 ms for this facet and 1,132 ms against 136 ms for subjects.
      //
      // `CROSS JOIN` is what pins the order. Asserted against the statement
      // rather than the plan because the planner's choice depends on
      // statistics a thirteen-asset fixture does not have, and because the
      // pinned order is exactly what this test is about.
      for (const facet of [
        'scene_types',
        'activities',
        'extensions',
        'subjects',
        'people',
      ] as const) {
        const { sql } = facetStatements(translate({ camera: 'iPhone' }))[facet];
        expect(sql).toContain('CROSS JOIN');
        expect(sql).toContain('.asset_id = assets.id');
        expect(sql).toContain('assets.camera_make LIKE ?');
        expect(sql).not.toContain('asset_live');
        expect(sql).not.toContain('INDEXED BY');
      }
      // And both shapes count the same assets, which is the property the
      // mirror has to keep and the only one that matters. `rating=0` is a
      // residual that excludes nothing, so the only difference between the two
      // statements is the shape itself.
      const run = (query: SearchQuery): unknown[] => {
        const statement = facetStatements(translate(query)).scene_types;
        const rows = db.query(statement.sql).all(...(statement.params as never[]));
        // Equal counts may come back either way round: neither facet carries a
        // tie-breaker, and the wire meaning is the bucket, not the order.
        return rows.map((row) => JSON.stringify(row)).sort();
      };
      expect(run({})).toEqual(run({ rating: '0' }));
    });
  });

  test('assets_live_id answers the liveness probe without reading a row', async () => {
    await withLibrary(async (db) => {
      // Widened from (id) to (id, hidden) by #3768. Keyed on id alone the
      // probe answered liveness from the index and then read the whole asset
      // row to test `hidden`: the people facet measured 637 ms against 199 ms
      // over 335,377 assets on that column alone.
      const columns = (
        db.query(`PRAGMA index_info(assets_live_id)`).all() as Array<{ name: string | null }>
      ).map((row) => row.name);
      expect(columns).toEqual(['id', 'hidden']);
    });
  });

  test('the same count via an EXISTS sub-select loses the partial index', async () => {
    await withLibrary(async (db) => {
      // The alternative the schema rejected. It returns the same number and
      // costs 151 ms at 335k rows against 3.7 ms, which is why
      // `live_location_count` survived as a trigger-derived column.
      const plan = planOf(
        db,
        `SELECT COUNT(*) FROM assets
          WHERE assets.deleted_at IS NULL
            AND EXISTS (SELECT 1 FROM asset_locations l
                         WHERE l.asset_id = assets.id
                           AND l.deleted_at IS NULL AND l.missing_since IS NULL)`,
      );
      expect(plan).not.toContain('assets_live');
    });
  });
});

describe('qualifying the live predicate does not cost the partial indexes', () => {
  test('the qualified spelling plans identically to the bare one', async () => {
    await withLibrary(async (db) => {
      const bare = planOf(
        db,
        'SELECT COUNT(*) FROM assets WHERE deleted_at IS NULL AND live_location_count > 0',
      );
      const qualified = planOf(db, countSql(translate({})).sql);
      expect(qualified).toBe(bare);
    });
  });
});
