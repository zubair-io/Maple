import { describe, expect, test } from 'bun:test';
import { rearmEmbedForModelChange, upsertAssetVectorStatement } from './asset-vectors.repo.ts';
import { seedClaimableAsset, stageRow } from './stage-runtime.test-helpers.ts';
import { createTestDatabase, testSqliteDb } from '../sqlite/test-sqlite.test-helpers.ts';

const embeddedAt = new Date('2026-10-09T00:00:00.000Z');

describe('upsertAssetVectorStatement', () => {
  test('replaces the vector of an already embedded asset', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const record = { mapleId: 'm1', version: 8, model: 'bge-m3', embeddedAt };

    await db.transaction([
      upsertAssetVectorStatement({ ...record, vector: Float32Array.of(1, 0) }),
    ]);
    await db.transaction([
      upsertAssetVectorStatement({ ...record, model: 'other', vector: Float32Array.of(0, 1) }),
    ]);

    const rows = handle.db.query(`SELECT model, dims, vector FROM asset_vectors`).all() as Array<{
      model: string;
      dims: number;
      vector: Uint8Array;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ model: 'other', dims: 2 });
    expect(Array.from(rows[0]!.vector)).toEqual([0, 0, 0, 0, 0, 0, 0x80, 0x3f]);
  });
});

describe('rearmEmbedForModelChange', () => {
  test('re-queues only assets embedded by a different model', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const stale = seedClaimableAsset(handle.db, { stages: { embed: { version: 8 } } });
    const current = seedClaimableAsset(handle.db, { stages: { embed: { version: 8 } } });
    for (const [assetId, mapleId, model] of [
      [stale, 'm-stale', 'old-model'],
      [current, 'm-current', 'bge-m3'],
    ] as const) {
      handle.db.run(`UPDATE assets SET maple_id = ? WHERE id = ?`, [mapleId, assetId]);
      await db.transaction([
        upsertAssetVectorStatement({
          mapleId,
          version: 8,
          model,
          vector: Float32Array.of(1),
          embeddedAt,
        }),
      ]);
    }

    const changed = await rearmEmbedForModelChange('bge-m3', { includeDead: false }, db);

    expect(changed).toBe(1);
    expect(stageRow(handle.db, stale, 'embed')?.version).toBe(0);
    expect(stageRow(handle.db, current, 'embed')?.version).toBe(8);
  });
});

describe('rearmEmbedForModelChange with dead rows', () => {
  async function deadAsset(handle: Awaited<ReturnType<typeof createTestDatabase>>) {
    return seedClaimableAsset(handle.db, {
      stages: { embed: { version: 0, attempts: 3, dead: true } },
    });
  }

  test('revives rows that dead-lettered without a vector only when asked', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const dead = await deadAsset(handle);

    expect(await rearmEmbedForModelChange('bge-m3', { includeDead: false }, db)).toBe(0);
    expect(stageRow(handle.db, dead, 'embed')?.dead).toBe(1);

    expect(await rearmEmbedForModelChange('bge-m3', { includeDead: true }, db)).toBe(1);
    expect(stageRow(handle.db, dead, 'embed')).toMatchObject({ version: 0, attempts: 0, dead: 0 });
  });
});

describe('asset_vectors upkeep triggers', () => {
  async function embeddedAsset(
    handle: Awaited<ReturnType<typeof createTestDatabase>>,
    mapleId: string,
  ) {
    const db = testSqliteDb(handle.db);
    const assetId = seedClaimableAsset(handle.db, { stages: { embed: { version: 8 } } });
    handle.db.run(`UPDATE assets SET maple_id = ? WHERE id = ?`, [mapleId, assetId]);
    await db.transaction([
      upsertAssetVectorStatement({
        mapleId,
        version: 8,
        model: 'bge-m3',
        vector: Float32Array.of(1),
        embeddedAt,
      }),
    ]);
    return assetId;
  }

  const vectorCount = (handle: Awaited<ReturnType<typeof createTestDatabase>>) =>
    (handle.db.query(`SELECT COUNT(*) AS n FROM asset_vectors`).get() as { n: number }).n;

  test('deleting an asset deletes its vector and keeps the others', async () => {
    using handle = await createTestDatabase();
    const gone = await embeddedAsset(handle, 'm-gone');
    await embeddedAsset(handle, 'm-kept');

    handle.db.run(`DELETE FROM assets WHERE id = ?`, [gone]);

    expect(handle.db.query(`SELECT maple_id FROM asset_vectors`).all()).toEqual([
      { maple_id: 'm-kept' },
    ]);
  });

  test('changing an asset maple_id drops the stale vector and re-arms embed', async () => {
    using handle = await createTestDatabase();
    const assetId = await embeddedAsset(handle, 'm-old');

    handle.db.run(`UPDATE assets SET maple_id = 'm-new' WHERE id = ?`, [assetId]);

    expect(vectorCount(handle)).toBe(0);
    expect(stageRow(handle.db, assetId, 'embed')?.version).toBe(0);
  });

  test('an update that leaves maple_id alone keeps the vector', async () => {
    using handle = await createTestDatabase();
    const assetId = await embeddedAsset(handle, 'm-same');

    handle.db.run(`UPDATE assets SET maple_id = 'm-same', size = 5 WHERE id = ?`, [assetId]);

    expect(vectorCount(handle)).toBe(1);
    expect(stageRow(handle.db, assetId, 'embed')?.version).toBe(8);
  });
});
