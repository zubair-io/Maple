import { expect, test } from 'bun:test';
import { createTestDatabase, testSqliteDb } from '../db/sqlite/test-sqlite.test-helpers.ts';
import { seedClaimableAsset, stageRow } from '../db/repos/stage-runtime.test-helpers.ts';
import { stageResultStatements } from '../db/repos/stage-writeback.ts';
import { claimStageBatch } from '../db/repos/stage-claim.ts';

test('backup deferral remains pending without spending attempts and cannot release a reclaimed lease', async () => {
  using handle = await createTestDatabase();
  const db = testSqliteDb(handle.db);
  const lease = '2026-10-05T01:00:00Z';
  const retryAt = new Date('2026-10-05T02:00:00Z');
  const assetId = seedClaimableAsset(handle.db, {
    stages: { 'cloud-backup': { attempts: 5, nextAttemptAt: lease } },
  });
  const attempt = {
    target: { assetId, stage: 'cloud-backup', targetVersion: 1, lease },
    attemptNo: 5,
    maxAttempts: 5,
    dependsOn: [],
  };
  await db.transaction(
    stageResultStatements(attempt, { defer: { reason: 'One destination offline', retryAt } }),
  );
  expect(stageRow(handle.db, assetId, 'cloud-backup')).toMatchObject({
    version: 0,
    attempts: 4,
    dead: 0,
    next_attempt_at: retryAt.toISOString(),
  });
  await db.write('UPDATE stage_state SET next_attempt_at=? WHERE asset_id=? AND stage=?', [
    'new-worker-lease',
    assetId,
    'cloud-backup',
  ]);
  await db.transaction(
    stageResultStatements(attempt, { defer: { reason: 'stale worker', retryAt } }),
  );
  expect(stageRow(handle.db, assetId, 'cloud-backup')!.next_attempt_at).toBe('new-worker-lease');
});
test('only backup can admit indexed Trash and damaged originals; missing locations remain unavailable', async () => {
  using handle = await createTestDatabase();
  const db = testSqliteDb(handle.db);
  const trash = seedClaimableAsset(handle.db, {
    deletedAt: '2026-10-04T00:00:00Z',
    stages: { 'cloud-backup': {}, thumb: {} },
  });
  const damaged = seedClaimableAsset(handle.db, { stages: { 'cloud-backup': {}, thumb: {} } });
  await db.write('UPDATE assets SET damaged_since=? WHERE id=?', ['2026-10-04T00:00:00Z', damaged]);
  const missing = seedClaimableAsset(handle.db, {
    missing: true,
    stages: { 'cloud-backup': {}, thumb: {} },
  });
  const request = {
    stage: 'cloud-backup',
    targetVersion: 1,
    dependsOn: [],
    limit: 20,
    maxAttempts: 5,
    residual: {
      sql: 'EXISTS (SELECT 1 FROM asset_locations l WHERE l.asset_id=stage_state.asset_id AND l.missing_since IS NULL)',
      params: [],
    },
  };
  const backup = await claimStageBatch(request, db);
  expect(backup.claimed.map((r) => r.asset_id).sort()).toEqual([trash, damaged].sort());
  expect(backup.claimed.some((r) => r.asset_id === missing)).toBe(false);
  expect((await claimStageBatch({ ...request, stage: 'thumb' }, db)).claimed).toEqual([]);
});
