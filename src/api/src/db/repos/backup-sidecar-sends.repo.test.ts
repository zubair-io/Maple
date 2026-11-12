import { expect, test } from 'bun:test';
import { ObjectId } from '../object-id.ts';
import {
  createLiveTestDatabase,
  insertAsset,
  insertFolder,
  insertLocation,
} from '../sqlite/test-sqlite.test-helpers.ts';
import { mergeIntoSurvivor } from './assets.merge.ts';
import { recordBackupSidecarSends, sentCheckpointOf } from './backup-sidecar-sends.repo.ts';

test('a sidecar keeps the sent checkpoints its history still holds, and only its own', async () => {
  using live = await createLiveTestDatabase();
  const libraryId = new ObjectId(insertFolder(live.db, { path: '/photos' }));
  const assetId = new ObjectId(insertAsset(live.db));
  const sidecar = { assetId, libraryId, sidecarRelPath: 'IMG.xmp' };
  const other = { ...sidecar, sidecarRelPath: 'OTHER.xmp' };
  const sent = (entryId: string) => ({ entryId, checkpoint: `<x:${entryId}/>` });

  await recordBackupSidecarSends(sidecar, { retained: [], sent: sent('a') }, live.handle);
  await recordBackupSidecarSends(other, { retained: [], sent: sent('a') }, live.handle);
  await recordBackupSidecarSends(sidecar, { retained: ['a', 'b'], sent: sent('b') }, live.handle);
  expect(await sentCheckpointOf(sidecar, 'a', live.handle)).toBe('<x:a/>');
  expect(await sentCheckpointOf(sidecar, 'b', live.handle)).toBe('<x:b/>');

  // History compaction retired `a`; the next send drops its row, not the other sidecar's.
  await recordBackupSidecarSends(sidecar, { retained: ['b', 'c'], sent: null }, live.handle);
  expect(await sentCheckpointOf(sidecar, 'a', live.handle)).toBeNull();
  expect(await sentCheckpointOf(sidecar, 'b', live.handle)).toBe('<x:b/>');
  expect(await sentCheckpointOf(other, 'a', live.handle)).toBe('<x:a/>');
});

test("merging duplicate assets keeps the condemned asset's sent checkpoints", async () => {
  using live = await createLiveTestDatabase();
  const libraryId = insertFolder(live.db, { path: '/photos' });
  const survivor = insertAsset(live.db);
  const condemned = insertAsset(live.db);
  insertLocation(live.db, { assetId: survivor, libraryId, ordinal: 0 });
  insertLocation(live.db, { assetId: condemned, libraryId, ordinal: 0, filename: 'dup.dng' });
  const sidecar = {
    assetId: new ObjectId(condemned),
    libraryId: new ObjectId(libraryId),
    sidecarRelPath: 'dup.xmp',
  };
  await recordBackupSidecarSends(
    sidecar,
    { retained: [], sent: { entryId: 'e', checkpoint: '<x:sent/>' } },
    live.handle,
  );

  await mergeIntoSurvivor({
    survivorId: survivor,
    condemnedId: condemned,
    mapleId: 'merged-photo',
    dbOverride: live.handle,
  });

  expect(live.db.query(`SELECT asset_id, sent_checkpoint FROM backup_sidecar_sends`).all()).toEqual(
    [{ asset_id: survivor, sent_checkpoint: '<x:sent/>' }],
  );
});
