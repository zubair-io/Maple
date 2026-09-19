/**
 * The two backlog counts, checked against the queries they replaced (#3804).
 *
 * `pending` and `ready` stopped asking `assets` whether an asset is live and
 * undamaged, and started reading `stage_state.asset_claimable` — a mirror of
 * those same three columns, kept by triggers. That trade is only sound if the
 * two spellings return the same number over the same database, so this suite
 * builds a library that puts one asset in each state that decides the answer
 * and compares them: not a timing, the numbers themselves.
 *
 * The comparison runs against the shipped `ASSET_CLAIMABLE_SQL` — imported from
 * the claim's own module rather than retyped — so the thing being matched is
 * what the claim still asks per candidate row, and "ready is what the claim
 * would take" stays a checkable statement rather than a comment.
 *
 * The states are deliberately the boring ones plus the two that have bitten
 * before: an asset whose only location went missing (`live_location_count`
 * falls to 0, which is a trigger reacting to a trigger) and an asset tagged
 * damaged after its stage rows already existed. Both reach `stage_state`
 * through a chain of triggers, and a chain is where a mirror stops being true.
 */

import { beforeEach, afterEach, describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { LIVE_ASSET_PREDICATE } from '../sqlite/ddl/assets.ts';
import { assetClaimableExpression } from '../sqlite/ddl/stage-state.ts';
import {
  createTestDatabase,
  insertAsset,
  insertFolder,
  insertLocation,
  run,
  type TestDatabase,
} from '../sqlite/test-sqlite.test-helpers.ts';
import { insertStageState } from './assets.test-helpers.ts';
import { stagePendingCountSql, stageReadyCountSql } from './stage-backlog.sql.ts';
import { ASSET_CLAIMABLE_SQL, CLAIMABLE_GATES, DEPENDENCY_SQL } from './stage-runtime.sql.ts';

const NOW = '2026-06-01T12:00:00.000Z';
const PAST = '2026-05-01T12:00:00.000Z';
const FUTURE = '2026-07-01T12:00:00.000Z';
const STAGE = 'describe';
const DEP = 'preview';
const TARGET = 3;

function previousPendingSql(residualSql?: string): string {
  const residual = residualSql === undefined ? '' : `\n     AND (${residualSql})`;
  return `SELECT COUNT(*) AS n
     FROM stage_state
    WHERE stage = ? AND version < ? AND dead = 0
      AND ${ASSET_CLAIMABLE_SQL}${residual}`;
}

function previousReadySql(dependencyCount: number, residualSql?: string): string {
  const clauses = [
    'stage = ?',
    CLAIMABLE_GATES,
    ASSET_CLAIMABLE_SQL,
    ...Array.from({ length: dependencyCount }, () => DEPENDENCY_SQL),
    ...(residualSql === undefined ? [] : [`(${residualSql})`]),
  ];
  return `SELECT COUNT(*) AS n
     FROM stage_state
    WHERE ${clauses.join('\n    AND ')}`;
}

function count(db: Database, sql: string, params: unknown[]): number {
  return (db.query(sql).get(...(params as never[])) as { n: number }).n;
}

interface AssetOptions {
  /** `describe`'s own row. */
  version?: number;
  dead?: boolean;
  nextAttemptAt?: string | null;
  /** `preview`'s row, or `'none'` to leave the asset without one at all. */
  depVersion?: number | 'none';
  mediaKind?: 'image' | 'video' | 'audio';
}

/** One asset with a live location, a `describe` row and (usually) a `preview` row. */
function seedAsset(db: Database, libraryId: string, options: AssetOptions = {}): string {
  const assetId = insertAsset(db);
  insertLocation(db, { assetId, libraryId });
  if (options.mediaKind !== undefined) {
    run(db, `UPDATE assets SET media_kind = ? WHERE id = ?`, options.mediaKind, assetId);
  }
  insertStageState(db, assetId, STAGE, {
    version: options.version ?? 0,
    dead: options.dead ?? false,
    nextAttemptAt: options.nextAttemptAt ?? null,
  });
  if (options.depVersion !== 'none') {
    insertStageState(db, assetId, DEP, { version: options.depVersion ?? 1 });
  }
  return assetId;
}

describe('stage backlog counts match the queries they replaced', () => {
  let handle: TestDatabase;
  let db: Database;
  let libraryId: string;

  beforeEach(async () => {
    handle = await createTestDatabase();
    db = handle.db;
    libraryId = insertFolder(db);
  });
  afterEach(() => handle.close());

  /** Every state that decides one of the two answers, one asset each. */
  function seedEveryState(): void {
    seedAsset(db, libraryId); // plainly claimable
    seedAsset(db, libraryId, { version: TARGET }); // already at target
    seedAsset(db, libraryId, { dead: true }); // dead-lettered
    seedAsset(db, libraryId, { nextAttemptAt: FUTURE }); // backoff or live lease
    seedAsset(db, libraryId, { nextAttemptAt: PAST }); // backoff expired
    seedAsset(db, libraryId, { depVersion: 0 }); // upstream not done
    seedAsset(db, libraryId, { depVersion: 'none' }); // upstream row absent
    seedAsset(db, libraryId, { mediaKind: 'video' });

    // Soft-deleted after its rows existed.
    run(db, `UPDATE assets SET deleted_at = ? WHERE id = ?`, NOW, seedAsset(db, libraryId));
    // Damaged after its rows existed.
    run(db, `UPDATE assets SET damaged_since = ? WHERE id = ?`, NOW, seedAsset(db, libraryId));
    // Its only location went missing, so live_location_count falls to 0.
    const missing = seedAsset(db, libraryId);
    run(db, `UPDATE asset_locations SET missing_since = ? WHERE asset_id = ?`, NOW, missing);
    // Soft-deleted and then restored — the mirror has to come back too.
    const restored = seedAsset(db, libraryId);
    run(db, `UPDATE assets SET deleted_at = ? WHERE id = ?`, NOW, restored);
    run(db, `UPDATE assets SET deleted_at = NULL WHERE id = ?`, restored);
  }

  const RESIDUAL = `stage_state.media_kind IN ('video', 'audio')
    AND EXISTS (SELECT 1 FROM assets WHERE id = stage_state.asset_id AND media_kind IN (?, ?))`;

  test('pending agrees, with and without a residual', () => {
    seedEveryState();
    const plain = [STAGE, TARGET];
    expect(count(db, stagePendingCountSql(), plain)).toBe(count(db, previousPendingSql(), plain));
    const narrowed = [STAGE, TARGET, 'video', 'audio'];
    expect(count(db, stagePendingCountSql(RESIDUAL), narrowed)).toBe(
      count(db, previousPendingSql(RESIDUAL), narrowed),
    );
  });

  test('ready agrees, with and without a dependency', () => {
    seedEveryState();
    const noDeps = [STAGE, TARGET, NOW];
    expect(count(db, stageReadyCountSql(0), noDeps)).toBe(count(db, previousReadySql(0), noDeps));
    const withDep = [STAGE, TARGET, NOW, DEP, 1];
    expect(count(db, stageReadyCountSql(1), withDep)).toBe(count(db, previousReadySql(1), withDep));
  });

  test('the numbers are the ones the page needs, not just equal to each other', () => {
    seedEveryState();
    // Of the twelve assets, five are out: one already at target, one
    // dead-lettered, and three parked at the asset level (soft-deleted,
    // damaged, no live location). Seven are pending.
    expect(count(db, stagePendingCountSql(), [STAGE, TARGET])).toBe(7);
    // Of those seven, one is sitting out a backoff and two have an upstream
    // row that is unsatisfied or absent, so four could start now — which makes
    // "three blocked" a number the page can show rather than infer.
    expect(count(db, stageReadyCountSql(1), [STAGE, TARGET, NOW, DEP, 1])).toBe(4);
  });

  test('an asset with no row for the dependency still reads as blocked', () => {
    seedAsset(db, libraryId, { depVersion: 'none' });
    expect(count(db, stagePendingCountSql(), [STAGE, TARGET])).toBe(1);
    expect(count(db, stageReadyCountSql(1), [STAGE, TARGET, NOW, DEP, 1])).toBe(0);
  });

  test('the mirrored gate is the live predicate plus the damaged tag, verbatim', () => {
    // A paraphrase would still pass the counts above on a small fixture while
    // quietly disagreeing with the claim about some asset in production.
    expect(assetClaimableExpression()).toContain(LIVE_ASSET_PREDICATE);
    expect(assetClaimableExpression()).toContain('damaged_since IS NULL');
    expect(assetClaimableExpression('NEW')).toContain('NEW.damaged_since IS NULL');
  });
});
