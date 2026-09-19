/**
 * Before and after for #3750, measured rather than argued.
 *
 * Builds the same synthetic library twice — once as MongoDB documents, once as
 * SQLite rows — and runs the facet route's own aggregations against each: the
 * twelve `$group` pipelines from `routes/search/facets.ts` on one side, and the
 * statements `db/sqlite/repos/search.sql.ts` generates on the other. The numbers
 * therefore come out of the code that ships rather than out of hand-written
 * queries that resemble it.
 *
 *   bun scripts/sqlite-bench/search-compare.ts              # 60,000 assets
 *   bun scripts/sqlite-bench/search-compare.ts 335377       # production's count
 *   bun scripts/sqlite-bench/search-compare.ts --no-mongo   # SQLite half only
 *
 * It also reproduces the two measurements the schema's design rests on, because
 * both are invisible in a unit test: counting live assets through an `EXISTS`
 * sub-select instead of the `live_location_count` column, and filtering a grid
 * page with an inner join instead of a semi-join.
 *
 * Nothing here touches production. The Mongo side creates a uniquely-named
 * database and drops it when it finishes; the SQLite side writes a scratch file
 * under `SQLITE_BENCH_DIR` (`/tmp/maple-sqlite-bench` by default) and deletes
 * it. Both generators are seeded, so a re-run reproduces the same library.
 */

import type { Database } from 'bun:sqlite';
import { MongoClient, type Collection, type Db } from 'mongodb';
// The verbs come from the repository's public surface; the statement builders
// come from the module that owns them, because this benchmark times each facet
// separately and `searchFacets` deliberately issues all twelve at once.
import { buildSearchWhere, type SearchWhere } from '../../src/db/sqlite/repos/search.repo.ts';
import { facetStatements } from '../../src/db/sqlite/repos/search.facets.sql.ts';
import { countSql, pageSql } from '../../src/db/sqlite/repos/search.sql.ts';
import {
  benchDbPath,
  buildLibrary,
  removeDatabase,
  reopenReadOnly,
  sizeArgument,
  timeAsync,
  timeStatement,
} from './bench-db.ts';
import { buildMongoLibrary } from './mongo-library.ts';
import { MONGO_FACET_PIPELINES, mongoLiveFilter } from './search-mongo-facets.ts';

const DEFAULT_ASSETS = 60_000;
const RUNS = 5;
const MONGO_URI = process.env.MAPLE_MONGO_URI ?? 'mongodb://localhost:27017';
const DB_PATH = benchDbPath('search-compare');

/** The translated empty query — the facet route's own unfiltered case. */
function emptyWhere(): SearchWhere {
  const where = buildSearchWhere({});
  if ('error' in where) throw new Error(where.error);
  return where;
}

async function buildSqlite(assetCount: number): Promise<Database> {
  return reopenReadOnly(await buildLibrary(DB_PATH, assetCount), DB_PATH);
}

/** One row of the comparison table. */
interface Row {
  name: string;
  sqliteMs: number;
  sqliteRows: number;
  mongoMs: number | null;
}

/** Every facet statement, plus the count and a grid page, timed on SQLite. */
function timeSqlite(db: Database): Row[] {
  const where = emptyWhere();
  const statements = facetStatements(where);
  const facets = Object.entries(statements).map(([name, statement]) => {
    const { ms, rows } = timeStatement(db, statement.sql, statement.params, RUNS);
    return { name: `facet: ${name}`, sqliteMs: ms, sqliteRows: rows, mongoMs: null };
  });
  const page = pageSql(where, 'captured_desc', 200, 0);
  const pageTiming = timeStatement(db, page.sql, page.params, RUNS);
  return [
    ...facets,
    {
      name: 'grid page, 200 rows',
      sqliteMs: pageTiming.ms,
      sqliteRows: pageTiming.rows,
      mongoMs: null,
    },
  ];
}

/**
 * The two shapes the schema rejected, timed beside the ones it chose.
 *
 * Neither is a statement this repository issues. They are here because both
 * return correct rows and differ only in cost, so nothing but a clock catches a
 * change that reintroduces them.
 */
