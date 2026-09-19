/**
 * The stage runner's own behaviour, against a real database (#3787).
 *
 * What this file covers is deliberately narrow: boot, the version-bump
 * re-queue, and one whole tick end to end. The claim's own rules (which assets
 * are claimable, dependencies, the retry gate, the lease, crash exhaustion) and
 * the writeback's (success, skip, re-arm, damaged, failure, the ENOENT park)
 * belong to the repository and are covered by its suites — `stage-claim*`,
 * `stage-retry-backoff` and `stage-writeback*` under `db/repos/`. The
 * five Mongo-mock suites that used to restate them here went away with the
 * mocks.
 *
 * `createLiveTestDatabase` rather than an override handle, because `runOnce`
 * and `bootConfig` reach `sqliteDb()` through several layers and threading an
 * override through all of them would be test scaffolding in production code.
 */

import { describe, expect, it } from 'bun:test';
import type { Database } from 'bun:sqlite';
import {
  createLiveTestDatabase,
  insertAsset,
  insertFolder,
  insertLocation,
} from '../db/sqlite/test-sqlite.test-helpers.ts';
import { WorkerConfigRepo } from '../db/repos/worker-config.repo.ts';
import { _test, defineStage, runOnce, type StageConfig } from './run-stage.ts';
import type { SqlStatement } from '../db/sqlite/protocol.ts';

const { bootConfig, versionBumpReset } = _test;

const baseStage = defineStage({
  name: 'hash',
  targetVersion: 2,
  dependsOn: [],
  defaults: {
    concurrency: 4,
    maxAttempts: 5,
    paused: false,
    pausedOnFirstBoot: false,
    last_seen_target_version: 0,
  },
  handler: async () => ({ patch: [] as readonly SqlStatement[] }),
});

/** One claimable asset with a `stage_state` row for `stage` at version 0. */
function seedAsset(
  db: Database,
  stage: string,
  overrides: Record<string, string | number | null> = {},
): string {
  const libraryId = insertFolder(db);
  const assetId = insertAsset(db);
  insertLocation(db, { assetId, libraryId });
  const columns: Record<string, string | number | null> = {
    version: 0,
    attempts: 0,
    dead: 0,
    ...overrides,
  };
  const names = Object.keys(columns);
  db.run(
    `INSERT INTO stage_state (asset_id, stage, ${names.join(', ')})
     VALUES (?, ?, ${names.map(() => '?').join(', ')})`,
    [assetId, stage, ...names.map((name) => columns[name] ?? null)] as never[],
  );
  return assetId;
}

function stageRow(db: Database, assetId: string, stage: string) {
  return db
    .query(`SELECT * FROM stage_state WHERE asset_id = ? AND stage = ?`)
    .get(assetId, stage) as
    | { version: number; attempts: number; dead: number; last_error: string | null }
    | undefined;
}

describe('bootConfig', () => {
  it('seeds worker_config from defaults on first boot', async () => {
    using live = await createLiveTestDatabase();
    const cfg = await bootConfig(baseStage);
    expect(cfg.concurrency).toBe(4);
    expect(cfg.paused).toBe(false);
    const row = live.db.query(`SELECT * FROM worker_config WHERE name = ?`).get('hash') as {
      concurrency: number;
      last_seen_target_version: number;
    };
    expect(row.concurrency).toBe(4);
    expect(row.last_seen_target_version).toBe(0);
  });

  it('respects pausedOnFirstBoot for paused stages', async () => {
    using _live = await createLiveTestDatabase();
    const pausedStage = defineStage({
      ...baseStage,
      name: 'describe',
      defaults: { ...baseStage.defaults, pausedOnFirstBoot: true },
    });
    expect((await bootConfig(pausedStage)).paused).toBe(true);
  });

  it('returns existing config without overwriting on re-boot', async () => {
    using live = await createLiveTestDatabase();
    live.db.run(
      `INSERT INTO worker_config
         (name, concurrency, max_attempts, paused, last_seen_target_version)
       VALUES ('hash', 8, 5, 1, 1)`,
    );
    const cfg = await bootConfig(baseStage);
    expect(cfg.concurrency).toBe(8);
    expect(cfg.paused).toBe(true);
    expect(cfg.last_seen_target_version).toBe(1);
  });

  it('backfills missing integer fields from defaults on a partial row', async () => {
    // Reproduces the production bug: a PATCH /api/workers/face/config landing
    // before the worker's first bootConfig creates a row holding a name and a
    // paused flag alone, with every integer column still NULL. Without the
    // merge, the next tick's claim asks for a batch size derived from
    // `undefined`. Written through the repository rather than as a raw INSERT,
    // because "a partial upsert creates the row" is the half of the bug that
    // has to stay reproducible.
    using _live = await createLiveTestDatabase();
    await new WorkerConfigRepo().patch(baseStage.name, { paused: false });

    const cfg = await bootConfig(baseStage);

    expect(Number.isInteger(cfg.concurrency)).toBe(true);
    expect(Number.isInteger(cfg.maxAttempts)).toBe(true);
    expect(Number.isInteger(cfg.last_seen_target_version)).toBe(true);
    expect(cfg.concurrency).toBe(baseStage.defaults.concurrency);
    expect(cfg.paused).toBe(false);
  });
});

