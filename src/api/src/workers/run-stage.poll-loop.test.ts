/**
 * What a tick does with what its handlers returned, end to end.
 *
 * `run-stage.test.ts` covers boot and the happy path; this file covers the
 * outcomes that need several ticks or a second table to observe — a failure
 * walking to its dead-letter, the `damaged` tag a file-reading stage stamps on
 * the way there, the guard that stops a non-damage-tagging stage doing the
 * same, and the derived claim batch size.
 *
 * The statements behind each of those belong to `db/sqlite/repos/`, and their
 * own suites assert them in isolation. What is asserted here is that the runner
 * reaches for the right one, which is exactly the part no repository test can
 * see.
 *
 * Per-asset retry backoff (#2729) means consecutive ticks do not re-claim a
 * failed asset, so a test that walks one through several attempts lifts the
 * gate between ticks — production's wall clock does the same thing more slowly.
 */

import { describe, expect, it } from 'bun:test';
import type { Database } from 'bun:sqlite';
import {
  createLiveTestDatabase,
  insertAsset,
  insertFolder,
  insertLocation,
} from '../db/sqlite/test-sqlite.test-helpers.ts';
import { defineStage, deriveBatchSize, runOnce, type StageConfig } from './run-stage.ts';

const CONFIG = (concurrency: number, maxAttempts: number) => ({
  concurrency,
  maxAttempts,
  paused: false,
  last_seen_target_version: 1,
});

/** One claimable asset with a `stage_state` row for `stage` at version 0. */
function seedAsset(db: Database, stage: string): string {
  const libraryId = insertFolder(db);
  const assetId = insertAsset(db);
  insertLocation(db, { assetId, libraryId });
  db.run(`INSERT INTO stage_state (asset_id, stage) VALUES (?, ?)`, [assetId, stage]);
  return assetId;
}

function stageRow(db: Database, assetId: string, stage: string) {
  return db
    .query(
      `SELECT version, attempts, dead, last_error FROM stage_state WHERE asset_id = ? AND stage = ?`,
    )
    .get(assetId, stage) as {
    version: number;
    attempts: number;
    dead: number;
    last_error: string | null;
  };
}

function damagedTag(db: Database, assetId: string) {
  return db
    .query(`SELECT damaged_since, damaged_stage, damaged_reason FROM assets WHERE id = ?`)
    .get(assetId) as {
    damaged_since: string | null;
    damaged_stage: string | null;
    damaged_reason: string | null;
  };
}

/** Lift every retry gate for a stage, standing in for the wall-clock wait. */
function elapseRetryBackoff(db: Database, stage: string): void {
  db.run(`UPDATE stage_state SET next_attempt_at = NULL WHERE stage = ?`, [stage]);
}

function throwingStage(name: string, message: string, extra: Partial<StageConfig> = {}) {
  return defineStage({
    name,
    targetVersion: 1,
    dependsOn: [],
    defaults: {
      concurrency: 1,
      maxAttempts: 3,
      paused: false,
      pausedOnFirstBoot: false,
      last_seen_target_version: 0,
    },
    handler: async () => {
      throw new Error(message);
    },
    ...extra,
  }) as StageConfig;
}

