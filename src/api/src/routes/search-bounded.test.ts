/**
 * Every free-text route stays bounded on a large match set (#4514).
 *
 * The incident: For You cards whose themes are long sentences matched most of a 322k-asset
 * library, and their count ran for minutes per request once the planner put the inverted index
 * inside a per-asset loop. Three cards together held every reader and every other read timed out.
 *
 * This seeds 120k assets whose captions all match the incident's "busy city streets" theme, in a
 * file with no planner statistics — the condition under which the old count's plan nests the
 * full-text scan per asset (asserted below, so the fixture provably carries the hazard). Then it
 * drives the collection page, the search list, its facets and its buckets and pins what each
 * issued: the text ranked once on the inverted index alone with a `LIMIT`, only its hits joined,
 * no count of the match set, every heavy read on the bulk lane — and a wall time a whole-match
 * statement could not meet.
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
import { countSql } from '../db/repos/search.sql.ts';
import { generatedSearchesRoutes } from './generated-searches.ts';
import { searchRoutes, _resetBucketsCacheForTests, _resetCacheForTests } from './search/index.ts';
import { resetSearchEngineSelectionForTests } from '../search/search-engine-selection.ts';

const ASSETS = 120_000;
const THEME = 'busy city streets, tall buildings, and urban cityscapes';
const app = new Elysia().use(generatedSearchesRoutes).use(searchRoutes);

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

function translate(query: Record<string, string>): SearchWhere {
  const built = buildSearchWhere(query);
  if ('error' in built) throw new Error(built.error);
  return built;
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
  it("carries the incident's hazard: the old count nests the full-text scan per asset", () => {
    const statement = countSql(translate({ libraryId, placeQuery: THEME, month: '10' }));
    const plan = (
      live.db
        .query(`EXPLAIN QUERY PLAN ${statement.sql}`)
        .all(...(statement.params as never[])) as Array<{ detail: string }>
    ).map((row) => row.detail);
    const firstRead = plan.find((line) => /^(SCAN|SEARCH) /.test(line));
    expect(firstRead).not.toContain('assets_fts');
    expect(plan.some((line) => line.startsWith('SCAN assets_fts'))).toBe(true);
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
      `/api/search/facets?placeQuery=${encodeURIComponent(THEME)}&month=10`,
      `/api/search/buckets?placeQuery=${encodeURIComponent(THEME)}`,
    ]) {
      const { issued, ms } = await issuedBy(path);
      expectBounded(issued);
      expect({ path, fast: ms < BOUNDED_MS }).toEqual({ path, fast: true });
    }
  });
});
