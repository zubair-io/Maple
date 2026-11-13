import { describe, expect, test } from 'bun:test';
import { rearmEmbedForForeignVectors, upsertAssetVectorStatement } from './asset-vectors.repo.ts';
import { seedClaimableAsset, stageRow } from './stage-runtime.test-helpers.ts';
import { createTestDatabase, testSqliteDb } from '../sqlite/test-sqlite.test-helpers.ts';

const ENDPOINT = 'http://gpu:11434';
const embeddedAt = new Date('2026-10-09T00:00:00.000Z');

describe('upsertAssetVectorStatement', () => {
  test('replaces the vector of an already embedded asset', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const record = { mapleId: 'm1', version: 8, model: 'bge-m3', endpoint: ENDPOINT, embeddedAt };

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

describe('rearmEmbedForForeignVectors', () => {
  test('re-queues only assets another model embedded, whatever the endpoint', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const rows = [
      ['m-foreign', 'nomic-embed-text', ENDPOINT],
      ['m-ollama', 'bge-m3:latest', 'http://192.168.0.201:11434'],
      ['m-openai', 'bge-m3', 'http://strata:8080/v1'],
      ['m-bundled', 'bge-m3', 'bundled'],
    ] as const;
    const assets = new Map<string, string>();
    for (const [mapleId, model, endpoint] of rows) {
      const assetId = seedClaimableAsset(handle.db, { stages: { embed: { version: 8 } } });
      handle.db.run(`UPDATE assets SET maple_id = ? WHERE id = ?`, [mapleId, assetId]);
      await db.transaction([
        upsertAssetVectorStatement({
          mapleId,
          version: 8,
          model,
          endpoint,
          vector: Float32Array.of(1),
          embeddedAt,
        }),
      ]);
      assets.set(mapleId, assetId);
    }

    expect(await rearmEmbedForForeignVectors({ includeDead: false }, db)).toBe(1);

    expect(stageRow(handle.db, assets.get('m-foreign')!, 'embed')?.version).toBe(0);
    for (const kept of ['m-ollama', 'm-openai', 'm-bundled']) {
      expect(stageRow(handle.db, assets.get(kept)!, 'embed')?.version).toBe(8);
    }
  });
});

describe('rearmEmbedForForeignVectors with dead rows', () => {
  test('revives rows that dead-lettered without a vector only when asked', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const dead = seedClaimableAsset(handle.db, {
      stages: { embed: { version: 0, attempts: 3, dead: true } },
    });

    expect(await rearmEmbedForForeignVectors({ includeDead: false }, db)).toBe(0);
    expect(stageRow(handle.db, dead, 'embed')?.dead).toBe(1);

    expect(await rearmEmbedForForeignVectors({ includeDead: true }, db)).toBe(1);
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
        endpoint: ENDPOINT,
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
