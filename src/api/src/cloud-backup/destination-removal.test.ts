import { expect, test } from 'bun:test';
import {
  createLiveTestDatabase,
  insertAsset,
  insertFolder,
  insertLocation,
} from '../db/sqlite/test-sqlite.test-helpers.ts';
import { BackupRepository } from './repository.ts';
import { replaceFolderDestinations } from './local-mirror-bridge.ts';

for (const completed of [0, 1]) {
  test(`legacy mirror removal ${completed ? 'cleans idle local state' : 'preserves pending cleanup atomically'}`, async () => {
    using live = await createLiveTestDatabase();
    const libraryId = insertFolder(live.db);
    const assetId = insertAsset(live.db);
    insertLocation(live.db, { assetId, libraryId });
    const repo = new BackupRepository(live.handle);
    const destination = await repo.createDestination({
      libraryId,
      kind: 'folder',
      name: 'Archive',
      path: '/backups/archive',
    });
    const entry = await repo.ensureEntry(destination.id, assetId, 0, 'photo.dng');
    await repo.saveObject(destination.id, entry.id, 'blobs/photo', null, {
      provider: 'google-drive',
      version: 1,
      state: { fileId: 'reservation', offset: 1024 },
    });
    await repo.db.write(
      'INSERT INTO backup_purges(destination_id,entry_id,record,completed) VALUES(?,?,?,?)',
      [destination.id, entry.id, JSON.stringify({ entryId: entry.id }), completed],
    );
    if (completed) {
      await replaceFolderDestinations(libraryId, [], repo);
      expect(await repo.destination(destination.id)).toBeNull();
      expect(await repo.entries(destination.id)).toEqual([]);
      expect(await repo.purges(destination.id)).toEqual([]);
      expect(await repo.object(destination.id, 'blobs/photo')).toEqual({
        object: null,
        checkpoint: null,
      });
    } else {
      await expect(replaceFolderDestinations(libraryId, [], repo)).rejects.toThrow(
        'pending cleanup',
      );
      expect(await repo.destination(destination.id)).not.toBeNull();
      expect(await repo.entries(destination.id)).toEqual([entry]);
      expect(await repo.purges(destination.id)).toHaveLength(1);
      expect((await repo.object(destination.id, 'blobs/photo')).checkpoint).not.toBeNull();
    }
    expect(live.db.query('SELECT id FROM assets WHERE id=?').get(assetId)).toEqual({ id: assetId });
  });
}
