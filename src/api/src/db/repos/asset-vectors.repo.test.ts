import { describe, expect, test } from 'bun:test';
import { rearmEmbedForEmbedderChange, upsertAssetVectorStatement } from './asset-vectors.repo.ts';
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

describe('rearmEmbedForEmbedderChange', () => {
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
          endpoint: ENDPOINT,
          vector: Float32Array.of(1),
          embeddedAt,
        }),
      ]);
    }

    const changed = await rearmEmbedForEmbedderChange(
      { model: 'bge-m3', url: ENDPOINT },
      { includeDead: false },
      db,
    );

    expect(changed).toBe(1);
    expect(stageRow(handle.db, stale, 'embed')?.version).toBe(0);
    expect(stageRow(handle.db, current, 'embed')?.version).toBe(8);
  });
});

describe('rearmEmbedForEmbedderChange across endpoints', () => {
  test('re-queues completed rows when the same model is served from a new URL', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const assetIds = [] as string[];
    for (const mapleId of ['m1', 'm2']) {
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
      assetIds.push(assetId);
    }

    const sameTarget = { model: 'bge-m3', url: ENDPOINT };
    expect(await rearmEmbedForEmbedderChange(sameTarget, { includeDead: false }, db)).toBe(0);

    const moved = { model: 'bge-m3', url: 'http://other-gpu:11434' };
    expect(await rearmEmbedForEmbedderChange(moved, { includeDead: false }, db)).toBe(2);
    assetIds.forEach((id) => expect(stageRow(handle.db, id, 'embed')?.version).toBe(0));
  });
});

describe('rearmEmbedForEmbedderChange with dead rows', () => {
  async function deadAsset(handle: Awaited<ReturnType<typeof createTestDatabase>>) {
    return seedClaimableAsset(handle.db, {
      stages: { embed: { version: 0, attempts: 3, dead: true } },
    });
  }

  test('revives rows that dead-lettered without a vector only when asked', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const dead = await deadAsset(handle);

    expect(
      await rearmEmbedForEmbedderChange(
        { model: 'bge-m3', url: ENDPOINT },
        { includeDead: false },
        db,
      ),
    ).toBe(0);
    expect(stageRow(handle.db, dead, 'embed')?.dead).toBe(1);

    expect(
      await rearmEmbedForEmbedderChange(
        { model: 'bge-m3', url: ENDPOINT },
        { includeDead: true },
        db,
      ),
    ).toBe(1);
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
