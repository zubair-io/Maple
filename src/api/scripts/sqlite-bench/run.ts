/**
 * Schema benchmark for #3743.
 *
 * Builds a synthetic library at one or more sizes, measures how much space each
 * table and index occupies, and times the queries the schema is meant to make
 * fast — including the three facet aggregations that used to take about five
 * seconds each.
 *
 * Everything is generated. Nothing here connects to production.
 *
 *   bun scripts/sqlite-bench/run.ts                    # 335k, 600k, 1M
 *   bun scripts/sqlite-bench/run.ts 50000              # one size
 *   bun scripts/sqlite-bench/run.ts 335377 --keep      # leave the .db behind
 *
 * `--keep` doubles as the dev fixture: the library it leaves behind carries
 * per-stage `stage_state` rows with a realistic spread of pending, retrying and
 * dead work, so pointing `MAPLE_SQLITE_PATH` at it renders a populated
 * Settings → Workers table with no real photos anywhere.
 *
 * `bun:sqlite` is used directly and on purpose: this script owns its process
 * and has no event loop to protect, so the worker pool (#3742) is irrelevant
 * here. The schema and the migration runner make no assumption either way.
 */

import { Database } from 'bun:sqlite';
import { LIVE_LOCATION_COUNT_RECOMPUTE_SQL } from '../../src/db/sqlite/ddl/asset-locations.ts';
import { LIVE_ASSET_PREDICATE } from '../../src/db/sqlite/ddl/assets.ts';
import { SCHEMA_PRAGMAS } from '../../src/db/sqlite/ddl/index.ts';
import { ASSETS_FTS_OPTIMIZE_SQL, ASSETS_FTS_REBUILD_SQL } from '../../src/db/sqlite/ddl/search.ts';
import { fromBunSqlite, runMigrations } from '../../src/db/sqlite/migrate.ts';
import { ALL_MIGRATIONS } from '../../src/db/sqlite/migrations/index.ts';
import { ensureBenchDir } from './bench-db.ts';
import { generateLibrary } from './generate.ts';

const DEFAULT_SIZES = [335_377, 600_000, 1_000_000];
// The exact spelling from the schema — a partial index is only used when the
// query WHERE provably implies the index WHERE, so this must not be paraphrased.
const LIVE = LIVE_ASSET_PREDICATE;
// Every browse, search and facet request carries this too: the where-builder
// emits `hidden = 0` unless the caller asks for hidden assets, so a measurement
// without it is measuring a query the product never issues.
const VISIBLE = `${LIVE} AND hidden = 0`;
// The generator spreads assets over four library roots; 'bench-1' holds about
// a fifth of them, so a library-scoped query has to discriminate rather than
// matching everything.
const SCOPED_LIBRARY = `(SELECT id FROM folders WHERE slug = 'bench-1')`;

/**
 * The same predicate with every column qualified by a table alias, for the
 * queries that name more than one table.
 *
 * Deriving it beats writing `a.${VISIBLE}`, which only qualifies the FIRST
 * column and leaves the rest bare — harmless while `assets` is the only table
 * in scope, a silent wrong-column bind the moment it is not. Splitting on
 * ' AND ' is safe because the predicate is a flat conjunction of column terms,
 * by the same rule that keeps it usable by a partial index.
 */
function visible(alias: string): string {
  return VISIBLE.split(' AND ')
    .map((term) => `${alias}.${term}`)
    .join(' AND ');
}

interface Measurement {
  name: string;
  /** What this stands in for on the Mongo side. */
  replaces: string;
  sql: string;
  /** Rows the query is expected to return, for a sanity check. */
  expectRows?: (rows: unknown[]) => boolean;
}

