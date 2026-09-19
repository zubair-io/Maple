/**
 * What one Workers-page refresh costs — the measurement behind #3804.
 *
 *   bun scripts/sqlite-bench/stage-backlog-counts.ts            # 335,377 assets
 *   bun scripts/sqlite-bench/stage-backlog-counts.ts 50000      # one smaller size
 *   bun scripts/sqlite-bench/stage-backlog-counts.ts --keep     # leave the .db behind
 *
 * `status-counts.ts` runs `countStageBacklog` for all twelve claim stages one
 * at a time, so what an operator waits on is the sum, not any single query.
 * That sum is what this reports, for the spelling the counts used before #3804
 * and the spelling they use now, against the same database — a reviewer should
 * be able to see the number the change moved rather than take a claim about it.
 *
 * The stages come from `stageManifest`, so the target versions, the `dependsOn`
 * edges and the two media residuals are the real ones rather than a guess at
 * them, and adding a stage puts it in this benchmark automatically.
 *
 * ## Equivalence is checked, not claimed
 *
 * The two spellings answer the same question by two different routes — one
 * probes `assets` per row, the other reads a trigger-maintained mirror of the
 * same three columns — so the script asserts they return the same number for
 * every stage before it reports a timing. A benchmark comparing a fast query
 * against a query that answers a different question is worse than no benchmark.
 *
 * The old spelling is also timed on the old indexes. Left on the new schema its
 * `dependsOn` probe picks up `stage_dep` and reports two thirds of what it
 * actually cost, so the script drops back to the pre-#3804 index definitions
 * between the two halves — see {@link revertIndexes}.
 *
 * ## Why the sum matters more than it looks
 *
 * `startStatusCountsRefresher` gives a pass that took T a rest of 3 × T,
 * clamped to `STAGE_COUNTS_MIN_INTERVAL_MS` (5 s) at the bottom. A pass slower
 * than about 1.67 s therefore throttles itself: it holds a reader continuously
 * for a quarter of the time AND refreshes the page more slowly than the page
 * asked for. Getting under that floor is the difference between the cadence
 * being real and being aspirational.
 */

import { Database } from 'bun:sqlite';
import { LIVE_ASSET_PREDICATE } from '../../src/db/sqlite/ddl/assets.ts';
import { SCHEMA_PRAGMAS } from '../../src/db/sqlite/ddl/index.ts';
import {
  stagePendingCountSql,
  stageReadyCountSql,
} from '../../src/db/sqlite/repos/stage-backlog.sql.ts';
import { resolveStageDeps } from '../../src/workers/stage-config.ts';
import { stageManifest } from '../../src/workers/stages/manifest.ts';
import {
  benchDbPath,
  buildLibrary,
  queryPlanLines,
  removeDatabase,
  sizeArgument,
  timeStatement,
} from './bench-db.ts';

const RUNS = 5;
const NOW = new Date().toISOString();

/**
 * The asset-level gate as the counts spelled it before #3804: the claim's own
 * `EXISTS`, kept here so the comparison is against what actually shipped.
 */
const ASSET_CLAIMABLE_EXISTS = `
    EXISTS (
      SELECT 1 FROM assets
       WHERE id = stage_state.asset_id
         AND ${LIVE_ASSET_PREDICATE}
         AND damaged_since IS NULL
    )`;

const DEPENDENCY_SQL = `
    EXISTS (
      SELECT 1 FROM stage_state dep
       WHERE dep.asset_id = stage_state.asset_id AND dep.stage = ? AND dep.version >= ?
    )`;

interface Subject {
  stage: string;
  targetVersion: number;
  deps: Array<[string, number]>;
  residualSql?: string;
  residualParams: unknown[];
}

const SUBJECTS: Subject[] = stageManifest.map((stage) => ({
  stage: stage.name,
  targetVersion: stage.targetVersion,
  deps: resolveStageDeps(stage.dependsOn).map(
    (dep) => [dep.name, dep.minVersion] as [string, number],
  ),
  residualSql: stage.claimResidual?.sql,
  residualParams: [...(stage.claimResidual?.params ?? [])],
}));

function residualTail(subject: Subject): string {
  return subject.residualSql === undefined ? '' : `\n      AND (${subject.residualSql})`;
}

