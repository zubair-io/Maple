/**
 * Every free-text route stays bounded on a large match set (#4514).
 *
 * The incident: For You cards whose themes are long sentences matched most of a 322k-asset
 * library, and their count ran for minutes per request once the planner put the inverted index
 * inside a per-asset loop. Three cards together held every reader and every other read timed out.
 *
 * This seeds 120k assets whose captions all match the incident's "busy city streets" theme, with
 * a hidden person on some of them, in a file with no planner statistics — the condition under
 * which the old count's plan nests the full-text scan per asset (asserted below, so the fixture
 * provably carries the hazard). Then it drives the collection page, the search list, its facets,
 * its buckets and the map and pins what each issued: the text ranked once on the inverted index
 * alone with a `LIMIT`, only its hits joined, no count of the match set, every heavy read on the
 * bulk lane — and a wall time a whole-match statement could not meet.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { ObjectId } from '../db/object-id.ts';
import {
  createLiveTestDatabase,
  insertFolder,
  run,
  testSqliteDb,
  type LiveTestDatabase,
} from '../db/sqlite/test-sqlite.test-helpers.ts';
import {
  ASSET_LOCATIONS_TRIGGER_DDL,
  ASSET_LOCATIONS_TRIGGER_NAMES,
  LIVE_LOCATION_COUNT_RECOMPUTE_SQL,
} from '../db/sqlite/ddl/asset-locations.ts';
import {
  ASSET_SEARCH_TRIGGER_DDL,
  ASSET_SEARCH_TRIGGER_NAMES,
  ASSETS_FTS_REBUILD_SQL,
} from '../db/sqlite/ddl/search.ts';
import {
  FACET_STATE_RECOMPUTE_SQL,
  FACET_STATE_TRIGGER_DDL,
  FACET_STATE_TRIGGER_NAMES,
} from '../db/sqlite/ddl/facet-state.ts';
import { setSqliteHandleForTests } from '../db/sqlite/index.ts';
import type { SqliteDb } from '../db/repos/db-handle.ts';
import type { SqlParams } from '../db/sqlite/protocol.ts';
import { buildSearchWhere, type SearchWhere } from '../db/repos/search.where.ts';
import { countSql, pageSql, type BoundStatement } from '../db/repos/search.sql.ts';
import { facetStatements } from '../db/repos/search.facets.sql.ts';
import { mapRoutes } from './map/index.ts';
import { generatedSearchesRoutes } from './generated-searches.ts';
import { searchRoutes, _resetBucketsCacheForTests, _resetCacheForTests } from './search/index.ts';
import { resetSearchEngineSelectionForTests } from '../search/search-engine-selection.ts';

const ASSETS = 120_000;
const HIDDEN_PERSON = 'a'.repeat(24);
const THEME = 'busy city streets, tall buildings, and urban cityscapes';
const app = new Elysia().use(generatedSearchesRoutes).use(searchRoutes).use(mapRoutes);

let live: LiveTestDatabase;
let libraryId: string;

/** 120k live assets, every caption matching {@link THEME}, loaded the way the importer does. */
function seedLargeLibrary(): void {
  const db = live.db;
  libraryId = insertFolder(db, { slug: 'big', path: '/big' });
  const triggers = [
    ...ASSET_LOCATIONS_TRIGGER_NAMES,
    ...ASSET_SEARCH_TRIGGER_NAMES,
    ...FACET_STATE_TRIGGER_NAMES,
  ];
  for (const name of triggers) db.exec(`DROP TRIGGER IF EXISTS ${name}`);
  db.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${ASSETS})
    INSERT INTO assets (id, size, mtime, indexed_at, exif, maple_id, is_screenshot)
    SELECT printf('%024x', i), 1, 1, '2024-01-01',
           json_object('captured_at', printf('2020-%02d-15T12:00:00.000Z', (i % 12) + 1),
                       'captured_year', 2020, 'captured_month', (i % 12) + 1),
           printf('%032x', i), 0
      FROM n`);
  db.run(
    `INSERT INTO asset_locations (asset_id, ordinal, library_id, path, filename)
     SELECT id, 0, ?, 'big', id || '.jpg' FROM assets`,
    [libraryId],
  );
  db.exec(`INSERT INTO asset_search (asset_id, search_blob)
    SELECT id, 'photo of a busy city street with tall buildings w' || (rowid % 997)
               || ' v' || (rowid % 89) || ' u' || (rowid % 13)
      FROM assets`);
  db.run(
    `INSERT INTO people (id, name, name_key, created_at, updated_at, hidden)
     VALUES (?, 'Hidden', 'hidden', '2024-01-01', '2024-01-01', 1)`,
    [HIDDEN_PERSON],
  );
  db.run(
    `INSERT INTO faces (asset_id, face_index, person_id, confidence,
                        bbox_x, bbox_y, bbox_w, bbox_h, embedding_version)
     SELECT id, 0, ?, 0.9, 0.1, 0.1, 0.1, 0.1, 1 FROM assets WHERE rowid % 50 = 0`,
    [HIDDEN_PERSON],
  );
  db.exec(LIVE_LOCATION_COUNT_RECOMPUTE_SQL);
  db.exec(FACET_STATE_RECOMPUTE_SQL);
  db.exec(ASSETS_FTS_REBUILD_SQL);
  db.exec(ASSET_LOCATIONS_TRIGGER_DDL);
  db.exec(ASSET_SEARCH_TRIGGER_DDL);
  db.exec(FACET_STATE_TRIGGER_DDL);
}

function seedCard(query: Record<string, string>): string {
  const id = new ObjectId().toHexString();
  run(
    live.db,
    `INSERT INTO generated_searches
       (id, library_id, generated_for, generated_at, model, attempts,
        theme, title, subtitle, query, result_count, cover_asset_id, first_page_ids)
     VALUES (?, ?, '2026-10-12', '2026-10-12T03:00:00.000Z', 'm', 1, 't', 'City', NULL, ?, 100,
             NULL, NULL)`,
    id,
    libraryId,
    JSON.stringify(query),
  );
  return id;
}

const SEED_TIMEOUT_MS = 120_000;
const BOUNDED_MS = 30_000;

beforeAll(async () => {
  live = await createLiveTestDatabase('file');
  seedLargeLibrary();
  resetSearchEngineSelectionForTests();
}, SEED_TIMEOUT_MS);

afterAll(() => {
  setSqliteHandleForTests(live.handle);
  live.close();
});

/** Every statement one request issued, `bulk: `-prefixed when it took the bulk lane. */
interface Issued {
  sql: string;
  params: SqlParams | undefined;
  bulk: boolean;
}

/** Every statement one request issued, with its parameters and the lane it took. */
async function issuedBy(
  path: string,
): Promise<{ issued: Issued[]; ms: number; body: { total: number; results: unknown[] } }> {
  _resetCacheForTests();
  _resetBucketsCacheForTests();
  const inner = testSqliteDb(live.db);
  const issued: Issued[] = [];
  const handle: SqliteDb & { readBulk: SqliteDb['read'] } = {
    read: (sql, params) => (issued.push({ sql, params, bulk: false }), inner.read(sql, params)),
    readBulk: (sql, params) => (issued.push({ sql, params, bulk: true }), inner.read(sql, params)),
    write: (sql, params) => inner.write(sql, params),
    transaction: (statements) => inner.transaction(statements),
  };
  setSqliteHandleForTests(handle);
  const started = performance.now();
  const res = await app.handle(new Request(`http://localhost${path}`));
  const ms = performance.now() - started;
  expect(res.status).toBe(200);
  return { issued, ms, body: await res.json() };
}

