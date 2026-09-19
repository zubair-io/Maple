/**
 * The narrow `stage_state` fixtures the worker suites share.
 *
 * Not a test file — the name does not match Bun's `*.test.ts` glob, so it never
 * runs on its own.
 *
 * Two families of suites need the same two things from the stage table. They
 * need to read back the four columns an assertion actually cares about — what
 * generation the stage is at, how many attempts it has burned, what it last
 * failed with, and whether it has been given up on — and they need to put a
 * stage into the state a worker that gave up leaves behind, so that a
 * migration's re-arm shows up as a change rather than as the state the row was
 * already in. Neither the discover suites nor the migration suites own the
 * stage table, so the pair lives here rather than in either one's own helpers.
 *
 * `db/sqlite/repos/stage-runtime.test-helpers.ts` has a `stageRow` of its own,
 * and it stays separate on purpose: that one selects the whole row, lease and
 * retry bookkeeping included, because those columns are the subject of the repo
 * suites. The suites here compare the row with `toEqual`, so widening it would
 * break every one of them.
 */

import type { Database } from 'bun:sqlite';

/** One stage's bookkeeping, as the worker suites assert on it. */
export interface StageStateRow {
  version: number;
  attempts: number;
  last_error: string | null;
  dead: number;
}

/** One stage's bookkeeping for an asset, or null when no row was seeded. */
export function stageRow(db: Database, assetId: string, stage: string): StageStateRow | null {
  return db
    .query(
      `SELECT version, attempts, last_error, dead FROM stage_state
        WHERE asset_id = ? AND stage = ?`,
    )
    .get(assetId, stage) as StageStateRow | null;
}

/**
 * Park a stage the way a dead-lettered worker would, so a re-arm is visible.
 *
 * The version, attempt count and timestamp are arbitrary but non-default: the
 * point is that every column a re-arm resets starts out clearly not-reset, so
 * an assertion that the re-arm happened cannot pass on a row it never touched.
 */
export function parkStage(db: Database, assetId: string, stage: string, lastError = 'boom'): void {
  db.run(
    `UPDATE stage_state
        SET version = 3, dead = 1, attempts = 5, last_error = ?,
            processed_at = '2026-01-01T00:00:00.000Z'
      WHERE asset_id = ? AND stage = ?`,
    [lastError, assetId, stage],
  );
}