describe('versionBumpReset', () => {
  it('re-queues rows below the new target and leaves finished ones alone', async () => {
    using live = await createLiveTestDatabase();
    const behind = seedAsset(live.db, 'hash', {
      version: 1,
      attempts: 5,
      dead: 1,
      last_error: 'network error',
    });
    const done = seedAsset(live.db, 'hash', { version: 2, attempts: 0, dead: 0 });

    expect(await versionBumpReset(baseStage, 1)).toBe(1);

    expect(stageRow(live.db, behind, 'hash')).toMatchObject({
      dead: 0,
      attempts: 0,
      last_error: null,
    });
    expect(stageRow(live.db, done, 'hash')).toMatchObject({ version: 2, dead: 0 });
  });

  it('does nothing when the target has not moved', async () => {
    using live = await createLiveTestDatabase();
    const parked = seedAsset(live.db, 'hash', { version: 1, attempts: 5, dead: 1 });
    expect(await versionBumpReset(baseStage, 2)).toBe(0);
    expect(stageRow(live.db, parked, 'hash')?.dead).toBe(1);
  });
});

describe('one tick', () => {
  it('claims, runs the handler, and records the result at the target version', async () => {
    using live = await createLiveTestDatabase();
    const assetId = seedAsset(live.db, 'hash');
    const seen: string[] = [];
    const stage: StageConfig = defineStage({
      ...baseStage,
      handler: async (image) => {
        seen.push(image._id.toHexString());
        return { patch: [{ sql: `UPDATE assets SET rating = 3 WHERE id = ?`, params: [assetId] }] };
      },
    });

    const processed = await runOnce(stage, {
      concurrency: 2,
      maxAttempts: 5,
      paused: false,
      last_seen_target_version: 2,
    });

    expect(processed).toBe(1);
    expect(seen).toEqual([assetId]);
    expect(stageRow(live.db, assetId, 'hash')).toMatchObject({ version: 2, attempts: 0, dead: 0 });
    // The handler's own statement committed in the same transaction as the
    // bookkeeping — that atomicity is the point of returning statements.
    const rating = live.db.query(`SELECT rating FROM assets WHERE id = ?`).get(assetId) as {
      rating: number;
    };
    expect(rating.rating).toBe(3);
  });

  it('hands the handler a document assembled from the asset’s rows', async () => {
    using live = await createLiveTestDatabase();
    const assetId = seedAsset(live.db, 'hash');
    live.db.run(`UPDATE assets SET media_kind = 'video', maple_id = 'abc' WHERE id = ?`, [assetId]);
    let mediaKind: string | undefined;
    let locations = -1;
    const stage: StageConfig = defineStage({
      ...baseStage,
      handler: async (image) => {
        mediaKind = (image as unknown as { media_kind?: string }).media_kind;
        locations = image.fileinfo?.length ?? -1;
        return { wrote: true };
      },
    });

    await runOnce(stage, {
      concurrency: 1,
      maxAttempts: 5,
      paused: false,
      last_seen_target_version: 2,
    });

    expect(mediaKind).toBe('video');
    expect(locations).toBe(1);
  });

  it('claims nothing while the stage is paused', async () => {
    using live = await createLiveTestDatabase();
    const assetId = seedAsset(live.db, 'hash');
    let ran = false;
    const stage: StageConfig = defineStage({
      ...baseStage,
      handler: async () => {
        ran = true;
        return { wrote: true };
      },
    });

    const processed = await runOnce(stage, {
      concurrency: 1,
      maxAttempts: 5,
      paused: true,
      last_seen_target_version: 2,
    });

    expect(processed).toBe(0);
    expect(ran).toBe(false);
    // Not even the attempt counter moved: a paused tick returns before claiming.
    expect(stageRow(live.db, assetId, 'hash')).toMatchObject({ attempts: 0, version: 0 });
  });
});

describe('defineStage', () => {
  it('returns the config object unchanged', () => {
    const cfg = defineStage({
      name: 'test',
      targetVersion: 1,
      dependsOn: [],
      defaults: {
        concurrency: 2,
        maxAttempts: 3,
        paused: false,
        pausedOnFirstBoot: false,
        last_seen_target_version: 0,
      },
      handler: async () => ({ wrote: true }),
    });
    expect(cfg.name).toBe('test');
    expect(cfg.targetVersion).toBe(1);
    expect(cfg.dependsOn).toEqual([]);
    expect(cfg.defaults.concurrency).toBe(2);
  });
});
