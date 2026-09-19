/**
 * Before and after for #3746, measured rather than argued.
 *
 * Builds the same synthetic library twice — once as MongoDB documents, once as
 * SQLite rows — and runs each repository's own `findListItems` against it, so
 * the numbers come out of the code that ships rather than out of hand-written
 * queries that resemble it. It then checks the two lookups the ticket calls
 * defects, by plan on both engines and by clock on both engines.
 *
 *   bun scripts/sqlite-bench/list-items-compare.ts            # 60,000 assets
 *   bun scripts/sqlite-bench/list-items-compare.ts 200000     # a bigger one
 *
 * Nothing here touches production. The Mongo side creates a uniquely-named
 * database and drops it when it finishes; the SQLite side writes a scratch
 * file under `SQLITE_BENCH_DIR` (`/tmp/maple-sqlite-bench` by default) and
 * deletes it. Both generators are seeded, so a re-run reproduces the same
 * library. A Mongo instance is optional — without one, the SQLite half still
 * runs and the comparison rows say so.
 */

import type { Database } from 'bun:sqlite';
import { LIVE_LOCATION_COUNT_RECOMPUTE_SQL } from '../../src/db/sqlite/ddl/asset-locations.ts';
import { LIVE_ASSET_PREDICATE } from '../../src/db/sqlite/ddl/assets.ts';
import { ASSETS_FTS_REBUILD_SQL } from '../../src/db/sqlite/ddl/search.ts';
import { findListItems as mongoFindListItems } from '../../src/db/assets.repo.ts';
import { findListItems as sqliteFindListItems } from '../../src/db/sqlite/repos/assets.repo.ts';
import { testSqliteDb } from '../../src/db/sqlite/repos/assets.test-helpers.ts';
import { listItemsSql, locationsByAssetIdsSql } from '../../src/db/sqlite/repos/assets.sql.ts';
import {
  BENCH_DIR,
  openBenchDatabase,
  removeDatabase,
  size,
  timed,
  withMongoDatabase,
} from './compare-helpers.ts';
import { queryPlanLines } from './bench-db.ts';
import { generateLibrary } from './generate.ts';
import { buildMongoLibrary } from './mongo-library.ts';

const DEFAULT_ASSETS = 60_000;
const PAGE = 1000;
const DB_PATH = `${BENCH_DIR}/list-items-compare.db`;

/** The fallback lookup the ticket calls a defect, bound the same way on both engines. */
const PHASSET_DEVICE = 'device-1';
const PHASSET_LOCAL_ID = 'no-such-id';

// ---------------------------------------------------------------------------
// SQLite side
// ---------------------------------------------------------------------------

interface SqliteLibrary {
  db: Database;
  libraryId: string;
}

async function buildSqlite(assetCount: number): Promise<SqliteLibrary> {
  const db = await openBenchDatabase(DB_PATH);
  generateLibrary(db, { assetCount });
  db.exec(LIVE_LOCATION_COUNT_RECOMPUTE_SQL);
  db.exec(ASSETS_FTS_REBUILD_SQL);
  db.exec('ANALYZE');
  const libraryId = (db.query(`SELECT id FROM folders LIMIT 1`).get() as { id: string }).id;
  return { db, libraryId };
}

/** Bytes the database hands the process for one page, before any transform. */
function sqlitePageBytes(db: Database): number {
  const rows = db.query(listItemsSql([], true)).all(PAGE) as Array<{ id: string }>;
  const ids = rows.map((row) => row.id);
  const locations = db.query(locationsByAssetIdsSql(ids.length)).all(...ids);
  return JSON.stringify(rows).length + JSON.stringify(locations).length;
}

function plan(db: Database, sql: string, ...params: unknown[]): string {
  return queryPlanLines(db, sql, params).join(' / ');
}

const PHASSET_LOOKUP_SQL = `SELECT p.asset_id FROM asset_phasset_links p
   WHERE p.device_id = ? AND p.phasset_local_id = ?
     AND EXISTS (SELECT 1 FROM asset_locations l
                  WHERE l.asset_id = p.asset_id AND l.library_id = ? AND l.deleted_at IS NULL)
   LIMIT 1`;

/** The shape the schema doc calls load-bearing, against the one it warns about. */
const SEMI_JOIN_SQL = `SELECT a.id FROM assets a INDEXED BY assets_live_captured
   WHERE a.${LIVE_ASSET_PREDICATE}
     AND EXISTS (SELECT 1 FROM asset_locations l
                  WHERE l.asset_id = a.id AND l.ordinal = 0 AND l.library_id = ?)
   ORDER BY a.captured_at DESC, a.id LIMIT 200`;

