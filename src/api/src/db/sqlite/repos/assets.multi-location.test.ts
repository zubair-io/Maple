/**
 * Multi-location semantics — the rule the port is most likely to get wrong,
 * and the one that has already cost a production bug.
 *
 * MongoDB answers an array-of-subdocuments filter two different ways, and the
 * difference is invisible at the call site. `$elemMatch: { a, b }` requires ONE
 * entry to satisfy both conditions; `{ 'arr.a': …, 'arr.b': … }` lets
 * DIFFERENT entries satisfy them. `routes/backup-sidecar.ts` uses the second
 * form where every sibling route uses the first, so an asset linked to
 * `(deviceA, id1)` and `(deviceB, id2)` answers a lookup for `(deviceA, id2)`
 * today.
 *
 * Each test below is written so that it would fail under the naive reading —
 * "match each condition against the asset's locations independently" — rather
 * than merely exercising the happy path. The two shapes that separate them are
 * the cross-product address and the cross-product phasset link, neither of
 * which exists as a row.
 */

import { describe, expect, test } from 'bun:test';
import { ObjectId } from 'mongodb';
import {
  findCoreInfoById,
  findDetailByAddress,
  findDetailById,
  findListItems,
  findLiveAssetIdByMapleId,
  findLiveAssetIdByPhassetLink,
} from './assets.repo.ts';
import { insertPhassetLink } from './assets.test-helpers.ts';
import {
  createTestDatabase,
  insertAsset,
  insertFolder,
  insertLocation,
  liveLocationCount,
  run,
  testSqliteDb,
} from '../test-sqlite.test-helpers.ts';

const oid = (hex: string): ObjectId => new ObjectId(hex);

describe('any-location matching', () => {
  test('resolves an asset through a location that is not its first', async () => {
    using handle = await createTestDatabase();
    const { db } = handle;
    const libraryA = insertFolder(db, { path: '/libraries/a', slug: 'a' });
    const libraryB = insertFolder(db, { path: '/libraries/b', slug: 'b' });
    const assetId = insertAsset(db);
    insertLocation(db, {
      assetId,
      libraryId: libraryA,
      ordinal: 0,
      path: 'x',
      filename: 'a.dng',
    });
    insertLocation(db, {
      assetId,
      libraryId: libraryB,
      ordinal: 1,
      path: 'y',
      filename: 'b.dng',
    });

    const viaSecond = await findDetailByAddress(oid(libraryB), 'y/b.dng', testSqliteDb(db));
    expect(viaSecond!.id).toBe(assetId);
  });

  test('never answers a cross-product address built from two different entries', async () => {
    using handle = await createTestDatabase();
    const { db } = handle;
    const sql = testSqliteDb(db);
    const libraryA = insertFolder(db, { path: '/libraries/a', slug: 'a' });
    const libraryB = insertFolder(db, { path: '/libraries/b', slug: 'b' });
    const assetId = insertAsset(db);
    insertLocation(db, { assetId, libraryId: libraryA, ordinal: 0, path: 'x', filename: 'a.dng' });
    insertLocation(db, { assetId, libraryId: libraryB, ordinal: 1, path: 'y', filename: 'b.dng' });

    // Every field below is present on SOME entry of this asset. Matching them
    // independently would resolve the asset; matching them on one row cannot.
    expect(await findDetailByAddress(oid(libraryA), 'y/b.dng', sql)).toBeNull();
    expect(await findDetailByAddress(oid(libraryB), 'x/a.dng', sql)).toBeNull();
    expect(await findDetailByAddress(oid(libraryA), 'x/b.dng', sql)).toBeNull();
    expect(await findDetailByAddress(oid(libraryA), 'y/a.dng', sql)).toBeNull();
  });

  test('never answers a phasset lookup built from two different links', async () => {
    using handle = await createTestDatabase();
    const { db } = handle;
    const sql = testSqliteDb(db);
    const libraryId = insertFolder(db);
    const assetId = insertAsset(db);
    insertLocation(db, { assetId, libraryId, filename: 'a.dng' });
    insertPhassetLink(db, { assetId, deviceId: 'device-a', phassetLocalId: 'local-1' });
    insertPhassetLink(db, { assetId, deviceId: 'device-b', phassetLocalId: 'local-2' });

    // This is the recorded production bug, as a test: the pair below is the
    // cross product of two real links and must not resolve.
    expect(
      await findLiveAssetIdByPhassetLink('device-a', 'local-2', oid(libraryId), sql),
    ).toBeNull();
    expect(
      await findLiveAssetIdByPhassetLink('device-b', 'local-1', oid(libraryId), sql),
    ).toBeNull();
    // Both genuine pairs still resolve.
    expect(
      (
        await findLiveAssetIdByPhassetLink('device-a', 'local-1', oid(libraryId), sql)
      )?.toHexString(),
    ).toBe(assetId);
    expect(
      (
        await findLiveAssetIdByPhassetLink('device-b', 'local-2', oid(libraryId), sql)
      )?.toHexString(),
    ).toBe(assetId);
  });

  test('the live-in-this-library scope is satisfied by one entry, not by two', async () => {
    using handle = await createTestDatabase();
    const { db } = handle;
    const sql = testSqliteDb(db);
    const libraryA = insertFolder(db, { path: '/libraries/a', slug: 'a' });
    const libraryB = insertFolder(db, { path: '/libraries/b', slug: 'b' });
    const assetId = insertAsset(db);
    // Live in A, trashed in B.
    insertLocation(db, { assetId, libraryId: libraryA, ordinal: 0, filename: 'a.dng' });
    insertLocation(db, {
      assetId,
      libraryId: libraryB,
      ordinal: 1,
      filename: 'b.dng',
      deletedAt: '2026-04-01T00:00:00Z',
    });
    run(db, `UPDATE assets SET maple_id = 'content-1' WHERE id = ?`, assetId);

    // "Has a library-B entry" and "has a live entry" are both true of this
    // asset, but no single entry is both.
    expect(await findLiveAssetIdByMapleId('content-1', oid(libraryB), sql)).toBeNull();
    expect((await findLiveAssetIdByMapleId('content-1', oid(libraryA), sql))?.toHexString()).toBe(
      assetId,
    );
  });
});

