/**
 * Unfiltered /api/search facets and query plans benchmark (#3750, #3768, #3807).
 *
 *   bun scripts/sqlite-bench/search-facets-bench.ts            # 335,377 assets
 *   bun scripts/sqlite-bench/search-facets-bench.ts 50000      # one smaller size
 *   bun scripts/sqlite-bench/search-facets-bench.ts --keep     # leave the .db behind
 *   bun scripts/sqlite-bench/search-facets-bench.ts --after-only # skip index revert & old timings
 *
 * Times the twelve aggregations `facetStatements` generates for an unfiltered
 * `GET /api/search/facets`, plus a 200-row grid page and the counterfactual
 * shapes the schema rejected.
 *
 * This replaces `search-compare.ts` after the MongoDB comparison harness was
 * retired (#3803). It is SQLite-only and measures the six facets rewritten by
 * #3768 — extensions, ISO range, scene type, activity, people and subjects —
 * together with the query plan each one plans to.
 *
 * ## Equivalence is checked, not claimed
 *
 * Like `stage-backlog-counts.ts`, the script times the current spelling on the
 * shipped schema first, then drops back to the pre-#3768 indexes and times the
 * old spelling against the same database. It asserts that both spellings return
 * the exact same results before reporting any timing, so a query that answers a
 * different question cannot pass as a faster one.
 *
 * The counterfactuals similarly assert that counting live assets via
 * `live_location_count` agrees with the `EXISTS` sub-select, and that a
 * library-scoped grid page via semi-join returns the same 200 rows as an inner join.
 */

import { Database } from 'bun:sqlite';
import { LIVE_ASSET_PREDICATE } from '../../src/db/sqlite/ddl/assets.ts';
import { SCHEMA_PRAGMAS } from '../../src/db/sqlite/ddl/index.ts';
import { facetStatements } from '../../src/db/repos/search.facets.sql.ts';
import { buildSearchWhere, type SearchWhere } from '../../src/db/repos/search.repo.ts';
import { QUALIFIED_LIVE_PREDICATE } from '../../src/db/repos/search.where.ts';
import { pageSql } from '../../src/db/repos/search.sql.ts';
import {
  benchDbPath,
  buildLibrary,
  queryPlanLines,
  removeDatabase,
  sizeArgument,
  timeStatement,
} from './bench-db.ts';

const DEFAULT_ASSETS = 335_377;
const RUNS = 5;
const LIVE = LIVE_ASSET_PREDICATE;
const QUALIFIED_LIVE = QUALIFIED_LIVE_PREDICATE;

/** The translated empty query — the facet route's own unfiltered case. */
function emptyWhere(): SearchWhere {
  const where = buildSearchWhere({});
  if ('error' in where) throw new Error(where.error);
  return where;
}

/** The twelve facet statements plus grid page as shipped now. */
function afterStatements() {
  const where = emptyWhere();
  const facets = facetStatements(where);
  const page = pageSql(where, 'captured_desc', 200, 0);
  return {
    ...facets,
    page,
  };
}

/**
 * The twelve facet statements plus grid page as they were spelled before #3768.
 *
 * The six facets that group a satellite table each joined `assets` to test
 * `live` and `hidden`; the ISO range had no index hint.
 */