const INNER_JOIN_SQL = `SELECT a.id FROM assets a
     JOIN asset_locations l ON l.asset_id = a.id AND l.ordinal = 0
   WHERE a.${LIVE_ASSET_PREDICATE} AND l.library_id = ?
   ORDER BY a.captured_at DESC, a.id LIMIT 200`;

// ---------------------------------------------------------------------------
// Mongo side
// ---------------------------------------------------------------------------

/** The two report lines the Mongo half contributes. */
interface MongoRows {
  page: string;
  lookup: string;
}

const MONGO_UNAVAILABLE: MongoRows = {
  page: 'mongodb unavailable — skipped',
  lookup: 'mongodb unavailable — skipped',
};

async function measureMongo(assetCount: number): Promise<MongoRows> {
  return withMongoDatabase(
    'maple_listcompare',
    async (db) => {
      await buildMongoLibrary(db, assetCount);

      const page = await timed(() => mongoFindListItems({ liveOnly: true }, PAGE, db));
      const fetched = await db
        .collection('assets')
        .find({ deleted_at: null })
        .limit(PAGE)
        .toArray();

      // The current filter, verbatim: two dotted paths with no index behind them.
      const explain = await db
        .collection('assets')
        .find({
          'phasset_links.device_id': PHASSET_DEVICE,
          'phasset_links.phasset_local_id': PHASSET_LOCAL_ID,
        })
        .explain('executionStats');
      const stats = (
        explain as { executionStats: { executionTimeMillis: number; totalDocsExamined: number } }
      ).executionStats;
      const stage = JSON.stringify(explain).includes('"COLLSCAN"') ? 'COLLSCAN' : 'indexed';

      return {
        page: `${page.ms.toFixed(1)} ms | fetched ${size(
          JSON.stringify(fetched).length,
        )} | DTO ${size(JSON.stringify(page.value).length)}`,
        lookup: `${stage}, ${stats.totalDocsExamined.toLocaleString()} docs examined, ${stats.executionTimeMillis} ms`,
      };
    },
    MONGO_UNAVAILABLE,
  );
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function reportPage(sqlite: SqliteLibrary, ms: number, dtoBytes: number, mongo: string): void {
  console.log(`findListItems, ${PAGE} rows`);
  console.log(`  mongo   ${mongo}`);
  console.log(
    `  sqlite  ${ms.toFixed(1)} ms | fetched ${size(sqlitePageBytes(sqlite.db))} | DTO ${size(
      dtoBytes,
    )}`,
  );
}

function reportLookup(sqlite: SqliteLibrary, ms: number, mongo: string): void {
  const args = [PHASSET_DEVICE, PHASSET_LOCAL_ID, sqlite.libraryId];
  console.log(`\nbackup-sidecar fallback lookup`);
  console.log(`  mongo   ${mongo}`);
  console.log(`  sqlite  ${ms.toFixed(3)} ms`);
  console.log(`          ${plan(sqlite.db, PHASSET_LOOKUP_SQL, ...args)}`);
}

function reportGridShape(sqlite: SqliteLibrary, semiMs: number, innerMs: number): void {
  console.log(`\ngrid page by library and date, 200 rows`);
  console.log(
    `  semi-join   ${semiMs.toFixed(2)} ms — ${plan(sqlite.db, SEMI_JOIN_SQL, sqlite.libraryId)}`,
  );
  console.log(
    `  inner join  ${innerMs.toFixed(2)} ms — ${plan(sqlite.db, INNER_JOIN_SQL, sqlite.libraryId)}`,
  );
}

async function main(): Promise<void> {
  const assetCount = Number.parseInt(process.argv[2] ?? '', 10) || DEFAULT_ASSETS;
  console.log(`#3746 — findListItems before/after, ${assetCount.toLocaleString()} assets\n`);

  const sqlite = await buildSqlite(assetCount);
  const handle = testSqliteDb(sqlite.db);
  const lookupArgs = [PHASSET_DEVICE, PHASSET_LOCAL_ID, sqlite.libraryId];

  const page = await timed(() => sqliteFindListItems({ liveOnly: true }, PAGE, handle));
  const lookup = await timed(async () => sqlite.db.query(PHASSET_LOOKUP_SQL).all(...lookupArgs));
  const semi = await timed(async () => sqlite.db.query(SEMI_JOIN_SQL).all(sqlite.libraryId));
  const inner = await timed(async () => sqlite.db.query(INNER_JOIN_SQL).all(sqlite.libraryId));
  const mongo = await measureMongo(assetCount);

  reportPage(sqlite, page.ms, JSON.stringify(page.value).length, mongo.page);
  reportLookup(sqlite, lookup.ms, mongo.lookup);
  reportGridShape(sqlite, semi.ms, inner.ms);

  sqlite.db.close();
  await removeDatabase(DB_PATH);
}

await main();