describe('a handler that keeps throwing', () => {
  it('spends one attempt per tick and dead-letters at maxAttempts', async () => {
    using live = await createLiveTestDatabase();
    const assetId = seedAsset(live.db, 'hash');
    const stage = throwingStage('hash', 'always fail');

    await runOnce(stage, CONFIG(1, 3));
    elapseRetryBackoff(live.db, 'hash');
    await runOnce(stage, CONFIG(1, 3));
    elapseRetryBackoff(live.db, 'hash');
    await runOnce(stage, CONFIG(1, 3));

    expect(stageRow(live.db, assetId, 'hash')).toMatchObject({
      attempts: 3,
      dead: 1,
      last_error: 'always fail',
    });
  });

  it('tags the asset damaged only once a tagging stage is out of attempts', async () => {
    using live = await createLiveTestDatabase();
    const assetId = seedAsset(live.db, 'exif');
    const stage = throwingStage('exif', 'Unknown file format', {
      // The opt-in under test: a file-reading stage maps "out of retries" to
      // "the bytes are unreadable → park the asset for every other stage too".
      tagsDamagedOnDeadLetter: true,
    });

    await runOnce(stage, CONFIG(1, 2));
    expect(stageRow(live.db, assetId, 'exif').dead).toBe(0);
    expect(damagedTag(live.db, assetId).damaged_since).toBeNull();

    elapseRetryBackoff(live.db, 'exif');
    await runOnce(stage, CONFIG(1, 2));

    expect(stageRow(live.db, assetId, 'exif').dead).toBe(1);
    expect(damagedTag(live.db, assetId)).toMatchObject({
      damaged_stage: 'exif',
      damaged_reason: 'Unknown file format',
    });
    expect(typeof damagedTag(live.db, assetId).damaged_since).toBe('string');
  });

  it('leaves the asset untagged when the stage is not a damage-tagging one', async () => {
    using live = await createLiveTestDatabase();
    const assetId = seedAsset(live.db, 'describe');
    // A describe/geocode dead-letter says nothing about the file's bytes.
    const stage = throwingStage('describe', 'LLM timeout');

    await runOnce(stage, CONFIG(1, 1));

    expect(stageRow(live.db, assetId, 'describe').dead).toBe(1);
    expect(damagedTag(live.db, assetId).damaged_since).toBeNull();
  });
});

describe('a handler that classifies the bytes up front', () => {
  it('tags damaged on the first tick, with one honest attempt recorded', async () => {
    using live = await createLiveTestDatabase();
    const assetId = seedAsset(live.db, 'exif');
    const stage = defineStage({
      name: 'exif',
      targetVersion: 1,
      dependsOn: [],
      tagsDamagedOnDeadLetter: true,
      defaults: {
        concurrency: 1,
        maxAttempts: 5,
        paused: false,
        pausedOnFirstBoot: false,
        last_seen_target_version: 0,
      },
      // Deterministically unreadable: say so instead of throwing five times.
      handler: async () => ({ damaged: 'file is empty (0 bytes)' }),
    }) as StageConfig;

    await runOnce(stage, CONFIG(1, 5));

    // One attempt that classified the file, NOT maxAttempts — this path never
    // retried, so it must not look exhausted.
    expect(stageRow(live.db, assetId, 'exif')).toMatchObject({ dead: 1, attempts: 1 });
    expect(damagedTag(live.db, assetId)).toMatchObject({
      damaged_stage: 'exif',
      damaged_reason: 'file is empty (0 bytes)',
    });
  });

  it('refuses a { damaged } result from a stage that does not tag', async () => {
    using live = await createLiveTestDatabase();
    const assetId = seedAsset(live.db, 'meili');
    const stage = defineStage({
      name: 'meili',
      targetVersion: 1,
      dependsOn: [],
      defaults: {
        concurrency: 1,
        maxAttempts: 2,
        paused: false,
        pausedOnFirstBoot: false,
        last_seen_target_version: 0,
      },
      handler: async () => ({ damaged: 'should not be honored' }),
    }) as StageConfig;

    // The runner throws inside the work unit, which its catch turns into an
    // ordinary failed attempt with the reason in `last_error`.
    await runOnce(stage, CONFIG(1, 2));

    expect(damagedTag(live.db, assetId).damaged_since).toBeNull();
    expect(stageRow(live.db, assetId, 'meili').last_error).toMatch(/not a damage-tagging stage/);
  });
});

describe('the claim batch', () => {
  it('is 5× concurrency, and a full one is reported back to the poll loop', async () => {
    // 21 eligible assets, concurrency 4 → derived batch 20. The 21st waits for
    // the next tick, and the full-batch signal is what makes the loop re-poll
    // immediately rather than falling back to the idle cadence.
    using live = await createLiveTestDatabase();
    for (let i = 0; i < 21; i++) seedAsset(live.db, 'hash');
    const stage = defineStage({
      name: 'hash',
      targetVersion: 1,
      dependsOn: [],
      defaults: {
        concurrency: 4,
        maxAttempts: 3,
        paused: false,
        pausedOnFirstBoot: false,
        last_seen_target_version: 0,
      },
      handler: async () => ({ skip: 'noop' }),
    }) as StageConfig;

    const claimed = await runOnce(stage, CONFIG(4, 3));

    expect(deriveBatchSize(4)).toBe(20);
    expect(claimed).toBe(20);
  });
});