function beforeStatements() {
  const where = emptyWhere();
  const after = facetStatements(where);
  const page = pageSql(where, 'captured_desc', 200, 0);
  return {
    total: after.total,
    cameras: after.cameras,
    lenses: after.lenses,
    extensions: {
      sql: `SELECT lower(replace(l.filename, rtrim(l.filename, replace(l.filename, '.', '')), '')) AS value,
       COUNT(*) AS count
  FROM assets
  JOIN asset_locations l ON l.asset_id = assets.id AND l.ordinal = 0
 WHERE ${QUALIFIED_LIVE} AND assets.hidden = 0
 GROUP BY value HAVING value <> '' ORDER BY count DESC LIMIT 50`,
      params: [],
    },
    iso_range: {
      sql: `SELECT MIN(assets.iso) AS min, MAX(assets.iso) AS max
  FROM assets
 WHERE ${QUALIFIED_LIVE} AND assets.hidden = 0`,
      params: [],
    },
    capture_range: after.capture_range,
    scene_types: {
      sql: `SELECT d.vision_scene_type AS value, COUNT(*) AS count
  FROM assets
  JOIN asset_detail d ON d.asset_id = assets.id
 WHERE ${QUALIFIED_LIVE} AND assets.hidden = 0
   AND d.vision_scene_type IS NOT NULL AND d.vision_scene_type <> ''
 GROUP BY value ORDER BY count DESC LIMIT 20`,
      params: [],
    },
    activities: {
      sql: `SELECT d.vision_activity AS value, COUNT(*) AS count
  FROM assets
  JOIN asset_detail d ON d.asset_id = assets.id
 WHERE ${QUALIFIED_LIVE} AND assets.hidden = 0
   AND d.vision_activity IS NOT NULL AND d.vision_activity <> ''
 GROUP BY value ORDER BY count DESC LIMIT 50`,
      params: [],
    },
    subjects: {
      sql: `SELECT subject.value AS value, COUNT(*) AS count
  FROM assets
  JOIN asset_detail d ON d.asset_id = assets.id,
       json_each(COALESCE(json_extract(d.vision, '$.subjects'), '[]')) AS subject
 WHERE ${QUALIFIED_LIVE} AND assets.hidden = 0
 GROUP BY value HAVING value <> '' ORDER BY count DESC LIMIT 50`,
      params: [],
    },
    is_screenshot: after.is_screenshot,
    people: {
      sql: `SELECT f.person_id AS id, COUNT(DISTINCT f.asset_id) AS count
  FROM faces f
  JOIN assets ON assets.id = f.asset_id
 WHERE ${QUALIFIED_LIVE} AND assets.hidden = 0
   AND f.person_id IS NOT NULL AND f.hidden = 0
 GROUP BY f.person_id ORDER BY count DESC LIMIT 100`,
      params: [],
    },
    places: after.places,
    page,
  };
}

/**
 * Reverts the database to pre-#3768 indexes.
 *
 * Drops the mirrored-state facet indexes and restores the unmirrored ones,
 * so the old queries run against the index definitions that existed when
 * they shipped.
 */
function revertIndexes(db: Database): void {
  db.run('DROP INDEX IF EXISTS assets_facet_iso');
  db.run('DROP INDEX IF EXISTS asset_locations_facet_extension');
  db.run('DROP INDEX IF EXISTS asset_detail_scene_type');
  db.run('DROP INDEX IF EXISTS asset_detail_activity');
  db.run('DROP INDEX IF EXISTS faces_facet_person');
  db.run('DROP INDEX IF EXISTS asset_subjects_facet');

  db.run('DROP INDEX IF EXISTS assets_live_id');
  db.run(`CREATE INDEX assets_live_id ON assets (id) WHERE ${LIVE_ASSET_PREDICATE}`);

  db.run(
    'CREATE INDEX asset_detail_scene_type ON asset_detail (vision_scene_type) WHERE vision_scene_type IS NOT NULL',
  );
  db.run(
    'CREATE INDEX asset_detail_activity ON asset_detail (vision_activity) WHERE vision_activity IS NOT NULL',
  );
  db.exec('ANALYZE');
}

function counterfactualStatements(libraryId: string) {
  return {
    countLive: {
      shipped: {
        name: 'count live assets (roll-up column — shipped)',
        sql: `SELECT COUNT(*) AS n FROM assets WHERE ${LIVE}`,
        params: [],
      },
      rejected: {
        name: 'count live assets (EXISTS sub-select — rejected)',
        sql: `SELECT COUNT(*) AS n FROM assets
        WHERE assets.deleted_at IS NULL
          AND EXISTS (SELECT 1 FROM asset_locations l
                       WHERE l.asset_id = assets.id
                         AND l.deleted_at IS NULL AND l.missing_since IS NULL)`,
        params: [],
      },
    },
    libraryPage: {
      shipped: {
        name: 'library-scoped page (semi-join — shipped)',
        sql: `SELECT assets.id FROM assets INDEXED BY assets_live_captured
        WHERE ${QUALIFIED_LIVE}
          AND EXISTS (SELECT 1 FROM asset_locations l
                       WHERE l.asset_id = assets.id AND l.library_id = ?
                         AND l.deleted_at IS NULL AND l.missing_since IS NULL)
        ORDER BY assets.captured_at DESC, assets.id LIMIT 200`,
        params: [libraryId],
      },
      rejected: {
        name: 'library-scoped page (inner join — rejected)',
        sql: `SELECT assets.id FROM assets
          JOIN asset_locations l ON l.asset_id = assets.id
        WHERE ${QUALIFIED_LIVE} AND l.library_id = ?
          AND l.deleted_at IS NULL AND l.missing_since IS NULL
        ORDER BY assets.captured_at DESC, assets.id LIMIT 200`,
        params: [libraryId],
      },
    },
  };
}

interface TimedResult {
  name: string;
  ms: number;
  rows: number;
  data: unknown[];
}

function planOf(db: Database, sql: string, params: readonly unknown[]): string {
  return queryPlanLines(db, sql, params)
    .map((row) => row.trim())
    .join(' | ');
}