function planOf(statement: Issued): string[] {
  const args = (Array.isArray(statement.params) ? statement.params : []) as never[];
  return (
    live.db.query(`EXPLAIN QUERY PLAN ${statement.sql}`).all(...args) as Array<{ detail: string }>
  ).map((row) => row.detail);
}

/**
 * The primary gate is the plan, not the clock: the text is ranked once, alone, with a `LIMIT`, on
 * the bulk lane — the full-text scan is the first table read and the only one, never nested under
 * an asset loop — and nothing counts the match set.
 */
function expectBounded(issued: readonly Issued[]): void {
  const fullText = issued.filter((statement) => statement.sql.includes('assets_fts'));
  expect(fullText.length).toBeGreaterThan(0);
  for (const statement of fullText) {
    expect(statement.bulk).toBe(true);
    expect(statement.sql).toMatch(/ORDER BY rank ASC, assets_fts\.rowid\s+LIMIT \?\)/);
    const plan = planOf(statement);
    const reads = plan.filter(
      (line) => /^(SCAN|SEARCH) /.test(line) && line !== 'SCAN CONSTANT ROW',
    );
    expect(reads[0]).toBe('SCAN assets_fts VIRTUAL TABLE INDEX 0:M1');
    expect(plan.filter((line) => line.includes('assets_fts'))).toHaveLength(1);
    expect(plan.filter((line) => line.includes('0:='))).toEqual([]);
  }
  expect(
    issued.filter((statement) => /COUNT\(\*\)\s+AS n\s+FROM assets_fts/.test(statement.sql)),
  ).toEqual([]);
}