const MEASUREMENTS: Measurement[] = [
  {
    name: 'count live assets',
    replaces: 'countDocuments(applyLiveFilter({})) — facets.ts total',
    sql: `SELECT COUNT(*) AS n FROM assets WHERE ${VISIBLE}`,
  },
  {
    name: 'facet: camera make + model',
    replaces: '$group by { exif.camera_make, exif.camera_model } — facets.ts',
    sql: `SELECT camera_make, camera_model, COUNT(*) AS n FROM assets
           WHERE ${VISIBLE} GROUP BY camera_make, camera_model ORDER BY n DESC LIMIT 50`,
  },
  {
    name: 'facet: place country code',
    replaces: 'the place_rollups drill-down the country index was built for',
    sql: `SELECT place_country_code, COUNT(*) AS n FROM assets
           WHERE ${VISIBLE} AND place_country_code IS NOT NULL
           GROUP BY place_country_code ORDER BY n DESC LIMIT 100`,
  },
  {
    name: 'facet: place locality + region',
    replaces: '$group by { place.rollups.locality, place.rollups.region } — facets.ts',
    sql: `SELECT place_locality, place_region, COUNT(*) AS n FROM assets
           WHERE ${VISIBLE} AND (place_locality IS NOT NULL OR place_region IS NOT NULL)
           GROUP BY place_locality, place_region ORDER BY n DESC LIMIT 100`,
  },
  {
    name: 'facet: lens',
    replaces: "$group by '$exif.lens' — facets.ts",
    sql: `SELECT lens, COUNT(*) AS n FROM assets WHERE ${VISIBLE}
           GROUP BY lens ORDER BY n DESC LIMIT 50`,
  },
  {
    name: 'facet: timeline buckets (year, month)',
    replaces: '$group by { exif.captured_year, exif.captured_month } — buckets.ts',
    sql: `SELECT captured_year, captured_month, COUNT(*) AS n FROM assets WHERE ${VISIBLE}
           GROUP BY captured_year, captured_month ORDER BY captured_year DESC, captured_month DESC`,
  },
  {
    name: 'count live assets via EXISTS (no roll-up column)',
    replaces: 'the same count with liveness as a per-row sub-select',
    sql: `SELECT COUNT(*) AS n FROM assets a WHERE a.deleted_at IS NULL
           AND EXISTS (SELECT 1 FROM asset_locations l WHERE l.asset_id = a.id
                        AND l.deleted_at IS NULL AND l.missing_since IS NULL)`,
  },
  {
    name: 'grid page: library + newest first, 200 rows',
    replaces: 'find(library scope).sort({ captured_at: -1, _id: 1 }).limit(200)',
    // Written as a semi-join rather than an inner join on purpose. An inner
    // join lets the planner lead with asset_locations, scan a whole library
    // and sort 300,000 rows to find 200; EXISTS keeps assets as the outer
    // loop, so the ordered partial index terminates at the limit. The pair
    // below measures the difference; 'bench-1' is a library holding about a
    // fifth of the assets, so the scope has something to discriminate.
    sql: `SELECT a.id, a.mtime, a.rating, a.has_xmp, a.hidden,
                 (SELECT path FROM asset_locations
                   WHERE asset_id = a.id AND ordinal = 0) AS path,
                 (SELECT filename FROM asset_locations
                   WHERE asset_id = a.id AND ordinal = 0) AS filename
            FROM assets a
           WHERE ${visible('a')}
             AND EXISTS (SELECT 1 FROM asset_locations l
                          WHERE l.asset_id = a.id AND l.ordinal = 0
                            AND l.library_id = ${SCOPED_LIBRARY})
           ORDER BY a.captured_at DESC, a.id LIMIT 200`,
  },
  {
    name: 'grid page as an inner join (the shape to avoid)',
    replaces: 'the same page with the library scope joined instead of EXISTS',
    sql: `SELECT a.id, a.mtime, a.rating, a.has_xmp, a.hidden, l.path, l.filename
            FROM assets a
            JOIN asset_locations l ON l.asset_id = a.id AND l.ordinal = 0
           WHERE ${visible('a')} AND l.library_id = ${SCOPED_LIBRARY}
           ORDER BY a.captured_at DESC, a.id LIMIT 200`,
  },
  {
    name: 'facet: vision scene type',
    replaces: "$match(live) + $group by '$vision.scene_type' — facets.ts",
    // The route excludes null AND the empty string, which is what lets the
    // partial index serve it at all — a bare GROUP BY implies neither and
    // plans as a full scan of the largest table in the database.
    sql: `SELECT d.vision_scene_type, COUNT(*) AS n
            FROM asset_detail d JOIN assets a ON a.id = d.asset_id
           WHERE d.vision_scene_type IS NOT NULL AND d.vision_scene_type <> ''
             AND ${visible('a')}
           GROUP BY d.vision_scene_type ORDER BY n DESC LIMIT 20`,
  },
  {
    name: 'facet: vision scene type, without the liveness join',
    replaces: 'the same facet over the whole table — what the index alone costs',
    // The pair is here because the difference between them is the finding:
    // grouping the index is nearly free, and joining assets for liveness is
    // what the facet actually pays. See docs/sqlite-schema.md.
    sql: `SELECT vision_scene_type, COUNT(*) AS n FROM asset_detail
           WHERE vision_scene_type IS NOT NULL AND vision_scene_type <> ''
           GROUP BY vision_scene_type ORDER BY n DESC LIMIT 20`,
  },
  {
    name: 'duplicate candidates: 2+ live locations',
    replaces: 'fileinfo.1 partial index + $expr/$filter live count',
    sql: `SELECT COUNT(*) AS n FROM (
            SELECT asset_id FROM asset_locations
             WHERE deleted_at IS NULL AND missing_since IS NULL
             GROUP BY asset_id HAVING COUNT(*) >= 2)`,
  },
  {
    name: 'backup sidecar lookup by (device, phasset local id)',
    replaces: 'the unindexed dotted-path lookup: 3-6 s over 288k documents',
    sql: `SELECT asset_id FROM asset_phasset_links
           WHERE device_id = 'device-1' AND phasset_local_id = 'no-such-id'`,
  },
  {
    name: 'stage claim: 500 below target, not dead',
    replaces: 'stage_<name>_version index + dead/backoff residuals',
    sql: `SELECT asset_id FROM stage_state
           WHERE stage = 'describe' AND version < 4 AND dead = 0
             AND (next_attempt_at IS NULL OR next_attempt_at <= '9999')
           LIMIT 500`,
  },
  {
    name: 'full-text search: selective term, top 50 by bm25',
    replaces: '$text over the search_blob text index',
    sql: `SELECT s.asset_id FROM assets_fts f
            JOIN asset_search s ON s.rowid = f.rowid
           WHERE assets_fts MATCH 'zephyrhold'
           ORDER BY bm25(assets_fts) LIMIT 50`,
  },
  {
    name: 'full-text search: broad term matching most rows',
    replaces: 'the worst case for $text — a term in nearly every document',
    sql: `SELECT s.asset_id FROM assets_fts f
            JOIN asset_search s ON s.rowid = f.rowid
           WHERE assets_fts MATCH 'lighthouse'
           ORDER BY bm25(assets_fts) LIMIT 50`,
  },
];

