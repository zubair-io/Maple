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

import { Database } from 'bun:sqlite';
import { MongoClient, type Collection, type Db } from 'mongodb';
import { LIVE_LOCATION_COUNT_RECOMPUTE_SQL } from '../../src/db/sqlite/ddl/asset-locations.ts';
import { SCHEMA_PRAGMAS } from '../../src/db/sqlite/ddl/index.ts';
import { ASSETS_FTS_OPTIMIZE_SQL, ASSETS_FTS_REBUILD_SQL } from '../../src/db/sqlite/ddl/search.ts';
import { fromBunSqlite, runMigrations } from '../../src/db/sqlite/migrate.ts';
import { ALL_MIGRATIONS } from '../../src/db/sqlite/migrations/index.ts';
import { countSql, facetStatements, pageSql } from '../../src/db/sqlite/repos/search.sql.ts';
import { buildSearchWhere, type SearchWhere } from '../../src/db/sqlite/repos/search.where.ts';
import { generateLibrary } from './generate.ts';
import { buildMongoLibrary } from './mongo-library.ts';
import { MONGO_FACET_PIPELINES, mongoLiveFilter } from './search-mongo-facets.ts';

const DEFAULT_ASSETS = 60_000;
const RUNS = 5;
const MONGO_URI = process.env.MAPLE_MONGO_URI ?? 'mongodb://localhost:27017';
const BENCH_DIR = process.env.SQLITE_BENCH_DIR ?? '/tmp/maple-sqlite-bench';
const DB_PATH = `${BENCH_DIR}/search-compare.db`;
/** WAL leaves two sidecars beside the database; all three go together. */
const DB_SUFFIXES = ['', '-wal', '-shm'];

/** The translated empty query — the facet route's own unfiltered case. */
function emptyWhere(): SearchWhere {
  const where = buildSearchWhere({});
  if ('error' in where) throw new Error(where.error);
  return where;
}

function median(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

/** Median of `RUNS` timed calls, after one untimed warm-up. */
async function timed<T>(fn: () => Promise<T>): Promise<{ ms: number; value: T }> {
  let value = await fn();
  const samples: number[] = [];
  for (let i = 0; i < RUNS; i += 1) {
    const startedAt = performance.now();
    value = await fn();
    samples.push(performance.now() - startedAt);
  }
  return { ms: median(samples), value };
}

function timeSync(db: Database, sql: string, params: unknown[]): { ms: number; rows: number } {
  const statement = db.query(sql);
  statement.all(...(params as never[]));
  const samples: number[] = [];
  let rows = 0;
  for (let i = 0; i < RUNS; i += 1) {
    const startedAt = performance.now();
    rows = statement.all(...(params as never[])).length;
    samples.push(performance.now() - startedAt);
  }
  return { ms: median(samples), rows };
}

/**
 * What the bulk load deferred: the derived location counts, the FTS5 index and
 * the planner statistics. The importer (#3744) does the same three things.
 */
function finishBulkLoad(db: Database): void {
  db.exec(LIVE_LOCATION_COUNT_RECOMPUTE_SQL);
  db.exec(ASSETS_FTS_REBUILD_SQL);
  db.exec(ASSETS_FTS_OPTIMIZE_SQL);
  db.exec('ANALYZE');
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
}

async function removeDatabase(): Promise<void> {
  for (const suffix of DB_SUFFIXES) {
    await Bun.file(`${DB_PATH}${suffix}`)
      .delete()
      .catch(() => {});
  }
}

async function buildSqlite(assetCount: number): Promise<Database> {
  await removeDatabase();
  const db = new Database(DB_PATH, { create: true });
  for (const pragma of SCHEMA_PRAGMAS) db.exec(pragma);
  await runMigrations(fromBunSqlite(db), ALL_MIGRATIONS);
  generateLibrary(db, { assetCount });
  finishBulkLoad(db);
  db.close();
  // Re-opened read-only so the timings start with an empty page cache, the
  // same way `./run.ts` measures.
  const reopened = new Database(DB_PATH, { readonly: true });
  for (const pragma of SCHEMA_PRAGMAS) {
    if (!pragma.includes('journal_mode')) reopened.exec(pragma);
  }
  return reopened;
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
    const { ms, rows } = timeSync(db, statement.sql, statement.params);
    return { name: `facet: ${name}`, sqliteMs: ms, sqliteRows: rows, mongoMs: null };
  });
  const page = pageSql(where, 'captured_desc', 200, 0);
  const pageTiming = timeSync(db, page.sql, page.params);
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
    const { ms, rows } = timeSync(db, sql, []);
    return { name, sqliteMs: ms, sqliteRows: rows, mongoMs: null };
  });
}

/** The facet route's own pipelines, timed against MongoDB. */
async function timeMongo(assets: Collection): Promise<Map<string, number>> {
  const filter = mongoLiveFilter();
  const timings = new Map<string, number>();
  const count = await timed(() => assets.countDocuments(filter));
  timings.set('facet: total', count.ms);
  for (const [name, pipeline] of Object.entries(MONGO_FACET_PIPELINES)) {
    const result = await timed(() => assets.aggregate([{ $match: filter }, ...pipeline]).toArray());
    timings.set(`facet: ${name}`, result.ms);
  }
  const page = await timed(() =>
    assets.find(filter).sort({ 'exif.captured_at': -1, _id: 1 }).limit(200).toArray(),
  );
  timings.set('grid page, 200 rows', page.ms);
  return timings;
}

function ratio(row: Row): string {
  if (row.mongoMs === null) return '—';
  if (row.sqliteMs <= 0) return '—';
  return `${(row.mongoMs / row.sqliteMs).toFixed(0)}×`;
}

function printTable(rows: Row[], withMongo: boolean): void {
  console.log(
    withMongo ? '\n| query | MongoDB | SQLite | speed-up | rows |' : '\n| query | SQLite | rows |',
  );
  console.log(withMongo ? '| --- | --- | --- | --- | --- |' : '| --- | --- | --- |');
  for (const row of rows) {
    const sqlite = `${row.sqliteMs.toFixed(2)} ms`;
    if (!withMongo) {
      console.log(`| ${row.name} | ${sqlite} | ${row.sqliteRows} |`);
      continue;
    }
    const mongo = row.mongoMs === null ? '—' : `${row.mongoMs.toFixed(0)} ms`;
    console.log(`| ${row.name} | ${mongo} | ${sqlite} | ${ratio(row)} | ${row.sqliteRows} |`);
  }
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
const sizes = args
  .filter((a) => !a.startsWith('--'))
  .map(Number)
  .filter((n) => Number.isFinite(n) && n > 0);
const assetCount = sizes[0] ?? DEFAULT_ASSETS;

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
await removeDatabase();