describe('a large match set, without planner statistics', () => {
  it('no combined text statement can nest the full-text scan under an asset loop', () => {
    // Production's plan for the October card's count led with `assets_live_month` and re-ran
    // the whole MATCH once per asset (#4514). No request issues these combined statements for
    // text any more, but the shape is pinned for any caller that does: the inverted index is
    // the outermost read of every one, with the month, the library and the hidden people that
    // drove that plan all present.
    const where = buildSearchWhere(
      { libraryId, placeQuery: THEME, month: '10', isScreenshot: 'false' },
      [HIDDEN_PERSON],
    ) as SearchWhere;
    const statements: Array<[string, BoundStatement]> = [
      ['count', countSql(where)],
      ['page', pageSql(where, 'captured_desc', 30, 0)],
      ...Object.entries(facetStatements(where)),
    ];
    const before = countSql(where).sql.replaceAll('CROSS JOIN', 'JOIN');
    const hazard = planOf({ sql: before, params: countSql(where).params, bulk: false }).find(
      (line) => /^(SCAN|SEARCH) /.test(line),
    );
    expect(hazard).toStartWith('SEARCH assets USING INDEX assets_live_month');
    for (const [name, statement] of statements) {
      const reads = planOf({ sql: statement.sql, params: statement.params, bulk: false }).filter(
        (line) => /^(SCAN|SEARCH) /.test(line) && line !== 'SCAN CONSTANT ROW',
      );
      expect({ name, first: reads[0] }).toEqual({
        name,
        first: 'SCAN assets_fts VIRTUAL TABLE INDEX 0:M1',
      });
    }
  });

  it('a For You card ranks a bounded window and never counts the library', async () => {
    const id = seedCard({ placeQuery: THEME, month: '10' });
    const { issued, ms, body } = await issuedBy(`/api/generated-searches/${id}/assets?limit=30`);
    expectBounded(issued);
    expect(body.results).toHaveLength(30);
    expect(body.total).toBeLessThanOrEqual(5_000);
    expect(ms).toBeLessThan(BOUNDED_MS);
  });

  it('a search list, its facets and its buckets stay bounded too', async () => {
    for (const path of [
      `/api/search?placeQuery=${encodeURIComponent(THEME)}&month=10&excludeHiddenPeople=true`,
      `/api/search/facets?placeQuery=${encodeURIComponent(THEME)}&month=10&excludeHiddenPeople=true`,
      `/api/search/buckets?placeQuery=${encodeURIComponent(THEME)}&month=10`,
      `/api/map/clusters?placeQuery=${encodeURIComponent(THEME)}&month=10&bbox=-180,-90,180,90&zoom=3`,
    ]) {
      const { issued, ms } = await issuedBy(path);
      expectBounded(issued);
      expect({ path, fast: ms < BOUNDED_MS }).toEqual({ path, fast: true });
    }
  });
});