describe('primary-entry resolution', () => {
  test('picks the first LIVE entry, not simply the first entry', async () => {
    using handle = await createTestDatabase();
    const { db } = handle;
    const libraryId = insertFolder(db, { path: '/libraries/main' });
    const assetId = insertAsset(db);
    insertLocation(db, {
      assetId,
      libraryId,
      ordinal: 0,
      path: 'gone',
      filename: 'stale.dng',
      missingSince: '2026-03-01T00:00:00Z',
    });
    insertLocation(db, { assetId, libraryId, ordinal: 1, path: 'here', filename: 'real.dng' });

    const dto = await findDetailById(oid(assetId), testSqliteDb(db));
    expect(dto!.filename).toBe('real.dng');
    expect(dto!.abs_path).toBe('/libraries/main/here/real.dng');
    // Both entries still ride on the wire, in array order.
    expect(dto!.fileinfo?.map((e) => e.filename)).toEqual(['stale.dng', 'real.dng']);
    expect(dto!.fileinfo?.[0]?.missing_since).toBe('2026-03-01T00:00:00Z');
  });

  test('falls back to entry zero when no entry is live', async () => {
    using handle = await createTestDatabase();
    const { db } = handle;
    const libraryId = insertFolder(db, { path: '/libraries/main' });
    const assetId = insertAsset(db);
    insertLocation(db, {
      assetId,
      libraryId,
      ordinal: 0,
      path: '',
      filename: 'first.dng',
      deletedAt: '2026-03-01T00:00:00Z',
    });
    insertLocation(db, {
      assetId,
      libraryId,
      ordinal: 1,
      path: '',
      filename: 'second.dng',
      missingSince: '2026-03-02T00:00:00Z',
    });

    const info = await findCoreInfoById(oid(assetId), testSqliteDb(db));
    expect(info!.filename).toBe('first.dng');
    expect(info!.abs_path).toBe('/libraries/main/first.dng');
  });

  test('reports no primary at all when the asset has no locations', async () => {
    using handle = await createTestDatabase();
    const { db } = handle;
    const assetId = insertAsset(db);
    const dto = await findDetailById(oid(assetId), testSqliteDb(db));
    expect(dto!.folder_id).toBe('');
    expect(dto!.filename).toBe('');
    expect(dto!.abs_path).toBe('');
    // Absent, not empty — the Mongo field was optional and clients test for it.
    expect(dto!.fileinfo).toBeUndefined();
  });
});

describe('liveness is per entry, and the roll-up follows it', () => {
  test('an asset stays live while any one location is', async () => {
    using handle = await createTestDatabase();
    const { db } = handle;
    const sql = testSqliteDb(db);
    const libraryId = insertFolder(db);
    const assetId = insertAsset(db);
    insertLocation(db, {
      assetId,
      libraryId,
      ordinal: 0,
      filename: 'a.dng',
      missingSince: '2026-03-01T00:00:00Z',
    });
    insertLocation(db, { assetId, libraryId, ordinal: 1, filename: 'b.dng' });

    expect(liveLocationCount(db, assetId)).toBe(1);
    expect((await findListItems({}, 10, sql)).map((i) => i.id)).toEqual([assetId]);

    // Tag the last live entry: the asset leaves every live surface.
    run(
      db,
      `UPDATE asset_locations SET missing_since = '2026-03-05T00:00:00Z'
        WHERE asset_id = ? AND ordinal = 1`,
      assetId,
    );
    expect(liveLocationCount(db, assetId)).toBe(0);
    expect(await findListItems({}, 10, sql)).toEqual([]);

    // Recovering it brings the asset back without anyone maintaining a counter.
    run(
      db,
      `UPDATE asset_locations SET missing_since = NULL WHERE asset_id = ? AND ordinal = 1`,
      assetId,
    );
    expect(liveLocationCount(db, assetId)).toBe(1);
    expect((await findListItems({}, 10, sql)).map((i) => i.id)).toEqual([assetId]);
  });

  test('a soft-deleted asset is excluded even while its locations are live', async () => {
    using handle = await createTestDatabase();
    const { db } = handle;
    const libraryId = insertFolder(db);
    const assetId = insertAsset(db, { deletedAt: '2026-04-01T00:00:00Z' });
    insertLocation(db, { assetId, libraryId, filename: 'a.dng' });

    expect(liveLocationCount(db, assetId)).toBe(1);
    expect(await findListItems({}, 10, testSqliteDb(db))).toEqual([]);
  });
});