interface SizeRow {
  name: string;
  bytes: number;
  kind: 'table' | 'index' | 'other';
}

function measureSizes(db: Database): SizeRow[] {
  const objects = db
    .query(`SELECT type, name, tbl_name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'`)
    .all() as Array<{ type: string; name: string; tbl_name: string }>;
  const kindOf = new Map(objects.map((o) => [o.name, o.type] as const));

  // dbstat(main, 1) aggregates per b-tree instead of per page, which is orders
  // of magnitude faster on a multi-gigabyte file.
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS temp.dbstat_agg USING dbstat(main, 1)`);
  const rows = db
    .query(`SELECT name, SUM(pgsize) AS bytes FROM temp.dbstat_agg GROUP BY name`)
    .all() as Array<{ name: string; bytes: number }>;

  return rows
    .map((row) => ({
      name: row.name,
      bytes: row.bytes,
      kind: (kindOf.get(row.name) === 'index'
        ? 'index'
        : kindOf.get(row.name) === 'table'
          ? 'table'
          : 'other') as SizeRow['kind'],
    }))
    .sort((a, b) => b.bytes - a.bytes);
}

function timeQuery(db: Database, sql: string, runs: number): { median: number; rows: number } {
  const statement = db.query(sql);
  const samples: number[] = [];
  let rows = 0;
  for (let i = 0; i < runs; i += 1) {
    const startedAt = performance.now();
    rows = statement.all().length;
    samples.push(performance.now() - startedAt);
  }
  samples.sort((a, b) => a - b);
  return { median: samples[Math.floor(samples.length / 2)], rows };
}

function mb(bytes: number): string {
  return (bytes / 1_048_576).toFixed(1);
}

interface SizeReport {
  name: string;
  bytes: number;
  kind: SizeRow['kind'];
}

interface TimingReport {
  name: string;
  replaces: string;
  coldMs: number;
  warmMs: number;
  rows: number;
  plan: string;
}

interface RunReport {
  assetCount: number;
  rowCounts: Record<string, number>;
  generateMs: number;
  fileBytes: number;
  sizes: SizeReport[];
  timings: TimingReport[];
}

/**
 * What the bulk load deferred: the derived location counts, the FTS5 index,
 * and the planner statistics. The importer (#3744) does the same three things.
 */
function finishBulkLoad(db: Database): void {
  db.exec(LIVE_LOCATION_COUNT_RECOMPUTE_SQL);
  db.exec(ASSETS_FTS_REBUILD_SQL);
  db.exec(ASSETS_FTS_OPTIMIZE_SQL);
  db.exec('ANALYZE');
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
}

function fileBytesOf(db: Database): number {
  const pages = db.query('PRAGMA page_count').get() as { page_count: number };
  const pageSize = db.query('PRAGMA page_size').get() as { page_size: number };
  return pages.page_count * pageSize.page_size;
}

function openReader(dbPath: string): Database {
  const db = new Database(dbPath, { readonly: true });
  for (const pragma of SCHEMA_PRAGMAS) {
    if (!pragma.includes('journal_mode')) db.exec(pragma);
  }
  return db;
}

/**
 * Times every measurement on its OWN freshly opened read-only connection.
 *
 * One connection for the whole list would only give the first query of the
 * list a cold cache; every one after it would inherit the pages its
 * predecessors pulled in, so twelve of the thirteen numbers would be warm
 * while the report called them cold. `coldMs` is the first run on a connection
 * that has read nothing, and `warmMs` the median of five after it.
 *
 * SQLite's page cache is what this empties; the operating system's file cache
 * is not, and cannot be from inside the process. So `coldMs` is "a query this
 * server has not run before", not "a query against a disk that has not been
 * touched" — the honest ceiling is somewhere above it.
 */
function runMeasurements(dbPath: string): TimingReport[] {
  return MEASUREMENTS.map((measurement) => {
    const db = openReader(dbPath);
    const first = timeQuery(db, measurement.sql, 1);
    const warm = timeQuery(db, measurement.sql, 5);
    const plan = (
      db.query(`EXPLAIN QUERY PLAN ${measurement.sql}`).all() as Array<{ detail: string }>
    )
      .map((row) => row.detail)
      .join(' | ');
    db.close();
    return {
      name: measurement.name,
      replaces: measurement.replaces,
      coldMs: Number(first.median.toFixed(2)),
      warmMs: Number(warm.median.toFixed(2)),
      rows: warm.rows,
      plan,
    };
  });
}

async function benchmark(assetCount: number, dbPath: string): Promise<RunReport> {
  const db = new Database(dbPath, { create: true });
  for (const pragma of SCHEMA_PRAGMAS) db.exec(pragma);
  await runMigrations(fromBunSqlite(db), ALL_MIGRATIONS);

  const generated = generateLibrary(db, { assetCount });
  finishBulkLoad(db);
  const sizes = measureSizes(db);
  const fileBytes = fileBytesOf(db);
  db.close();

  return {
    assetCount,
    rowCounts: generated.rowCounts,
    generateMs: generated.elapsedMs,
    fileBytes,
    sizes,
    timings: runMeasurements(dbPath),
  };
}

function printReport(report: RunReport): void {
  const perAsset = report.fileBytes / report.assetCount;
  console.log(`\n## ${report.assetCount.toLocaleString()} assets`);
  console.log(
    `\nDatabase file: ${mb(report.fileBytes)} MB (${Math.round(perAsset)} bytes per asset). ` +
      `Generated in ${(report.generateMs / 1000).toFixed(1)} s.`,
  );
  console.log(
    `Rows: ${Object.entries(report.rowCounts)
      .map(([k, v]) => `${k} ${v.toLocaleString()}`)
      .join(', ')}`,
  );

  console.log('\n| object | kind | MB |');
  console.log('| --- | --- | --- |');
  for (const size of report.sizes.slice(0, 18)) {
    console.log(`| \`${size.name}\` | ${size.kind} | ${mb(size.bytes)} |`);
  }

  console.log('\n| query | cold ms | warm ms | rows |');
  console.log('| --- | --- | --- | --- |');
  for (const timing of report.timings) {
    console.log(`| ${timing.name} | ${timing.coldMs} | ${timing.warmMs} | ${timing.rows} |`);
  }
}

