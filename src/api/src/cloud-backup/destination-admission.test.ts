import { expect, test } from 'bun:test';
import {
  createLiveTestDatabase,
  insertAsset,
  insertFolder,
  insertLocation,
} from '../db/sqlite/test-sqlite.test-helpers.ts';
import { BackupRepository } from './repository.ts';

async function fixture() {
  const live = await createLiveTestDatabase();
  const libraryId = insertFolder(live.db);
  const assetId = insertAsset(live.db);
  insertLocation(live.db, { assetId, libraryId });
  const repo = new BackupRepository(live.handle);
  const destination = await repo.createDestination({
    libraryId,
    kind: 'google-drive',
    name: 'Archive',
    path: null,
  });
  await repo.updateDestination(destination.id, { enabled: true });
  return { live, repo, destination, assetId, [Symbol.dispose]: () => live[Symbol.dispose]() };
}

test('a watcher identity at a prepared restore target cannot admit or publish a backup', async () => {
  using f = await fixture();
  const entry = await f.repo.ensureEntry(f.destination.id, f.assetId, 0, 'photo.dng');
  expect(await f.repo.claim(entry, 'watcher-worker')).toBe(true);
  const canonical = insertAsset(f.live.db);
  await f.repo.db.write(
    `INSERT INTO backup_lifecycle(id,asset_id,library_id,source_path,target_path,kind,phase,created_at)
      VALUES(?,?,?,?,'photo.dng','restore','prepared',?)`,
    [
      crypto.randomUUID(),
      canonical,
      f.destination.libraryId,
      '.maple/trash/photo.dng',
      new Date().toISOString(),
    ],
  );
  const held = (await f.repo.entries(f.destination.id))[0]!;
  const destination = (await f.repo.destination(f.destination.id))!;
  expect(await f.repo.fence(held, destination, 'watcher-worker')).toBe(false);
  expect(
    await f.repo.finish(held, destination, 'watcher-worker', {
      version: 1,
      libraryId: destination.libraryId,
      entryId: entry.id,
      assetId: f.assetId,
      sequence: entry.sequence,
      currentPath: 'photo.dng',
      originalPath: 'photo.dng',
      state: 'active',
      deletedAt: null,
      hidden: false,
      files: [],
    }),
  ).toBe(false);
  await f.repo.db.write('UPDATE backup_entries SET lease_owner=NULL,lease_until=0 WHERE id=?', [
    entry.id,
  ]);
  expect(await f.repo.claim(entry, 'late-watcher-worker')).toBe(false);
  await f.repo.db.write('DELETE FROM backup_entries WHERE id=?', [entry.id]);
  await expect(f.repo.ensureEntry(f.destination.id, f.assetId, 0, 'photo.dng')).rejects.toThrow();
  // The canonical owner's source remains eligible after its move preparation.
  const own = await f.repo.ensureEntry(f.destination.id, canonical, 0, '.maple/trash/photo.dng');
  expect(own.asset_id).toBe(canonical);
});

test('a worker holding a removed destination cannot admit a new backup entry', async () => {
  using f = await fixture();
  await f.repo.db.write('DELETE FROM backup_destinations WHERE id=?', [f.destination.id]);
  await expect(f.repo.ensureEntry(f.destination.id, f.assetId, 0, 'photo.dng')).rejects.toThrow(
    'Backup destination or asset no longer exists',
  );
  expect(await f.repo.entries(f.destination.id)).toEqual([]);
});

for (const action of ['pause', 'remove'] as const) {
  test(`a worker cannot claim an existing entry after destination ${action}`, async () => {
    using f = await fixture();
    const entry = await f.repo.ensureEntry(f.destination.id, f.assetId, 0, 'photo.dng');
    if (action === 'pause') await f.repo.updateDestination(f.destination.id, { enabled: false });
    else await f.repo.db.write('DELETE FROM backup_destinations WHERE id=?', [f.destination.id]);
    expect(await f.repo.claim(entry, 'stale-worker')).toBe(false);
    expect((await f.repo.entries(f.destination.id))[0]).toEqual(entry);
  });
}
