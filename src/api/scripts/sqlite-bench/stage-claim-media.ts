/**
 * What a claim tick costs for a stage that only applies to video or audio —
 * the measurement behind #3795.
 *
 *   bun scripts/sqlite-bench/stage-claim-media.ts            # 335,377 assets
 *   bun scripts/sqlite-bench/stage-claim-media.ts 50000      # one smaller size
 *   bun scripts/sqlite-bench/stage-claim-media.ts --keep     # leave the .db behind
 *
 * `transcribe` and `video-describe` apply to about 4.7% of a real library.
 * Before #3795 they said so with an `EXISTS` over `assets`, which the claim can
 * only apply to a candidate the index scan has already produced — so the scan's
 * length was the stage's backlog, and for these two stages the backlog is the
 * whole photo library. Now the narrowing term goes in front of it and selects
 * `stage_claim_media`, a partial index over the minority kinds.
 *
 * Both spellings are run here against the same database, because the argument
 * is a comparison: a reviewer should be able to see the number the fix moved
 * rather than take a claim about it. The residual's authoritative half — the
 * `EXISTS` — is identical in both, so the two also return the same rows, which
 * the script asserts.
 *
 * ## Two states, and the second one is the one that hurt
 *
 * A stage with work in front of it stops at the batch limit, so even the old
 * shape looked fine: the eligible rows are scattered through the backlog and
 * five of them turn up early. A stage that has CAUGHT UP has no such luck —
 * nothing satisfies the residual, so the scan runs to the end of the backlog,
 * every tick, forever. That is the state production was in, and it is the state
 * a healthy stage spends most of its life in.
 */

import type { Database } from 'bun:sqlite';
import {
  STAGE_STATE_MEDIA_NARROWING,
  STAGE_STATE_VIDEO_NARROWING,
} from '../../src/db/sqlite/ddl/stage-state.ts';
import {
  stageClaimCandidatesSql,
  stagePendingCountSql,
  stageReadyCountSql,
} from '../../src/db/sqlite/repos/stage-runtime.sql.ts';
import {
  benchDbPath,
  buildLibrary,
  removeDatabase,
  sizeArgument,
  timeStatement,
} from './bench-db.ts';

const RUNS = 5;
const LIMIT = 5;
const NOW = new Date().toISOString();

/** The `EXISTS` half of each stage's residual — the authoritative test. */
const EXISTS_VIDEO = `EXISTS (SELECT 1 FROM assets
                   WHERE id = stage_state.asset_id AND media_kind = 'video')`;
const EXISTS_AV = `EXISTS (SELECT 1 FROM assets
                   WHERE id = stage_state.asset_id AND media_kind IN ('video', 'audio'))`;

interface Subject {
  stage: string;
  targetVersion: number;
  dependsOn: Array<[string, number]>;
  /** The residual as it was before #3795, or undefined for a stage with none. */
  before?: string;
  /** The residual as it is now. */
  after?: string;
}

const SUBJECTS: Subject[] = [
  {
    stage: 'video-describe',
    targetVersion: 1,
    dependsOn: [['preview', 1]],
    before: EXISTS_VIDEO,
    after: `${STAGE_STATE_VIDEO_NARROWING} AND ${EXISTS_VIDEO}`,
  },
  {
    stage: 'transcribe',
    targetVersion: 1,
    dependsOn: [],
    before: EXISTS_AV,
    after: `${STAGE_STATE_MEDIA_NARROWING} AND ${EXISTS_AV}`,
  },
  // The control. It has no asset-shaped residual, nothing about it changed, and
  // a regression here would mean the new index had cost the ordinary claim
  // something — which is the other half of what this script is for.
  { stage: 'describe', targetVersion: 4, dependsOn: [['preview', 1]] },
];

function planOf(db: Database, sql: string, params: readonly unknown[]): string {
  const rows = db.query(`EXPLAIN QUERY PLAN ${sql}`).all(...(params as never[])) as Array<{
    detail: string;
  }>;
  return rows.map((row) => row.detail).join('\n        ');
}

/** The claim's candidate scan, one tick of it, with its plan. */
function measureClaim(db: Database, subject: Subject, residual: string | undefined) {
  const sql = stageClaimCandidatesSql(subject.dependsOn.length, 0, residual);
  const params = [subject.stage, subject.targetVersion, NOW, ...subject.dependsOn.flat(), LIMIT];
  return { ...timeStatement(db, sql, params, RUNS), plan: planOf(db, sql, params) };
}

