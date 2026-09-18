/**
 * The working-set list query and the two backup-sidecar lookups.
 *
 * Split from `assets.repo.test.ts` because these are the two places the port
 * fixes a defect rather than reproducing behaviour: the list page's projection
 * and the phasset lookup's index. The plans behind both live in
 * `assets.query-plan.test.ts`; what is checked here is the answers.
 */

import { describe, expect, test } from 'bun:test';
import { ObjectId } from 'mongodb';
import {
  findListItems,
  findLiveAssetIdByMapleId,
  findLiveAssetIdByPhassetLink,
} from './assets.repo.ts';
import { insertDetail, insertPhassetLink, testSqliteDb } from './assets.test-helpers.ts';
import {
  createTestDatabase,
  insertAsset,
  insertFolder,
  insertLocation,
  run,
} from '../test-sqlite.test-helpers.ts';

const oid = (hex: string): ObjectId => new ObjectId(hex);

describe('findListItems', () => {
  test('returns live assets newest first, with seconds-resolution mtime', async () => {
    using handle = await createTestDatabase();
    const { db } = handle;
    const libraryId = insertFolder(db, { path: '/libraries/main' });
    const older = insertAsset(db, {
      exif: JSON.stringify({ captured_at: '2020-01-01T00:00:00Z' }),
    });
    const newer = insertAsset(db, {
      exif: JSON.stringify({ captured_at: '2026-01-01T00:00:00Z' }),
    });
    insertLocation(db, { assetId: older, libraryId, path: '', filename: 'old.dng' });
    insertLocation(db, { assetId: newer, libraryId, path: '', filename: 'new.dng' });
    run(db, `UPDATE assets SET mtime = 1700000000123`);

    const items = await findListItems({}, 10, testSqliteDb(db));
    expect(items.map((i) => i.id)).toEqual([newer, older]);
    expect(items[0]!.mtime).toBe(1_700_000_000);
    expect(items[0]!.filename).toBe('new.dng');
    expect(items[0]!.abs_path).toBe('/libraries/main/new.dng');
  });

  test('excludes soft-deleted assets unless liveOnly is explicitly false', async () => {
    using handle = await createTestDatabase();
    const { db } = handle;
    const sql = testSqliteDb(db);
    const libraryId = insertFolder(db);
    const live = insertAsset(db);
    const trashed = insertAsset(db, { deletedAt: '2026-04-01T00:00:00Z' });
    insertLocation(db, { assetId: live, libraryId, filename: 'live.dng' });
    insertLocation(db, { assetId: trashed, libraryId, filename: 'trashed.dng' });

    expect((await findListItems({}, 10, sql)).map((i) => i.id)).toEqual([live]);
    expect((await findListItems({ liveOnly: false }, 10, sql)).map((i) => i.id).sort()).toEqual(
      [live, trashed].sort(),
    );
  });

  test('applies the has_xmp, rating and captured_after residuals', async () => {
    using handle = await createTestDatabase();
    const { db } = handle;
    const sql = testSqliteDb(db);
    const libraryId = insertFolder(db);
    const keep = insertAsset(db, { exif: JSON.stringify({ captured_at: '2026-06-01T00:00:00Z' }) });
    const drop = insertAsset(db, { exif: JSON.stringify({ captured_at: '2020-06-01T00:00:00Z' }) });
    insertLocation(db, { assetId: keep, libraryId, filename: 'keep.dng' });
    insertLocation(db, { assetId: drop, libraryId, filename: 'drop.dng' });
    run(db, `UPDATE assets SET has_xmp = 1, rating = 5 WHERE id = ?`, keep);

    expect((await findListItems({ hasXmp: true }, 10, sql)).map((i) => i.id)).toEqual([keep]);
    expect((await findListItems({ ratingGte: 3 }, 10, sql)).map((i) => i.id)).toEqual([keep]);
    expect(
      (await findListItems({ capturedAfterIso: '2025-01-01T00:00:00Z' }, 10, sql)).map((i) => i.id),
    ).toEqual([keep]);
    expect((await findListItems({ hasXmp: false }, 10, sql)).map((i) => i.id)).toEqual([drop]);
  });

  test('clamps the limit, and treats a non-finite limit as the default', async () => {
    using handle = await createTestDatabase();
    const { db } = handle;
    const sql = testSqliteDb(db);
    const libraryId = insertFolder(db);
    for (let i = 0; i < 3; i += 1) {
      const assetId = insertAsset(db);
      insertLocation(db, { assetId, libraryId, filename: `a${i}.dng` });
    }
    expect(await findListItems({}, 2, sql)).toHaveLength(2);
    expect(await findListItems({}, Number.NaN, sql)).toHaveLength(3);
    expect(await findListItems({}, -5, sql)).toHaveLength(3);
  });

  test('returns only the columns the list DTO declares', async () => {
    using handle = await createTestDatabase();
    const { db } = handle;
    const libraryId = insertFolder(db);
    const assetId = insertAsset(db);
    insertLocation(db, { assetId, libraryId, filename: 'a.dng' });
    // The payloads a grid page must never drag along.
    insertDetail(db, assetId, {
      vision: JSON.stringify({ caption: 'x'.repeat(4000) }),
      transcript: JSON.stringify({
        text: 'y'.repeat(4000),
        language: 'en',
        model: 'whisper',
        duration_sec: 1,
        generated_at: '2026-01-01T00:00:00Z',
      }),
    });

    const [item] = await findListItems({}, 10, testSqliteDb(db));
    expect(Object.keys(item!).sort()).toEqual(
      [
        'abs_path',
        'fileinfo',
        'filename',
        'folder_id',
        'has_xmp',
        'hidden',
        'hidden_ack',
        'hidden_reason',
        'id',
        'mtime',
        'rating',
      ].sort(),
    );
    expect(JSON.stringify(item).length).toBeLessThan(1000);
  });
});

