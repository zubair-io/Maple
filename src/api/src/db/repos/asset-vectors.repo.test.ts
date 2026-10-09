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

    const changed = await rearmEmbedForModelChange('bge-m3', db);

    expect(changed).toBe(1);
    expect(stageRow(handle.db, stale, 'embed')?.version).toBe(0);
    expect(stageRow(handle.db, current, 'embed')?.version).toBe(8);
  });
});
