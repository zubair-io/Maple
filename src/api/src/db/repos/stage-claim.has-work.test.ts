/**
 * `stageHasWork` is the stage lane's once-a-second question, so it must agree
 * with what a claim would take and must never write: a peek that leased rows
 * would hold them for fifteen minutes with nothing running them.
 */

import type { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { claimStageBatch, stageHasWork, type StageScan } from './stage-claim.ts';
import { seedClaimableAsset } from './stage-runtime.test-helpers.ts';
import { createTestDatabase, testSqliteDb } from '../sqlite/test-sqlite.test-helpers.ts';

const STAGE = 'thumb';
const FUTURE = '2999-01-01T00:00:00.000Z';
const PAST = '2001-01-01T00:00:00.000Z';

const scan = (overrides: Partial<StageScan> = {}): StageScan => ({
  stage: STAGE,
  targetVersion: 2,
  dependsOn: [{ name: 'exif', minVersion: 1 }],
  ...overrides,
});

const stageTable = (db: Database): unknown[] =>
  db.query(`SELECT * FROM stage_state ORDER BY asset_id, stage`).all();

/** Every way an asset can be ineligible, none of which is work. */
function seedIneligible(db: Database): void {
  seedClaimableAsset(db, { stages: { [STAGE]: { version: 2 }, exif: { version: 1 } } });
  seedClaimableAsset(db, { stages: { [STAGE]: {}, exif: { version: 0 } } });
  seedClaimableAsset(db, { stages: { [STAGE]: {} } });
  seedClaimableAsset(db, { stages: { [STAGE]: { dead: true }, exif: { version: 1 } } });
  seedClaimableAsset(db, {
    stages: { [STAGE]: { nextAttemptAt: FUTURE }, exif: { version: 1 } },
  });
  seedClaimableAsset(db, {
    deletedAt: PAST,
    stages: { [STAGE]: {}, exif: { version: 1 } },
  });
  seedClaimableAsset(db, { missing: true, stages: { [STAGE]: {}, exif: { version: 1 } } });
  const damaged = seedClaimableAsset(db, { stages: { [STAGE]: {}, exif: { version: 1 } } });
  db.run(`UPDATE assets SET damaged_since = ? WHERE id = ?`, [PAST, damaged]);
}

describe('stageHasWork', () => {
  test('sees nothing where a claim would take nothing, and writes nothing', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    seedIneligible(handle.db);
    const before = stageTable(handle.db);

    expect(await stageHasWork(scan(), db)).toBe(false);
    expect(stageTable(handle.db)).toEqual(before);

    const claimed = await claimStageBatch({ ...scan(), limit: 50, maxAttempts: 3 }, db);
    expect(claimed.claimed).toEqual([]);
    expect(claimed.crashExhausted).toEqual([]);
  });

  test('sees the one claimable asset among the ineligible ones, and leaves it unclaimed', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    seedIneligible(handle.db);
    const ready = seedClaimableAsset(handle.db, {
      stages: { [STAGE]: { nextAttemptAt: PAST }, exif: { version: 1 } },
    });
    const before = stageTable(handle.db);

    expect(await stageHasWork(scan(), db)).toBe(true);
    expect(stageTable(handle.db)).toEqual(before);

    const claimed = await claimStageBatch({ ...scan(), limit: 50, maxAttempts: 3 }, db);
    expect(claimed.claimed.map((row) => row.asset_id)).toEqual([ready]);
    expect(await stageHasWork(scan(), db)).toBe(false);
  });

  test('counts a crash-exhausted row, which the claim still has to park', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const exhausted = seedClaimableAsset(handle.db, {
      stages: { [STAGE]: { attempts: 3 }, exif: { version: 1 } },
    });

    expect(await stageHasWork(scan(), db)).toBe(true);

    const claimed = await claimStageBatch({ ...scan(), limit: 50, maxAttempts: 3 }, db);
    expect(claimed.crashExhausted.map((row) => row.assetId)).toEqual([exhausted]);
    expect(await stageHasWork(scan(), db)).toBe(false);
  });

  test('leaves out what this process is already running, and applies the residual', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const running = seedClaimableAsset(handle.db, {
      mediaKind: 'video',
      stages: { [STAGE]: {}, exif: { version: 1 } },
    });
    seedClaimableAsset(handle.db, { stages: { [STAGE]: {}, exif: { version: 1 } } });
    const videosOnly = {
      sql: `EXISTS (SELECT 1 FROM assets WHERE id = stage_state.asset_id AND media_kind = ?)`,
      params: ['video'],
    };

    expect(await stageHasWork(scan({ residual: videosOnly }), db)).toBe(true);
    expect(
      await stageHasWork(scan({ residual: videosOnly, inFlight: new Set([running]) }), db),
    ).toBe(false);
  });
});