/** The Workers page's two backlog counts, which apply the same residual. */
function measureCounts(db: Database, subject: Subject, residual: string | undefined) {
  const pending = timeStatement(
    db,
    stagePendingCountSql(residual),
    [subject.stage, subject.targetVersion],
    RUNS,
  );
  const ready = timeStatement(
    db,
    stageReadyCountSql(subject.dependsOn.length, residual),
    [subject.stage, subject.targetVersion, NOW, ...subject.dependsOn.flat()],
    RUNS,
  );
  return { pending: pending.ms, ready: ready.ms };
}

function line(label: string, ms: number, rows: number): string {
  return `    ${label.padEnd(34)} ${ms.toFixed(2).padStart(9)} ms   ${rows} row(s)`;
}

function reportSubject(db: Database, subject: Subject, showPlans: boolean): void {
  console.log(`\n  ${subject.stage}`);
  if (subject.before === undefined || subject.after === undefined) {
    const now = measureClaim(db, subject, undefined);
    const counts = measureCounts(db, subject, undefined);
    console.log(line('claim tick', now.ms, now.rows));
    console.log(line('pending count', counts.pending, 1));
    console.log(line('ready count', counts.ready, 1));
    if (showPlans) console.log(`        ${now.plan}`);
    return;
  }

  const before = measureClaim(db, subject, subject.before);
  const after = measureClaim(db, subject, subject.after);
  if (before.rows !== after.rows) {
    throw new Error(
      `${subject.stage}: the two residual spellings disagree — ` +
        `${before.rows} rows before, ${after.rows} after. They must select the same assets.`,
    );
  }
  const beforeCounts = measureCounts(db, subject, subject.before);
  const afterCounts = measureCounts(db, subject, subject.after);
  console.log(line('claim tick — residual only', before.ms, before.rows));
  console.log(line('claim tick — narrowed', after.ms, after.rows));
  console.log(line('pending count — residual only', beforeCounts.pending, 1));
  console.log(line('pending count — narrowed', afterCounts.pending, 1));
  console.log(line('ready count — residual only', beforeCounts.ready, 1));
  console.log(line('ready count — narrowed', afterCounts.ready, 1));
  if (!showPlans) return;
  console.log(`      before:\n        ${before.plan}`);
  console.log(`      after:\n        ${after.plan}`);
}

function shapeOf(db: Database): Record<string, number> {
  const row = db
    .query(
      `SELECT (SELECT COUNT(*) FROM assets) AS assets,
              (SELECT COUNT(*) FROM assets WHERE media_kind IN ('video','audio')) AS video_or_audio,
              (SELECT COUNT(*) FROM stage_state) AS stage_rows,
              (SELECT COUNT(*) FROM stage_state
                WHERE stage = 'video-describe' AND version = 0) AS video_describe_at_0,
              (SELECT COUNT(*) FROM stage_state
                WHERE stage = 'transcribe' AND version = 0) AS transcribe_at_0`,
    )
    .get() as Record<string, number>;
  return row;
}

/**
 * Moves every row a media-only stage COULD claim up to its target, leaving only
 * the rows it never can — production's state, and the one the old shape could
 * not survive.
 */
function drain(db: Database): void {
  for (const [stage, kinds] of [
    ['transcribe', `IN ('video','audio')`],
    ['video-describe', `= 'video'`],
  ] as const) {
    db.run(
      `UPDATE stage_state SET version = 1, processed_at = ?, dead = 0
        WHERE stage = ? AND version = 0
          AND EXISTS (SELECT 1 FROM assets
                       WHERE id = stage_state.asset_id AND media_kind ${kinds})`,
      [NOW, stage] as never[],
    );
  }
  db.exec('ANALYZE');
}

async function main(): Promise<void> {
  const size = sizeArgument(process.argv.slice(2), 335_377);
  const path = benchDbPath('stage-claim-media');
  console.log(`building a ${size.toLocaleString()}-asset library at ${path} …`);
  const db = await buildLibrary(path, size);

  console.log('\nlibrary shape:');
  for (const [key, value] of Object.entries(shapeOf(db))) {
    console.log(`  ${key.padEnd(22)} ${value.toLocaleString().padStart(12)}`);
  }

  console.log('\n=== work available — the stage has a backlog it can act on');
  for (const subject of SUBJECTS) reportSubject(db, subject, false);

  drain(db);
  console.log('\n=== drained — the stage has caught up (production, #3795)');
  for (const subject of SUBJECTS) reportSubject(db, subject, true);

  db.close();
  if (process.argv.includes('--keep')) {
    console.log(`\nkept ${path}`);
    return;
  }
  await removeDatabase(path);
}

await main();