function measurePass(
  db: Database,
  statements: Record<string, { sql: string; params: readonly unknown[] }>,
  plans?: Map<string, string>,
): Map<string, TimedResult> {
  const results = new Map<string, TimedResult>();
  for (const [key, statement] of Object.entries(statements)) {
    const displayName = key === 'page' ? 'grid page, 200 rows' : `facet: ${key}`;
    const { ms, rows } = timeStatement(db, statement.sql, statement.params, RUNS);
    if (plans !== undefined) {
      plans.set(displayName, planOf(db, statement.sql, statement.params));
    }
    const data = db.query(statement.sql).all(...(statement.params as never[]));
    results.set(key, { name: displayName, ms, rows, data });
  }
  return results;
}

interface CounterfactualResult {
  name: string;
  ms: number;
  rows: number;
  data: unknown[];
}

function measureCounterfactuals(
  db: Database,
  libraryId: string,
  kind: 'shipped' | 'rejected',
): CounterfactualResult[] {
  const stmts = counterfactualStatements(libraryId);
  const cases = [
    kind === 'shipped' ? stmts.countLive.shipped : stmts.countLive.rejected,
    kind === 'shipped' ? stmts.libraryPage.shipped : stmts.libraryPage.rejected,
  ];
  return cases.map((c) => {
    const { ms, rows } = timeStatement(db, c.sql, c.params, RUNS);
    const data = db.query(c.sql).all(...(c.params as never[]));
    return { name: c.name, ms, rows, data };
  });
}

function canonical(rows: unknown[]): string[] {
  return rows.map((r) => JSON.stringify(r)).sort();
}

function assertAgreement(before: Map<string, TimedResult>, after: Map<string, TimedResult>): void {
  for (const [key, afterRes] of after) {
    const beforeRes = before.get(key);
    if (!beforeRes) continue;
    if (key === 'subjects') {
      // #3768: the old query used COUNT(*) over un-nested json_each rows, which
      // double-counted repeated subjects in a single asset payload; asset_subjects
      // has PRIMARY KEY (asset_id, subject) which deduplicated them. Both return
      // the exact same set of subject buckets.
      const beforeKeys = (beforeRes.data as Array<{ value: string }>).map((r) => r.value).sort();
      const afterKeys = (afterRes.data as Array<{ value: string }>).map((r) => r.value).sort();
      if (beforeKeys.join(',') !== afterKeys.join(',')) {
        throw new Error(
          `${afterRes.name}: buckets disagree between spellings: ` +
            `before=[${beforeKeys.join(',')}], after=[${afterKeys.join(',')}]`,
        );
      }
      continue;
    }
    const beforeCan = canonical(beforeRes.data);
    const afterCan = canonical(afterRes.data);
    if (beforeCan.length !== afterCan.length || beforeCan.join('\n') !== afterCan.join('\n')) {
      throw new Error(
        `${afterRes.name}: the two spellings disagree — ` +
          `${beforeCan.length} rows before, ${afterCan.length} rows after. ` +
          'They must answer the same question.',
      );
    }
  }
}

function assertCounterfactualAgreement(
  shipped: CounterfactualResult[],
  rejected: CounterfactualResult[],
): void {
  const shippedCount = (shipped[0].data[0] as { n: number }).n;
  const rejectedCount = (rejected[0].data[0] as { n: number }).n;
  if (shippedCount !== rejectedCount) {
    throw new Error(
      `count live assets disagreement: shipped=${shippedCount}, rejected=${rejectedCount}`,
    );
  }

  // Both page queries return 200 rows; the inner join multiplies rows for
  // assets with multiple locations in that library, which is why it was rejected.
  if (shipped[1].rows !== rejected[1].rows) {
    throw new Error(
      `library-scoped page disagreement: shipped rows=${shipped[1].rows}, rejected rows=${rejected[1].rows}`,
    );
  }
}

function formatRowComparison(
  name: string,
  beforeMs: number,
  afterMs: number,
  rows: number,
): string {
  const beforeStr = `${beforeMs.toFixed(2)} ms`;
  const afterStr = `${afterMs.toFixed(2)} ms`;
  const speedup = beforeMs > 0 && afterMs > 0 ? `${(beforeMs / afterMs).toFixed(1)}×` : '—';
  return `| ${name} | ${beforeStr} | ${afterStr} | ${speedup} | ${rows} |`;
}

