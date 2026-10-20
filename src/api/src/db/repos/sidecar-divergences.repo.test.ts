import { expect, test } from 'bun:test';
import { ObjectId } from '../object-id.ts';
import {
  createLiveTestDatabase,
  insertAsset,
  insertFolder,
  insertLocation,
} from '../sqlite/test-sqlite.test-helpers.ts';
import { mergeIntoSurvivor } from './assets.merge.ts';
import { hasSidecarDivergence, recordSidecarDivergence } from './sidecar-divergences.repo.ts';

test('merging duplicate assets keeps the condemned asset’s displaced sidecar versions (#5023)', async () => {
  using live = await createLiveTestDatabase();
  const libraryId = insertFolder(live.db, { path: '/photos' });
  const survivor = insertAsset(live.db);
  const condemned = insertAsset(live.db);
  insertLocation(live.db, { assetId: survivor, libraryId, ordinal: 0 });
  insertLocation(live.db, { assetId: condemned, libraryId, ordinal: 0, filename: 'dup.dng' });
  await recordSidecarDivergence(
    {
      assetId: new ObjectId(condemned),
      libraryId: new ObjectId(libraryId),
      sidecarRelPath: 'dup.dng.xmp',
      deviceId: 'd',
      baseSha256: null,
      displacedSha256: 'displaced',
      displacedXmp: '<x:displaced/>',
      incomingSha256: 'incoming',
    },
    live.handle,
  );

  await mergeIntoSurvivor({
    survivorId: survivor,
    condemnedId: condemned,
    mapleId: 'merged-photo',
    dbOverride: live.handle,
  });

  expect(live.db.query(`SELECT asset_id, displaced_xmp FROM sidecar_divergences`).all()).toEqual([
    { asset_id: survivor, displaced_xmp: '<x:displaced/>' },
  ]);
});

test('a version kept aside in one library does not count for the same path in another (#5021)', async () => {
  using live = await createLiveTestDatabase();
  const libraryA = insertFolder(live.db, { path: '/a' });
  const libraryB = insertFolder(live.db, { path: '/b' });
  const asset = insertAsset(live.db);
  await recordSidecarDivergence(
    {
      assetId: new ObjectId(asset),
      libraryId: new ObjectId(libraryA),
      sidecarRelPath: '2024/IMG.xmp',
      deviceId: 'd',
      baseSha256: null,
      displacedSha256: 'legacy',
      displacedXmp: '<x:legacy/>',
      incomingSha256: 'incoming',
    },
    live.handle,
  );
  const query = {
    assetId: new ObjectId(asset),
    sidecarRelPath: '2024/IMG.xmp',
    displacedSha256: 'legacy',
  };

  expect(
    await hasSidecarDivergence({ ...query, libraryId: new ObjectId(libraryA) }, live.handle),
  ).toBe(true);
  expect(
    await hasSidecarDivergence({ ...query, libraryId: new ObjectId(libraryB) }, live.handle),
  ).toBe(false);
});