const args = Bun.argv.slice(2);
const keep = args.includes('--keep');
const sizes = args
  .filter((a) => !a.startsWith('--'))
  .map(Number)
  .filter((n) => Number.isFinite(n) && n > 0);
const targets = sizes.length > 0 ? sizes : DEFAULT_SIZES;
const outDir = process.env.SQLITE_BENCH_DIR ?? '/tmp/maple-sqlite-bench';
// `new Database(path, { create: true })` creates the file and nothing above it,
// so the directory has to exist first or the open fails with SQLITE_CANTOPEN on
// a machine that has never run this. Bun.write creates the parents it needs,
// which is mkdir -p without the restricted node:fs import.
await Bun.write(`${outDir}/.keep`, '');

// Create the output directory before anything opens a database inside it.
// SQLite's `create: true` creates the database FILE, not its parent, so
// without this the first run on a machine that has never run the benchmark
// dies with SQLITE_CANTOPEN instead of producing numbers. Writing a file is
// how a directory gets created recursively without importing node:fs, which
// the API's lint config restricts.
await Bun.write(`${outDir}/.keep`, '');

// Same reason as in `bench-db.ts`: `create: true` creates the file, not the
// directory above it, so a machine that has never run this dies with
// SQLITE_CANTOPEN before it reaches the report write that would have made it.
await ensureBenchDir();

const reports: RunReport[] = [];
for (const assetCount of targets) {
  const dbPath = `${outDir}/bench-${assetCount}.db`;
  // Bun.file().delete() removes a previous run without importing node:fs,
  // which the API's lint config restricts.
  for (const suffix of ['', '-wal', '-shm']) {
    await Bun.file(`${dbPath}${suffix}`)
      .delete()
      .catch(() => {});
  }
  const report = await benchmark(assetCount, dbPath);
  reports.push(report);
  printReport(report);
  if (!keep) {
    for (const suffix of ['', '-wal', '-shm']) {
      await Bun.file(`${dbPath}${suffix}`)
        .delete()
        .catch(() => {});
    }
  }
}

await Bun.write(`${outDir}/report.json`, JSON.stringify(reports, null, 2));
console.log(`\nJSON report: ${outDir}/report.json`);