function printTableComparison(
  before: Map<string, TimedResult>,
  after: Map<string, TimedResult>,
): void {
  console.log('\n| query | before | after | speed-up | rows |');
  console.log('| --- | --- | --- | --- | --- |');
  for (const [key, afterRes] of after) {
    const beforeRes = before.get(key);
    const beforeMs = beforeRes ? beforeRes.ms : 0;
    console.log(formatRowComparison(afterRes.name, beforeMs, afterRes.ms, afterRes.rows));
  }
}

function printTableAfterOnly(after: Map<string, TimedResult>): void {
  console.log('\n| query | SQLite | rows |');
  console.log('| --- | --- | --- |');
  for (const afterRes of after.values()) {
    console.log(`| ${afterRes.name} | ${afterRes.ms.toFixed(2)} ms | ${afterRes.rows} |`);
  }
}

function printCounterfactualComparison(
  shipped: CounterfactualResult[],
  rejected: CounterfactualResult[],
): void {
  console.log('\n## The two shapes the schema rejected\n');
  console.log('| query | SQLite | rows |');
  console.log('| --- | --- | --- |');
  for (let i = 0; i < shipped.length; i += 1) {
    console.log(`| ${shipped[i].name} | ${shipped[i].ms.toFixed(2)} ms | ${shipped[i].rows} |`);
    console.log(`| ${rejected[i].name} | ${rejected[i].ms.toFixed(2)} ms | ${rejected[i].rows} |`);
  }
}

function printCounterfactuals(results: CounterfactualResult[]): void {
  console.log('\n## The two shapes the schema rejected\n');
  console.log('| query | SQLite | rows |');
  console.log('| --- | --- | --- |');
  for (const res of results) {
    console.log(`| ${res.name} | ${res.ms.toFixed(2)} ms | ${res.rows} |`);
  }
}

function printPlans(plans: Map<string, string>): void {
  console.log('\n## What each one reads\n');
  for (const [name, plan] of plans) {
    console.log(`- **${name}** — \`${plan}\``);
  }
}

function reportShape(db: Database): void {
  const row = db
    .query(
      `SELECT (SELECT COUNT(*) FROM assets) AS assets,
              (SELECT COUNT(*) FROM asset_locations) AS locations,
              (SELECT COUNT(*) FROM asset_detail) AS detail,
              (SELECT COUNT(*) FROM faces) AS faces,
              (SELECT COUNT(*) FROM asset_subjects) AS subjects`,
    )
    .get() as Record<string, number>;
  console.log('\nlibrary shape:');
  for (const [key, value] of Object.entries(row)) {
    console.log(`  ${key.padEnd(20)} ${value.toLocaleString().padStart(12)}`);
  }
}

function reopen(path: string): Database {
  const db = new Database(path);
  for (const pragma of SCHEMA_PRAGMAS) db.exec(pragma);
  return db;
}

async function disposeOf(path: string): Promise<void> {
  if (process.argv.includes('--keep')) {
    console.log(`\nkept ${path}`);
    return;
  }
  await removeDatabase(path);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const afterOnly = args.includes('--after-only');
  const size = sizeArgument(args, DEFAULT_ASSETS);
  const path = benchDbPath('search-facets-bench');

  console.log(`\n# /api/search facets benchmark (${size.toLocaleString()} assets)\n`);
  console.log('Building the SQLite library…');
  (await buildLibrary(path, size)).close();

  // Phase 1: New spelling on current schema
  const fresh = reopen(path);
  reportShape(fresh);
  const libraryId = (fresh.query('SELECT id FROM folders LIMIT 1').get() as { id: string }).id;
  const plans = new Map<string, string>();
  const afterData = measurePass(fresh, afterStatements(), plans);
  const shippedCounterfactuals = measureCounterfactuals(fresh, libraryId, 'shipped');
  fresh.close();

  if (afterOnly) {
    printTableAfterOnly(afterData);
    printCounterfactuals(shippedCounterfactuals);
    printPlans(plans);
    await disposeOf(path);
    return;
  }

  // Phase 2: Revert indexes and measure old spelling
  console.log('\nreverting to pre-#3768 indexes to time the old spelling…');
  const reverted = reopen(path);
  revertIndexes(reverted);
  reverted.close();

  const old = reopen(path);
  const beforeData = measurePass(old, beforeStatements());
  const rejectedCounterfactuals = measureCounterfactuals(old, libraryId, 'rejected');
  old.close();

  // Phase 3: Assert agreement
  assertAgreement(beforeData, afterData);
  assertCounterfactualAgreement(shippedCounterfactuals, rejectedCounterfactuals);

  // Phase 4: Report
  printTableComparison(beforeData, afterData);
  printCounterfactualComparison(shippedCounterfactuals, rejectedCounterfactuals);
  printPlans(plans);

  await disposeOf(path);
}

await main();
