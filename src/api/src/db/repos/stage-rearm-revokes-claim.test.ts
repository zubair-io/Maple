import { describe, expect, test } from 'bun:test';
import { upsertAssetVectorStatement } from './asset-vectors.repo.ts';
import { searchRearmStatements } from './assets.stage-rearm.ts';
import { claimStageBatch } from './stage-claim.ts';
import { seedClaimableAsset, stageRow } from './stage-runtime.test-helpers.ts';
import { stageSuccessStatements } from './stage-writeback.ts';
import { createTestDatabase, testSqliteDb } from '../sqlite/test-sqlite.test-helpers.ts';

const TARGET_VERSION = 8;
const embeddedAt = new Date('2026-10-09T00:00:00.000Z');

async function claim(
  db: ReturnType<typeof testSqliteDb>,
  stage: string,
  assetId: string,
  now?: Date,
) {
  const { claimed } = await claimStageBatch(
    { stage, targetVersion: TARGET_VERSION, dependsOn: [], limit: 10, maxAttempts: 3, now },
    db,
  );
  const row = claimed.find((candidate) => candidate.asset_id === assetId);
  if (row === undefined) throw new Error(`${stage} was not claimed for ${assetId}`);
  return { assetId, stage, targetVersion: TARGET_VERSION, lease: row.next_attempt_at! };
}

describe('re-arming a stage while an attempt is in flight', () => {
  test('the stale embed completion neither restores the version nor writes its vector', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const assetId = seedClaimableAsset(handle.db, { stages: { embed: {} } });
    handle.db.run(`UPDATE assets SET maple_id = 'm1' WHERE id = ?`, [assetId]);
    const oldClaim = await claim(db, 'embed', assetId);

    await db.transaction(searchRearmStatements(assetId));
    await db.transaction(
      stageSuccessStatements(oldClaim, {
        extra: [
          upsertAssetVectorStatement(
            { mapleId: 'm1', version: 8, model: 'bge-m3', vector: Float32Array.of(1), embeddedAt },
            { assetId, lease: oldClaim.lease },
          ),
        ],
      }),
    );

    expect(stageRow(handle.db, assetId, 'embed')).toMatchObject({
      version: 0,
      next_attempt_at: null,
    });
    expect(handle.db.query(`SELECT COUNT(*) AS n FROM asset_vectors`).get()).toEqual({ n: 0 });

    const newClaim = await claim(db, 'embed', assetId);
    await db.transaction(
      stageSuccessStatements(newClaim, {
        extra: [
          upsertAssetVectorStatement(
            { mapleId: 'm1', version: 8, model: 'bge-m3', vector: Float32Array.of(0), embeddedAt },
            { assetId, lease: newClaim.lease },
          ),
        ],
      }),
    );

    expect(stageRow(handle.db, assetId, 'embed')?.version).toBe(TARGET_VERSION);
    expect(handle.db.query(`SELECT COUNT(*) AS n FROM asset_vectors`).get()).toEqual({ n: 1 });
  });

  test.each([
    [
      'at different times',
      [new Date('2026-10-09T00:00:00.000Z'), new Date('2026-10-09T00:00:05.000Z')],
    ],
    [
      'in the same millisecond',
      [new Date('2026-10-09T00:00:00.000Z'), new Date('2026-10-09T00:00:00.000Z')],
    ],
  ] as const)(
    'a stale write is rejected after a second claim holds a new lease (claims %s)',
    async (_name, [firstNow, secondNow]) => {
      using handle = await createTestDatabase();
      const db = testSqliteDb(handle.db);
      const assetId = seedClaimableAsset(handle.db, { stages: { embed: {} } });
      handle.db.run(`UPDATE assets SET maple_id = 'm1' WHERE id = ?`, [assetId]);
      const claimA = await claim(db, 'embed', assetId, firstNow);
      await db.transaction(searchRearmStatements(assetId));
      const claimB = await claim(db, 'embed', assetId, secondNow);
      const write = (lease: string, value: number) =>
        upsertAssetVectorStatement(
          {
            mapleId: 'm1',
            version: 8,
            model: 'bge-m3',
            vector: Float32Array.of(value),
            embeddedAt,
          },
          { assetId, lease },
        );

      expect(claimB.lease).not.toBe(claimA.lease);
      await db.transaction([write(claimA.lease, 1)]);
      expect(handle.db.query(`SELECT COUNT(*) AS n FROM asset_vectors`).get()).toEqual({ n: 0 });

      await db.transaction([write(claimB.lease, 2)]);
      expect(handle.db.query(`SELECT COUNT(*) AS n FROM asset_vectors`).get()).toEqual({ n: 1 });
    },
  );

  test('three claims in one millisecond all carry different leases', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const assetId = seedClaimableAsset(handle.db, { stages: { embed: {} } });
    const now = new Date('2026-10-09T00:00:00.000Z');
    const leases = [] as string[];
    for (let i = 0; i < 3; i++) {
      leases.push((await claim(db, 'embed', assetId, now)).lease);
      await db.transaction(searchRearmStatements(assetId));
    }
    expect(new Set(leases).size).toBe(3);
  });

  test('the same re-arm also stops a stale meili completion from restoring its version', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const assetId = seedClaimableAsset(handle.db, { stages: { meili: {} } });
    const oldClaim = await claim(db, 'meili', assetId);

    await db.transaction(searchRearmStatements(assetId));
    await db.transaction(stageSuccessStatements(oldClaim));

    expect(stageRow(handle.db, assetId, 'meili')).toMatchObject({
      version: 0,
      next_attempt_at: null,
    });
  });
});
