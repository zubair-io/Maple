/**
 * Seeding, registration, the version-bump reset and the persisted counts —
 * ported from the `versionBumpReset` half of `workers/run-stage.test.ts`, the
 * `blankStagesSkeleton` contract in `workers/stages/manifest.ts`, and the
 * per-stage counts in `workers/status-counts.test.ts`.
 */

import { describe, expect, test } from 'bun:test';
import {
  countStageBacklog,
  registerStage,
  registerStages,
  seedStageRows,
  versionBumpReset,
} from './stage-state.repo.ts';
import { claimStageBatch } from './stage-claim.ts';
import { testSqliteDb } from './assets.test-helpers.ts';
import { seedClaimableAsset, stageRow } from './stage-runtime.test-helpers.ts';
import { createTestDatabase, type TestDatabase } from '../test-sqlite.test-helpers.ts';

const STAGES = ['exif', 'thumb', 'preview', 'describe'] as const;

function rowCount(handle: TestDatabase, stage: string): number {
  return (
    handle.db.query(`SELECT COUNT(*) AS n FROM stage_state WHERE stage = ?`).get(stage) as {
      n: number;
    }
  ).n;
}

describe('seeding a new asset', () => {
  test('gives it one row per registered stage, all at version 0', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const assetId = seedClaimableAsset(handle.db);

    await seedStageRows(assetId, STAGES, db);

    for (const stage of STAGES) {
      expect(stageRow(handle.db, assetId, stage)).toMatchObject({
        version: 0,
        attempts: 0,
        dead: 0,
        last_error: null,
        next_attempt_at: null,
      });
    }
  });

  test('is idempotent, so a re-run does not reset a stage that already ran', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const assetId = seedClaimableAsset(handle.db);
    await seedStageRows(assetId, ['exif'], db);
    handle.db.run(`UPDATE stage_state SET version = 3 WHERE asset_id = ?`, [assetId]);

    await seedStageRows(assetId, ['exif'], db);

    // `DO NOTHING` rather than `DO UPDATE`: re-seeding is a boot-time sweep,
    // and a sweep that re-queued completed work would redo the library.
    expect(stageRow(handle.db, assetId, 'exif')?.version).toBe(3);
  });

  test('a seeded row is what makes the asset claimable at all', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const assetId = seedClaimableAsset(handle.db);
    const before = await claimStageBatch(
      { stage: 'exif', targetVersion: 1, dependsOn: [], limit: 10, maxAttempts: 3 },
      db,
    );
    await seedStageRows(assetId, ['exif'], db);
    const after = await claimStageBatch(
      { stage: 'exif', targetVersion: 1, dependsOn: [], limit: 10, maxAttempts: 3 },
      db,
    );

    // On Mongo a missing subdocument is claimable, because BSON orders a
    // missing field below any number. The SQL equivalent is an anti-join that
    // cannot use an index at all, so the rows are dense instead — which makes
    // seeding a correctness requirement, not an optimisation.
    expect(before.claimed).toEqual([]);
    expect(after.claimed.map((row) => row.asset_id)).toEqual([assetId]);
  });
});

describe('registering a stage', () => {
  test('backfills every existing asset in one statement', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    for (let i = 0; i < 5; i++) seedClaimableAsset(handle.db);

    const created = await registerStage('new-stage', db);

    // The whole cost of adding a thirteenth stage. On Mongo it is two more
    // index definitions, rebuilt over the collection on the next boot.
    expect(created).toBe(5);
    expect(rowCount(handle, 'new-stage')).toBe(5);
  });

  test('a second boot creates nothing and does not throw', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    seedClaimableAsset(handle.db);
    await registerStage('new-stage', db);

    expect(await registerStage('new-stage', db)).toBe(0);
  });

  test('registers a whole manifest and reports what each stage created', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    seedClaimableAsset(handle.db);
    seedClaimableAsset(handle.db);

    const created = await registerStages(STAGES, db);

    expect(created).toEqual({ exif: 2, thumb: 2, preview: 2, describe: 2 });
  });

  test('a newly registered stage immediately claims assets that predate it', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const assetId = seedClaimableAsset(handle.db);

    await registerStage('new-stage', db);
    const outcome = await claimStageBatch(
      { stage: 'new-stage', targetVersion: 1, dependsOn: [], limit: 10, maxAttempts: 3 },
      db,
    );

    expect(outcome.claimed.map((row) => row.asset_id)).toEqual([assetId]);
  });
});

describe('versionBumpReset', () => {
  test('lifts the dead flag and clears the retry trail below the new target', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const parked = seedClaimableAsset(handle.db, {
      stages: {
        exif: {
          version: 1,
          attempts: 3,
          dead: true,
          lastError: 'boom',
          nextAttemptAt: '2099-01-01T00:00:00.000Z',
        },
      },
    });
    const done = seedClaimableAsset(handle.db, { stages: { exif: { version: 2 } } });

    const changed = await versionBumpReset('exif', 2, 1, db);

    expect(changed).toBe(1);
    expect(stageRow(handle.db, parked, 'exif')).toMatchObject({
      dead: 0,
      attempts: 0,
      last_error: null,
      next_attempt_at: null,
      // Still below target — that is what makes it claimable again.
      version: 1,
    });
    expect(stageRow(handle.db, done, 'exif')?.version).toBe(2);
  });

  test('does nothing when the target has not moved', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const parked = seedClaimableAsset(handle.db, { stages: { exif: { dead: true } } });

    expect(await versionBumpReset('exif', 2, 2, db)).toBe(0);
    expect(stageRow(handle.db, parked, 'exif')?.dead).toBe(1);
  });
});

describe('countStageBacklog', () => {
  test('counts what is left and what is parked, ignoring the retry gate', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    seedClaimableAsset(handle.db, { stages: { exif: { version: 0 } } });
    seedClaimableAsset(handle.db, {
      stages: { exif: { version: 0, nextAttemptAt: '2099-01-01T00:00:00.000Z' } },
    });
    seedClaimableAsset(handle.db, { stages: { exif: { version: 1 } } });
    seedClaimableAsset(handle.db, { stages: { exif: { dead: true } } });

    const backlog = await countStageBacklog('exif', 1, undefined, db);

    // Pending answers "how much work is left", where the claim answers "what
    // can start right now" — so an asset inside its backoff window is still
    // pending, and a dead-lettered one is not.
    expect(backlog).toEqual({ pending: 2, dead: 1 });
  });

  test('excludes assets no stage can reach', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    seedClaimableAsset(handle.db, { stages: { exif: {} } });
    seedClaimableAsset(handle.db, { missing: true, stages: { exif: {} } });
    seedClaimableAsset(handle.db, {
      deletedAt: '2026-01-01T00:00:00.000Z',
      stages: { exif: {} },
    });

    // Without the same liveness gate the claim applies, `blocked = pending -
    // ready` would absorb the reaper's whole queue into every stage's blocked
    // count.
    expect((await countStageBacklog('exif', 1, undefined, db)).pending).toBe(1);
  });

  test('applies the stage residual, so a media-only stage does not count the library', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    seedClaimableAsset(handle.db, { mediaKind: 'image', stages: { transcribe: {} } });
    seedClaimableAsset(handle.db, { mediaKind: 'video', stages: { transcribe: {} } });

    const backlog = await countStageBacklog(
      'transcribe',
      1,
      {
        sql: `EXISTS (SELECT 1 FROM assets WHERE id = stage_state.asset_id AND media_kind IN (?, ?))`,
        params: ['video', 'audio'],
      },
      db,
    );

    expect(backlog.pending).toBe(1);
  });
});
