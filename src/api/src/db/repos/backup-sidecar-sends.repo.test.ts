import { expect, test } from 'bun:test';
import type { SentRecord } from '../../backup/sidecar-history.ts';
import { ObjectId } from '../object-id.ts';
import {
  createLiveTestDatabase,
  insertAsset,
  insertFolder,
  insertLocation,
} from '../sqlite/test-sqlite.test-helpers.ts';
import { mergeIntoSurvivor } from './assets.merge.ts';
import { recordBackupSidecarSends, sentRecordsOf } from './backup-sidecar-sends.repo.ts';

const sent = (sha256: string, entryId: string): SentRecord => ({
  sha256,
  entryId,
  checkpoint: `<x:${sha256}/>`,
});

test("a single-location asset drops the sends its sidecar's history no longer holds", async () => {
  using live = await createLiveTestDatabase();
  const libraryId = insertFolder(live.db, { path: '/photos' });
  const asset = insertAsset(live.db);
  insertLocation(live.db, { assetId: asset, libraryId });
  const assetId = new ObjectId(asset);
  const record = (retained: string[], row: SentRecord | null) =>
    recordBackupSidecarSends(assetId, { retained, sent: row }, live.handle);

  await record(['', 'a'], sent('d1', 'a'));
  await record(['', 'a', 'b'], sent('d2', 'b'));
  expect(await sentRecordsOf(assetId, { sha256: 'd1' }, live.handle)).toEqual([sent('d1', 'a')]);
  expect(await sentRecordsOf(assetId, { entryId: 'b' }, live.handle)).toEqual([sent('d2', 'b')]);

  // History compaction retired `a`: no sidecar of the asset can name it again.
  await record(['', 'b', 'c'], null);
  expect(await sentRecordsOf(assetId, { sha256: 'd1' }, live.handle)).toEqual([]);
  expect(await sentRecordsOf(assetId, { sha256: 'd2' }, live.handle)).toEqual([sent('d2', 'b')]);
});

test('an asset with another copy, even a trashed one, keeps every send', async () => {
  using live = await createLiveTestDatabase();
  const libraryId = insertFolder(live.db, { path: '/photos' });
  const asset = insertAsset(live.db);
  insertLocation(live.db, { assetId: asset, libraryId, filename: 'a.dng' });
  insertLocation(live.db, {
    assetId: asset,
    libraryId,
    ordinal: 1,
    filename: 'b.dng',
    deletedAt: '2026-11-01T00:00:00Z',
  });
  const assetId = new ObjectId(asset);

  await recordBackupSidecarSends(assetId, { retained: [''], sent: sent('d1', 'a') }, live.handle);
  await recordBackupSidecarSends(assetId, { retained: [''], sent: null }, live.handle);
  expect(await sentRecordsOf(assetId, { sha256: 'd1' }, live.handle)).toEqual([sent('d1', 'a')]);
});

test("merging duplicate assets keeps the condemned asset's sends", async () => {
  using live = await createLiveTestDatabase();
  const libraryId = insertFolder(live.db, { path: '/photos' });
  const survivor = insertAsset(live.db);
  const condemned = insertAsset(live.db);
  insertLocation(live.db, { assetId: survivor, libraryId, ordinal: 0 });
  insertLocation(live.db, { assetId: condemned, libraryId, ordinal: 0, filename: 'dup.dng' });
  // The same send kept for both: the merge must not collide on it.
  for (const asset of [condemned, survivor]) {
    const row = { retained: [''], sent: sent('d1', 'e') };
    await recordBackupSidecarSends(new ObjectId(asset), row, live.handle);
  }
  const extra = { retained: ['', 'e'], sent: sent('d2', 'f') };
  await recordBackupSidecarSends(new ObjectId(condemned), extra, live.handle);

  await mergeIntoSurvivor({
    survivorId: survivor,
    condemnedId: condemned,
    mapleId: 'merged-photo',
    dbOverride: live.handle,
  });

  const rows = live.db
    .query(`SELECT asset_id, sent_sha256 FROM backup_sidecar_sends ORDER BY sent_sha256`)
    .all();
  expect(rows).toEqual([
    { asset_id: survivor, sent_sha256: 'd1' },
    { asset_id: survivor, sent_sha256: 'd2' },
  ]);
});