function timeCounterfactuals(db: Database, libraryId: string): Row[] {
  const live = 'assets.deleted_at IS NULL AND assets.live_location_count > 0';
  const cases: Array<[string, string]> = [
    [
      'count live assets (roll-up column — shipped)',
      `SELECT COUNT(*) AS n FROM assets WHERE ${live}`,
    ],
    [
      'count live assets (EXISTS sub-select — rejected)',
      `SELECT COUNT(*) AS n FROM assets
        WHERE assets.deleted_at IS NULL
          AND EXISTS (SELECT 1 FROM asset_locations l
                       WHERE l.asset_id = assets.id
                         AND l.deleted_at IS NULL AND l.missing_since IS NULL)`,
    ],
    [
      'library-scoped page (semi-join — shipped)',
      `SELECT assets.id FROM assets INDEXED BY assets_live_captured
        WHERE ${live}
          AND EXISTS (SELECT 1 FROM asset_locations l
                       WHERE l.asset_id = assets.id AND l.library_id = '${libraryId}'
                         AND l.deleted_at IS NULL AND l.missing_since IS NULL)
        ORDER BY assets.captured_at DESC, assets.id LIMIT 200`,
    ],
    [
      'library-scoped page (inner join — rejected)',
      `SELECT assets.id FROM assets
          JOIN asset_locations l ON l.asset_id = assets.id
        WHERE ${live} AND l.library_id = '${libraryId}'
          AND l.deleted_at IS NULL AND l.missing_since IS NULL
        ORDER BY assets.captured_at DESC, assets.id LIMIT 200`,
    ],
  ];
  return cases.map(([name, sql]) => {
    const { ms, rows } = timeStatement(db, sql, [], RUNS);
    return { name, sqliteMs: ms, sqliteRows: rows, mongoMs: null };
  });
}

/** The facet route's own pipelines, timed against MongoDB. */
async function timeMongo(assets: Collection): Promise<Map<string, number>> {
  const filter = mongoLiveFilter();
  const timings = new Map<string, number>();
  const count = await timeAsync(() => assets.countDocuments(filter), RUNS);
  timings.set('facet: total', count.ms);
  for (const [name, pipeline] of Object.entries(MONGO_FACET_PIPELINES)) {
    const result = await timeAsync(
      () => assets.aggregate([{ $match: filter }, ...pipeline]).toArray(),
      RUNS,
    );
    timings.set(`facet: ${name}`, result.ms);
  }
  const page = await timeAsync(
    () => assets.find(filter).sort({ 'exif.captured_at': -1, _id: 1 }).limit(200).toArray(),
    RUNS,
  );
  timings.set('grid page, 200 rows', page.ms);
  return timings;
}

function ratio(row: Row): string {
  const usable = row.mongoMs !== null && row.sqliteMs > 0;
  return usable ? `${(row.mongoMs! / row.sqliteMs).toFixed(0)}×` : '—';
}

/** One table row, with or without the MongoDB columns. */
function formatRow(row: Row, withMongo: boolean): string {
  const sqlite = `${row.sqliteMs.toFixed(2)} ms`;
  if (!withMongo) return `| ${row.name} | ${sqlite} | ${row.sqliteRows} |`;
  const mongo = row.mongoMs === null ? '—' : `${row.mongoMs.toFixed(0)} ms`;
  return `| ${row.name} | ${mongo} | ${sqlite} | ${ratio(row)} | ${row.sqliteRows} |`;
}

function printTable(rows: readonly Row[], withMongo: boolean): void {
  const header = withMongo
    ? ['\n| query | MongoDB | SQLite | speed-up | rows |', '| --- | --- | --- | --- | --- |']
    : ['\n| query | SQLite | rows |', '| --- | --- | --- |'];
  console.log([...header, ...rows.map((row) => formatRow(row, withMongo))].join('\n'));
}

async function withMongoLibrary(
  assetCount: number,
  body: (db: Db) => Promise<void>,
): Promise<boolean> {
  const client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 2000 });
  const name = `maple_search_compare_${Date.now()}`;
  try {
    await client.connect();
  } catch {
    await client.close().catch(() => {});
    return false;
  }
  try {
    const db = client.db(name);
    console.log(`Building the MongoDB library (${assetCount.toLocaleString()} documents)…`);
    await buildMongoLibrary(db, assetCount);
    await body(db);
    await db.dropDatabase();
    return true;
  } finally {
    await client.close().catch(() => {});
  }
}

const args = Bun.argv.slice(2);
const skipMongo = args.includes('--no-mongo');
const assetCount = sizeArgument(args, DEFAULT_ASSETS);

console.log(`\n# /api/search facets: MongoDB vs SQLite, ${assetCount.toLocaleString()} assets\n`);
console.log('Building the SQLite library…');
const sqlite = await buildSqlite(assetCount);
const libraryId = (sqlite.query('SELECT id FROM folders LIMIT 1').get() as { id: string }).id;
const rows = timeSqlite(sqlite);
const counterfactuals = timeCounterfactuals(sqlite, libraryId);

const mongoRan = skipMongo
  ? false
  : await withMongoLibrary(assetCount, async (db) => {
      const timings = await timeMongo(db.collection('assets'));
      for (const row of rows) row.mongoMs = timings.get(row.name) ?? null;
    });

printTable(rows, mongoRan);
if (!mongoRan) {
  console.log(
    skipMongo
      ? '\n(MongoDB column skipped by --no-mongo.)'
      : `\n(No MongoDB at ${MONGO_URI}; the SQLite half still ran.)`,
  );
}

console.log('\n## The two shapes the schema rejected\n');
printTable(counterfactuals, false);

sqlite.close();
await removeDatabase(DB_PATH);
