/**
 * Building and timing a generated SQLite library — the parts every benchmark in
 * this directory needs and none of them should own.
 *
 * `run.ts` and `list-items-compare.ts` each grew their own copy of this before
 * there was a third and a fourth script; the copies are what this module exists
 * to stop multiplying. Nothing here touches production: every database it opens
 * is a scratch file under `SQLITE_BENCH_DIR`, and every generator is seeded, so
 * a re-run reproduces the same library.
 */

import { Database } from 'bun:sqlite';
import { LIVE_LOCATION_COUNT_RECOMPUTE_SQL } from '../../src/db/sqlite/ddl/asset-locations.ts';
import { FACET_STATE_RECOMPUTE_SQL } from '../../src/db/sqlite/ddl/facet-state.ts';
import { SCHEMA_PRAGMAS } from '../../src/db/sqlite/ddl/index.ts';
import { ASSETS_FTS_OPTIMIZE_SQL, ASSETS_FTS_REBUILD_SQL } from '../../src/db/sqlite/ddl/search.ts';
import { fromBunSqlite, runMigrations } from '../../src/db/sqlite/migrate.ts';
import { ALL_MIGRATIONS } from '../../src/db/sqlite/migrations/index.ts';
import { generateLibrary } from './generate.ts';

export const BENCH_DIR = process.env.SQLITE_BENCH_DIR ?? '/tmp/maple-sqlite-bench';

/** WAL leaves two sidecars beside the database; all three go together. */
const DB_SUFFIXES = ['', '-wal', '-shm'];

/** The scratch path for one benchmark's database. */
export function benchDbPath(name: string): string {
  return `${BENCH_DIR}/${name}.db`;
}

/**
 * Removes a database and its WAL sidecars.
 *
 * `Bun.file().delete()` rather than `node:fs` because the API's lint config
 * restricts raw filesystem imports.
 */
export async function removeDatabase(path: string): Promise<void> {
  for (const suffix of DB_SUFFIXES) {
    await Bun.file(`${path}${suffix}`)
      .delete()
      .catch(() => {});
  }
}

/**
 * Makes sure the scratch directory exists before SQLite is asked to create a
 * file in it.
 *
 * `bun:sqlite`'s `create: true` creates the *file*, not the directory above
 * it, so on a machine that has never run one of these benchmarks the first one
 * dies with `SQLITE_CANTOPEN` — which is every reviewer following the commands
 * in the PR body. `Bun.write` creates the parent directories on the way,
 * which is why this is a written marker file rather than a `mkdir`: the API's
 * lint config restricts raw filesystem imports, and `removeDatabase` above
 * avoids them for the same reason.
 */
export async function ensureBenchDir(): Promise<void> {
  await Bun.write(`${BENCH_DIR}/.keep`, '');
}

/**
 * What the bulk load deferred: the derived location counts, the mirrored facet
 * state, the FTS5 index and the planner statistics. The importer (#3744) does
 * the same four things, in this order — every satellite's `asset_live` is
 * derived from the counts the first statement rebuilds.
 */
function finishBulkLoad(db: Database): void {
  db.exec(LIVE_LOCATION_COUNT_RECOMPUTE_SQL);
  db.exec(FACET_STATE_RECOMPUTE_SQL);
  db.exec(ASSETS_FTS_REBUILD_SQL);
  db.exec(ASSETS_FTS_OPTIMIZE_SQL);
  db.exec('ANALYZE');
}

/**
 * A fresh scratch database with the pragmas and the full schema applied.
 *
 * Empty: the schema and nothing in it. {@link buildLibrary} is this plus a
 * generated library, and the comparison scripts that bring their own fixtures
 * want the empty one.
 */
export async function openBenchDatabase(path: string): Promise<Database> {
  await ensureBenchDir();
  await removeDatabase(path);
  const db = new Database(path, { create: true });
  for (const pragma of SCHEMA_PRAGMAS) db.exec(pragma);
  await runMigrations(fromBunSqlite(db), ALL_MIGRATIONS);
  return db;
}

/** A fresh database at `path`, migrated and filled with `assetCount` assets. */
export async function buildLibrary(path: string, assetCount: number): Promise<Database> {
  const db = await openBenchDatabase(path);
  generateLibrary(db, { assetCount });
  finishBulkLoad(db);
  return db;
}

/**
 * Closes a database and re-opens it read-only, so timings start with an empty
 * SQLite page cache rather than the one the write left warm.
 */
export function reopenReadOnly(db: Database, path: string): Database {
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.close();
  const reopened = new Database(path, { readonly: true });
  for (const pragma of SCHEMA_PRAGMAS) {
    if (!pragma.includes('journal_mode')) reopened.exec(pragma);
  }
  return reopened;
}

export function median(samples: readonly number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

/**
 * One `EXPLAIN QUERY PLAN` line per step, unjoined.
 *
 * Every script here asserts something about a plan and each had grown its own
 * copy of this; they differ only in how they lay the lines out, so the join is
 * the caller's and the query is not.
 */
export function queryPlanLines(
  db: Database,
  sql: string,
  params: readonly unknown[] = [],
): string[] {
  const rows = db.query(`EXPLAIN QUERY PLAN ${sql}`).all(...(params as never[])) as Array<{
    detail: string;
  }>;
  return rows.map((row) => row.detail);
}

/** The first positional argument as a row count, or `fallback`. */
export function sizeArgument(args: readonly string[], fallback: number): number {
  const sizes = args
    .filter((arg) => !arg.startsWith('--'))
    .map(Number)
    .filter((n) => Number.isFinite(n) && n > 0);
  return sizes[0] ?? fallback;
}

/** Median wall time of `runs` executions of one statement, plus its row count. */
export function timeStatement(
  db: Database,
  sql: string,
  params: readonly unknown[],
  runs: number,
): { ms: number; rows: number } {
  const statement = db.query(sql);
  statement.all(...(params as never[]));
  const samples: number[] = [];
  let rows = 0;
  for (let i = 0; i < runs; i += 1) {
    const startedAt = performance.now();
    rows = statement.all(...(params as never[])).length;
    samples.push(performance.now() - startedAt);
  }
  return { ms: median(samples), rows };
}

/** Median wall time of `runs` awaited calls, after one untimed warm-up. */
export async function timeAsync<T>(
  fn: () => Promise<T>,
  runs: number,
): Promise<{ ms: number; value: T }> {
  let value = await fn();
  const samples: number[] = [];
  for (let i = 0; i < runs; i += 1) {
    const startedAt = performance.now();
    value = await fn();
    samples.push(performance.now() - startedAt);
  }
  return { ms: median(samples), value };
}