/** The two counts as they were spelled before #3804. */
function beforeStatements(subject: Subject) {
  const deps = subject.deps.map(() => `\n      AND ${DEPENDENCY_SQL}`).join('');
  return {
    pending: {
      sql: `SELECT COUNT(*) AS n
     FROM stage_state
    WHERE stage = ? AND version < ? AND dead = 0
      AND ${ASSET_CLAIMABLE_EXISTS}${residualTail(subject)}`,
      params: [subject.stage, subject.targetVersion, ...subject.residualParams],
    },
    ready: {
      sql: `SELECT COUNT(*) AS n
     FROM stage_state
    WHERE stage = ? AND version < ? AND dead = 0
      AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
      AND ${ASSET_CLAIMABLE_EXISTS}${deps}${residualTail(subject)}`,
      params: [
        subject.stage,
        subject.targetVersion,
        NOW,
        ...subject.deps.flat(),
        ...subject.residualParams,
      ],
    },
  };
}

/** The two counts as they are spelled now, straight from the repo module. */
function afterStatements(subject: Subject) {
  return {
    pending: {
      sql: stagePendingCountSql(subject.residualSql),
      params: [subject.stage, subject.targetVersion, ...subject.residualParams],
    },
    ready: {
      sql: stageReadyCountSql(subject.deps.length, subject.residualSql),
      params: [
        subject.stage,
        subject.targetVersion,
        NOW,
        ...subject.deps.flat(),
        ...subject.residualParams,
      ],
    },
  };
}

interface Timed {
  ms: number;
  n: number;
}

function measure(db: Database, statement: { sql: string; params: unknown[] }): Timed {
  const { ms } = timeStatement(db, statement.sql, statement.params, RUNS);
  const row = db.query(statement.sql).get(...(statement.params as never[])) as { n: number };
  return { ms, n: row.n };
}

interface Pass {
  pending: Timed;
  ready: Timed;
}

interface Row {
  stage: string;
  before: Pass;
  after: Pass;
}

function measurePass(
  db: Database,
  subject: Subject,
  build: (subject: Subject) => {
    pending: { sql: string; params: unknown[] };
    ready: { sql: string; params: unknown[] };
  },
): Pass {
  const statements = build(subject);
  return { pending: measure(db, statements.pending), ready: measure(db, statements.ready) };
}

/**
 * The two claim indexes as they were before #3804, and no `stage_dep`.
 *
 * The old spelling has to be timed against the old indexes or the comparison
 * flatters it: left on the new schema its `dependsOn` probe picks up
 * `stage_dep` and reports two thirds of what it actually cost. `asset_claimable`
 * itself can stay — the old queries do not mention it.
 */
function revertIndexes(db: Database): void {
  db.run('DROP INDEX stage_dep');
  db.run('DROP INDEX stage_claim');
  db.run(
    'CREATE INDEX stage_claim ON stage_state (stage, version, dead, next_attempt_at, asset_id)',
  );
  db.run('DROP INDEX stage_claim_media');
  db.run(
    `CREATE INDEX stage_claim_media
       ON stage_state (stage, version, dead, next_attempt_at, asset_id, media_kind)
       WHERE media_kind IN ('video', 'audio')`,
  );
  db.exec('ANALYZE');
}

function combine(stage: string, before: Pass, after: Pass): Row {
  for (const which of ['pending', 'ready'] as const) {
    if (before[which].n === after[which].n) continue;
    throw new Error(
      `${stage}: the two ${which} spellings disagree — ` +
        `${before[which].n} before, ${after[which].n} after. ` +
        'They must answer the same question.',
    );
  }
  return { stage, before, after };
}

function cell(value: number): string {
  return `${value.toFixed(1)} ms`.padStart(10);
}

