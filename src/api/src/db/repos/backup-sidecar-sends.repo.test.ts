import { expect, test } from 'bun:test';
import { ObjectId } from '../object-id.ts';
import {
  createLiveTestDatabase,
  insertAsset,
  insertFolder,
  insertLocation,
} from '../sqlite/test-sqlite.test-helpers.ts';
import { mergeIntoSurvivor } from './assets.merge.ts';
import type { SentRecord } from '../../backup/sidecar-history.ts';
import {
  recordBackupSidecarSends,
  sentRecordsOf,
  type BackupSidecarKey,
} from './backup-sidecar-sends.repo.ts';

const sent = (sha256: string, entryId: string): SentRecord => ({
  sha256,
  entryId,
  checkpoint: `<x:${sha256}/>`,
});

test('a sidecar keeps the sends its history still holds, and only its own', async () => {
  using live = await createLiveTestDatabase();
  const libraryId = new ObjectId(insertFolder(live.db, { path: '/photos' }));
  const assetId = new ObjectId(insertAsset(live.db));
  const sidecar = { assetId, libraryId, sidecarRelPath: 'IMG.xmp' };
  const other = { ...sidecar, sidecarRelPath: 'OTHER.xmp' };
  const record = (key: BackupSidecarKey, retained: string[], row: SentRecord | null) =>
    recordBackupSidecarSends(key, { retained, sent: row }, live.handle);

  await record(sidecar, ['', 'a'], sent('d1', 'a'));
  await record(other, ['', 'x'], sent('d9', 'x'));
  await record(sidecar, ['', 'a', 'b'], sent('d2', 'b'));
  expect(await sentRecordsOf(assetId, { sha256: 'd1' }, live.handle)).toEqual([sent('d1', 'a')]);
  expect(await sentRecordsOf(assetId, { entryId: 'b' }, live.handle)).toEqual([sent('d2', 'b')]);

  // History compaction retired `a`; the next send drops its row, not the other sidecar's.
  await record(sidecar, ['', 'b', 'c'], null);
  expect(await sentRecordsOf(assetId, { sha256: 'd1' }, live.handle)).toEqual([]);
  expect(await sentRecordsOf(assetId, { sha256: 'd2' }, live.handle)).toEqual([sent('d2', 'b')]);
  expect(await sentRecordsOf(assetId, { sha256: 'd9' }, live.handle)).toEqual([sent('d9', 'x')]);
});

test('a moved sidecar adopts the sends of the entries its history holds', async () => {
  using live = await createLiveTestDatabase();
  const libraryId = new ObjectId(insertFolder(live.db, { path: '/photos' }));
  const assetId = new ObjectId(insertAsset(live.db));
  const before = { assetId, libraryId, sidecarRelPath: 'a/IMG.xmp' };
  const after = { ...before, sidecarRelPath: 'b/IMG.xmp' };
  await recordBackupSidecarSends(
    before,
    { retained: ['', 'a'], sent: sent('d1', 'a') },
    live.handle,
  );

  expect(await sentRecordsOf(assetId, { sha256: 'd1' }, live.handle)).toEqual([sent('d1', 'a')]);
  await recordBackupSidecarSends(after, { retained: ['', 'a', 'b'], sent: null }, live.handle);
  // Adopted: a later send to the old path no longer prunes it.
  await recordBackupSidecarSends(before, { retained: [''], sent: null }, live.handle);
  expect(await sentRecordsOf(assetId, { sha256: 'd1' }, live.handle)).toEqual([sent('d1', 'a')]);
});

test("merging duplicate assets keeps the condemned asset's sends", async () => {
  using live = await createLiveTestDatabase();
  const libraryId = insertFolder(live.db, { path: '/photos' });
  const survivor = insertAsset(live.db);
  const condemned = insertAsset(live.db);
  insertLocation(live.db, { assetId: survivor, libraryId, ordinal: 0 });
  insertLocation(live.db, { assetId: condemned, libraryId, ordinal: 0, filename: 'dup.dng' });
  const key = (assetId: string, sidecarRelPath: string) => ({
    assetId: new ObjectId(assetId),
    libraryId: new ObjectId(libraryId),
    sidecarRelPath,
  });
  // The same send kept for both: the merge must not collide on it.
  for (const [assetId, file] of [
    [condemned, 'dup.xmp'],
    [survivor, 'IMG.xmp'],
  ] as const) {
    await recordBackupSidecarSends(
      key(assetId, file),
      { retained: [''], sent: sent('d1', 'e') },
      live.handle,
    );
  }
  await recordBackupSidecarSends(
    key(condemned, 'dup.xmp'),
    { retained: ['', 'e'], sent: sent('d2', 'f') },
    live.handle,
  );

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
