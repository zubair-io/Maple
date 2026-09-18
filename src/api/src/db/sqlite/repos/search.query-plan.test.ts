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
import { createTestDatabase } from '../test-sqlite.test-helpers.ts';
import { countSql, facetStatements, pageSql } from './search.sql.ts';
import { buildSearchWhere, type SearchWhere } from './search.where.ts';
import { seedSearchLibrary, type SeededLibrary } from './search.test-helpers.ts';
import type { SearchQuery } from '../../../routes/search/query-schema.ts';

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

  test('the people facet leads with the covering face index', async () => {
    await withLibrary(async (db) => {
      const plan = planOf(db, facetStatements(translate({})).people.sql);
      expect(plan).toContain('COVERING INDEX faces_person');
      expect(plan).toContain('assets USING INDEX sqlite_autoindex_assets_1');
    });
  });

  test('the facets that must reach another table do so by key', async () => {
    await withLibrary(async (db) => {
      const statements = facetStatements(translate({}));
      expect(planOf(db, statements.extensions.sql)).toContain(
        'SEARCH l USING INDEX sqlite_autoindex_asset_locations_1 (asset_id=? AND ordinal=?)',
      );
      expect(planOf(db, statements.scene_types.sql)).toContain(
        'SEARCH d USING PRIMARY KEY (asset_id=?)',
      );
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
