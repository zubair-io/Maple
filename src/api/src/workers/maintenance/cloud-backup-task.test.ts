import { expect, spyOn, test } from 'bun:test';
import * as path from 'node:path';
import { backupEngine } from '../../cloud-backup/runtime.ts';
import { preparePurge } from '../../cloud-backup/lifecycle.ts';
import { recoveryFixture } from '../../cloud-backup/restore.test-helpers.ts';
import * as inventory from '../../cloud-backup/inventory.ts';
import { drainPurges } from '../../cloud-backup/purge.ts';
import { mkdir, readFile, writeFile } from '../../fs/mirrored.ts';
import {
  insertAsset,
  insertFolder,
  insertLocation,
} from '../../db/sqlite/test-sqlite.test-helpers.ts';
import { MAINTENANCE_TASKS } from './tasks.ts';

const cloudBackup = MAINTENANCE_TASKS.find((task) => task.id === 'cloud-backup')!;

test('maintenance cancellation after local byte verification preserves the file and its pending purge', async () => {
  const f = await recoveryFixture();
  const controller = new AbortController();
  const fileHash = inventory.fileHash;
  let draining = false;
  const hashSpy = spyOn(inventory, 'fileHash').mockImplementation(async (file) => {
    const digest = await fileHash(file);
    if (draining) controller.abort(new Error('Shutdown after verification'));
    return digest;
  });
  try {
    const mirror = path.join(f.root, 'mirror');
    const library = path.join(f.root, 'library');
    await mkdir(mirror);
    await mkdir(library);
    const filename = path.join(mirror, 'photo.jpg');
    await writeFile(filename, 'original-photo-bytes');
    const sha256 = await fileHash(filename);
    const libraryId = insertFolder(f.live.db, { path: library });
    const assetId = insertAsset(f.live.db);
    insertLocation(f.live.db, { libraryId, assetId });
    const destination = await backupEngine.repo.createDestination({
      libraryId,
      kind: 'folder',
      name: 'Local mirror',
      path: mirror,
    });
    const entry = await backupEngine.repo.ensureEntry(destination.id, assetId, 0, 'photo.jpg');
    await backupEngine.repo.db.write('UPDATE backup_entries SET manifest=? WHERE id=?', [
      JSON.stringify({ localFiles: [{ path: 'photo.jpg', sha256 }] }),
      entry.id,
    ]);
    await preparePurge(assetId, backupEngine.repo);
    draining = true;
    await expect(drainPurges(backupEngine, destination, controller.signal)).rejects.toThrow(
      'Shutdown after verification',
    );
    expect(await readFile(filename, 'utf8')).toBe('original-photo-bytes');
    expect(f.live.db.query('SELECT completed,last_error FROM backup_purges').get()).toEqual({
      completed: 0,
      last_error: null,
    });
  } finally {
    hashSpy.mockRestore();
    await f.close();
  }
});

test('aborting a cloud-backup pass aborts its deferred remote purge, and the pass ends only after that request has cleaned up', async () => {
  const f = await recoveryFixture();
  const providerSpy = spyOn(backupEngine, 'provider').mockResolvedValue(f.provider);
  const entered = Promise.withResolvers<AbortSignal>();
  const aborted = Promise.withResolvers<void>();
  const releaseCleanup = Promise.withResolvers<void>();
  const inspect = spyOn(f.provider, 'inspect').mockImplementation(
    async (_key: string, signal?: AbortSignal) => {
      if (!signal) throw new Error('Maintenance request must receive a cancellation signal');
      entered.resolve(signal);
      await new Promise<void>((resolve) => {
        signal.addEventListener(
          'abort',
          () => {
            aborted.resolve();
            resolve();
          },
          { once: true },
        );
      });
      // A network request can have asynchronous stream/socket cleanup after
      // cancellation. The pass must await this rather than just fire abort().
      await releaseCleanup.promise;
      signal.throwIfAborted();
      return null;
    },
  );
  const controller = new AbortController();
  let settled = false;
  try {
    const libraryId = insertFolder(f.live.db, { path: f.root });
    const assetId = insertAsset(f.live.db);
    insertLocation(f.live.db, { libraryId, assetId });
    const destination = await backupEngine.repo.createDestination({
      libraryId,
      kind: 'google-drive',
      name: 'Drive purge',
      path: null,
    });
    await backupEngine.repo.ensureEntry(destination.id, assetId, 0, 'photo.jpg');
    await preparePurge(assetId, backupEngine.repo);

    const pass = cloudBackup
      .run(controller.signal, {})
      .then(
        () => null,
        (error: unknown) => error,
      )
      .finally(() => {
        settled = true;
      });
    const signal = await entered.promise;
    controller.abort(new Error('Worker shutting down'));
    await aborted.promise;
    await Promise.resolve();

    expect(signal.aborted).toBe(true);
    expect(settled).toBe(false);
    expect(f.live.db.query('SELECT completed,last_error FROM backup_purges').get()).toEqual({
      completed: 0,
      last_error: null,
    });
    releaseCleanup.resolve();
    expect(await pass).toBeInstanceOf(Error);
    expect(
      f.live.db.query('SELECT completed,published,last_error FROM backup_purges').get(),
    ).toEqual({
      completed: 0,
      published: 0,
      last_error: null,
    });
    expect(f.live.db.query('SELECT COUNT(*) AS n FROM backup_objects').get()).toEqual({ n: 0 });
  } finally {
    controller.abort();
    releaseCleanup.resolve();
    inspect.mockRestore();
    providerSpy.mockRestore();
    await f.close();
  }
});