describe('backup-sidecar lookups', () => {
  test('resolves by maple_id when the asset has a live location in the library', async () => {
    using handle = await createTestDatabase();
    const { db } = handle;
    const libraryId = insertFolder(db);
    const assetId = insertAsset(db);
    insertLocation(db, { assetId, libraryId, filename: 'a.dng' });
    run(db, `UPDATE assets SET maple_id = 'content-1' WHERE id = ?`, assetId);

    const found = await findLiveAssetIdByMapleId('content-1', oid(libraryId), testSqliteDb(db));
    expect(found?.toHexString()).toBe(assetId);
  });

  test('misses when every location in that library is soft-deleted', async () => {
    using handle = await createTestDatabase();
    const { db } = handle;
    const libraryId = insertFolder(db);
    const assetId = insertAsset(db);
    insertLocation(db, {
      assetId,
      libraryId,
      filename: 'a.dng',
      deletedAt: '2026-04-01T00:00:00Z',
    });
    run(db, `UPDATE assets SET maple_id = 'content-1' WHERE id = ?`, assetId);

    expect(
      await findLiveAssetIdByMapleId('content-1', oid(libraryId), testSqliteDb(db)),
    ).toBeNull();
  });

  test('resolves by (device, phasset local id)', async () => {
    using handle = await createTestDatabase();
    const { db } = handle;
    const libraryId = insertFolder(db);
    const assetId = insertAsset(db);
    insertLocation(db, { assetId, libraryId, filename: 'a.dng' });
    insertPhassetLink(db, { assetId, deviceId: 'device-a', phassetLocalId: 'local-1' });

    const found = await findLiveAssetIdByPhassetLink(
      'device-a',
      'local-1',
      oid(libraryId),
      testSqliteDb(db),
    );
    expect(found?.toHexString()).toBe(assetId);
  });

  test('is scoped to the library the sidecar is being written into', async () => {
    using handle = await createTestDatabase();
    const { db } = handle;
    const libraryA = insertFolder(db, { path: '/libraries/a', slug: 'a' });
    const libraryB = insertFolder(db, { path: '/libraries/b', slug: 'b' });
    const assetId = insertAsset(db);
    insertLocation(db, { assetId, libraryId: libraryA, filename: 'a.dng' });
    insertPhassetLink(db, { assetId, deviceId: 'device-a', phassetLocalId: 'local-1' });

    expect(
      await findLiveAssetIdByPhassetLink('device-a', 'local-1', oid(libraryB), testSqliteDb(db)),
    ).toBeNull();
  });
});