function report(rows: readonly Row[]): void {
  const sum = (pick: (row: Row) => number): number => rows.reduce((acc, row) => acc + pick(row), 0);
  console.log(
    `\n  ${'stage'.padEnd(24)}${'pending'.padStart(22)}${'ready'.padStart(22)}${'counts'.padStart(18)}`,
  );
  console.log(
    `  ${''.padEnd(24)}${'before'.padStart(10)}${'after'.padStart(12)}` +
      `${'before'.padStart(10)}${'after'.padStart(12)}${'pending'.padStart(10)}${'ready'.padStart(8)}`,
  );
  for (const row of rows) {
    console.log(
      `  ${row.stage.padEnd(24)}${cell(row.before.pending.ms)}${cell(row.after.pending.ms)}` +
        `${cell(row.before.ready.ms)}${cell(row.after.ready.ms)}` +
        `${String(row.after.pending.n).padStart(10)}${String(row.after.ready.n).padStart(8)}`,
    );
  }
  const totals = {
    beforePending: sum((row) => row.before.pending.ms),
    afterPending: sum((row) => row.after.pending.ms),
    beforeReady: sum((row) => row.before.ready.ms),
    afterReady: sum((row) => row.after.ready.ms),
  };
  console.log(
    `  ${'TOTAL'.padEnd(24)}${cell(totals.beforePending)}${cell(totals.afterPending)}` +
      `${cell(totals.beforeReady)}${cell(totals.afterReady)}`,
  );
  const before = totals.beforePending + totals.beforeReady;
  const after = totals.afterPending + totals.afterReady;
  console.log(
    `\n  one full twelve-stage pass: ${before.toFixed(0)} ms -> ${after.toFixed(0)} ms ` +
      `(${(before / after).toFixed(1)}x)`,
  );
  console.log(
    '  the refresher stops throttling itself below 1,667 ms — ' +
      `${after < 1667 ? 'under it' : 'still above it'}`,
  );
}

function reportPlans(db: Database): void {
  const subject = SUBJECTS.find((candidate) => candidate.stage === 'describe');
  if (subject === undefined) return;
  const after = afterStatements(subject);
  console.log('\nplans (describe):');
  for (const [label, statement] of Object.entries(after)) {
    console.log(`  ${label}:`);
    console.log(`    ${queryPlanLines(db, statement.sql, statement.params).join('\n    ')}`);
  }
}

function reportShape(db: Database): void {
  const row = db
    .query(
      `SELECT (SELECT COUNT(*) FROM assets) AS assets,
              (SELECT COUNT(*) FROM assets WHERE NOT (${LIVE_ASSET_PREDICATE})
                                              OR damaged_since IS NOT NULL) AS not_claimable,
              (SELECT COUNT(*) FROM stage_state) AS stage_rows,
              (SELECT COUNT(*) FROM stage_state WHERE asset_claimable = 0) AS stage_rows_parked`,
    )
    .get() as Record<string, number>;
  console.log('\nlibrary shape:');
  for (const [key, value] of Object.entries(row)) {
    console.log(`  ${key.padEnd(20)} ${value.toLocaleString().padStart(12)}`);
  }
}

/** The generated library is 1.8 GB; `--keep` is for looking at it afterwards. */
async function disposeOf(path: string): Promise<void> {
  if (process.argv.includes('--keep')) {
    console.log(`\nkept ${path}`);
    return;
  }
  await removeDatabase(path);
}

/**
 * A fresh connection on the same file.
 *
 * Both halves are measured on one of these, so neither inherits the other's
 * prepared statements or page cache — and `revertIndexes` needs a connection
 * with no cached statement against `stage_state`, or SQLite refuses to drop an
 * index on it.
 */
function reopen(path: string): Database {
  const db = new Database(path);
  for (const pragma of SCHEMA_PRAGMAS) db.exec(pragma);
  return db;
}

async function main(): Promise<void> {
  const size = sizeArgument(process.argv.slice(2), 335_377);
  const path = benchDbPath('stage-backlog-counts');
  console.log(`building a ${size.toLocaleString()}-asset library at ${path} …`);
  (await buildLibrary(path, size)).close();

  // The new spelling first, on the schema it ships with.
  const fresh = reopen(path);
  reportShape(fresh);
  const after = SUBJECTS.map((subject) => measurePass(fresh, subject, afterStatements));
  reportPlans(fresh);
  fresh.close();

  // Then the schema goes back the way it was, and the old spelling is timed on
  // its own indexes.
  console.log('\nreverting to the pre-#3804 indexes to time the old spelling …');
  const reverted = reopen(path);
  revertIndexes(reverted);
  reverted.close();
  const old = reopen(path);
  const before = SUBJECTS.map((subject) => measurePass(old, subject, beforeStatements));
  old.close();

  report(SUBJECTS.map((subject, index) => combine(subject.stage, before[index]!, after[index]!)));
  await disposeOf(path);
}

await main();
