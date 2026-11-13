/**
 * What RAW+JPEG stacking costs a large library — the measurement behind #5849.
 *
 *   bun scripts/sqlite-bench/raw-jpeg-stacks.ts            # 1,000,000 assets
 *   bun scripts/sqlite-bench/raw-jpeg-stacks.ts 335377     # one smaller size
 *   bun scripts/sqlite-bench/raw-jpeg-stacks.ts --keep     # leave the .db behind
 *
 * Builds the generated library on the schema before 0044, renames 30% of its
 * assets into same-folder `.CR3`/`.JPG` pairs, and times the count, the
 * timeline histogram and a grid page. Then applies 0044, timing the index
 * rebuild and the backfill, and times the same statements unfolded and folded,
 * printing every plan. Medians of wall time and the migration's process CPU
 * time; the folded count must equal the unfolded count minus the pairs.
 */

import { runMigrations, fromBunSqlite } from '../../src/db/sqlite/migrate.ts';
import { ALL_MIGRATIONS } from '../../src/db/sqlite/migrations/index.ts';
import { buildSearchWhere, type SearchWhere } from '../../src/db/repos/search.where.ts';
import { countSql, pageSql, timedBucketsSql } from '../../src/db/repos/search.sql.ts';
import {
  benchDbPath,
  buildLibrary,
  queryPlanLines,
  removeDatabase,
  sizeArgument,
  timeStatement,
} from './bench-db.ts';
import type { Database } from 'bun:sqlite';

const RUNS = 7;
const STACKS_MIGRATION = '0044-raw-jpeg-stacks';

function where(stackRawJpeg: boolean): SearchWhere {
  const built = buildSearchWhere({}, [], null, { stackRawJpeg });
  if ('error' in built) throw new Error(built.error);
  return built;
}

/** Pairs rows 2k and 2k+1 for 30% of k: one folder, one stem, a RAW and a JPEG. */
function makePairs(db: Database): number {
  db.exec(`CREATE TEMP TABLE pair AS
    SELECT l.id AS id, l.id / 2 AS k, l.id % 2 AS jpeg FROM asset_locations l
     WHERE l.ordinal = 0 AND (l.id / 2) % 10 < 3`);
  db.exec(`UPDATE asset_locations
     SET path = (SELECT o.path FROM asset_locations o WHERE o.id = asset_locations.id - 1)
   WHERE id IN (SELECT id FROM pair WHERE jpeg = 1)
     AND EXISTS (SELECT 1 FROM pair p WHERE p.id = asset_locations.id - 1)`);
  db.exec(`UPDATE asset_locations
     SET filename = 'PAIR_' || (id / 2) || CASE id % 2 WHEN 0 THEN '.CR3' ELSE '.JPG' END
   WHERE id IN (SELECT id FROM pair)`);
  return (db.query('SELECT COUNT(*) AS n FROM pair WHERE jpeg = 1').get() as { n: number }).n;
}

function report(db: Database, label: string, w: SearchWhere): Record<string, number> {
  const statements = {
    count: countSql(w),
    histogram: timedBucketsSql(w),
    page: pageSql(w, 'captured_desc', 200, 0),
  };
  const out: Record<string, number> = {};
  for (const [name, statement] of Object.entries(statements)) {
    const timed = timeStatement(db, statement.sql, statement.params, RUNS);
    console.log(`${label} ${name}: ${timed.ms.toFixed(2)} ms`);
    console.log(`  ${queryPlanLines(db, statement.sql, statement.params).join('\n  ')}`);
    out[name] =
      name === 'count'
        ? (db.query(statement.sql).get(...(statement.params as never[])) as { n: number }).n
        : timed.ms;
  }
  return out;
}

const args = process.argv.slice(2);
const count = sizeArgument(args, 1_000_000);
const path = benchDbPath('raw-jpeg-stacks');
const db = await buildLibrary(
  path,
  count,
  ALL_MIGRATIONS.filter((migration) => migration.id < STACKS_MIGRATION),
);
const pairs = makePairs(db);
db.exec('ANALYZE');
console.log(`${count} assets, ${pairs} RAW+JPEG pairs`);

const before = report(db, 'before 0044', where(false));

const cpuBefore = process.cpuUsage();
const migrated = await runMigrations(fromBunSqlite(db), ALL_MIGRATIONS);
const cpu = process.cpuUsage(cpuBefore);
console.log(
  `0044 migration: ${migrated.durations[STACKS_MIGRATION]} ms wall, ${((cpu.user + cpu.system) / 1000).toFixed(0)} ms CPU`,
);
db.exec('ANALYZE');

const unfolded = report(db, 'after 0044, unfolded', where(false));
const folded = report(db, 'after 0044, folded', where(true));
const stacked = (
  db
    .query(
      `SELECT COUNT(*) AS n FROM assets
        WHERE deleted_at IS NULL AND live_location_count > 0 AND hidden = 0
          AND stack_primary_id IS NOT NULL`,
    )
    .get() as { n: number }
).n;
console.log(`${stacked} visible JPEGs folded`);
db.close();
if (!args.includes('--keep')) await removeDatabase(path);
if (unfolded.count !== before.count || folded.count !== before.count - stacked) {
  console.error(
    `MISMATCH: before ${before.count}, unfolded ${unfolded.count}, folded ${folded.count}, stacked ${stacked}`,
  );
  process.exitCode = 1;
}
