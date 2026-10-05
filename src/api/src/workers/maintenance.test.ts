import { expect, spyOn, test } from 'bun:test';
import * as trashGc from './trash-gc.ts';
import * as changeLogGc from './change-log-gc.ts';
import * as missingReaper from './missing-reaper.ts';
import * as migration from './migration.ts';
import * as deduplicate from './dedupe.ts';
import * as mirrorScan from './mirror/scan.ts';
import * as mirrorCopy from './mirror/copy.ts';
import * as derivativeAudit from './derivative-audit/scan.ts';
import * as generatedSearch from './generated-search/run.ts';
import { startMaintenanceJobs, stopMaintenanceJobs } from './maintenance.ts';
import { stopWorkers } from './start-workers.ts';
import { backupEngine } from '../cloud-backup/runtime.ts';
import { preparePurge } from '../cloud-backup/lifecycle.ts';
import { recoveryFixture } from '../cloud-backup/restore.test-helpers.ts';
import * as inventory from '../cloud-backup/inventory.ts';
import { drainPurges } from '../cloud-backup/purge.ts';
import { mkdir, readFile, writeFile } from '../fs/mirrored.ts';
import * as path from 'node:path';
import {
  insertAsset,
  insertFolder,
  insertLocation,
} from '../db/sqlite/test-sqlite.test-helpers.ts';

function isolateOtherMaintenance() {
  const handle = { stop() {}, ready: Promise.resolve() };
  const spies = [
    spyOn(trashGc, 'startTrashGc').mockReturnValue(handle),
    spyOn(changeLogGc, 'startChangeLogGc').mockReturnValue(handle),
    spyOn(missingReaper, 'startMissingReaper').mockReturnValue(handle),
    spyOn(migration, 'startMigration').mockReturnValue(handle),
    spyOn(deduplicate, 'startDeDuplicate').mockReturnValue(handle),
    spyOn(mirrorScan, 'startMirrorScan').mockReturnValue(handle),
    spyOn(mirrorCopy, 'startMirrorCopyWorker').mockReturnValue(handle),
    spyOn(derivativeAudit, 'startDerivativeAudit').mockReturnValue(handle),
    spyOn(generatedSearch, 'startGeneratedSearch').mockReturnValue(handle),
  ];
  return () => {
    for (const spy of spies) spy.mockRestore();
  };
}

test('maintenance cancellation after local byte verification preserves the file and its pending purge', async () => {
  const f = await recoveryFixture();
  const controller = new AbortController();
  const fileHash = inventory.fileHash;
  const hashSpy = spyOn(inventory, 'fileHash').mockImplementation(async (file) => {
    const digest = await fileHash(file);
    controller.abort(new Error('Shutdown after verification'));
    return digest;
  });
  try {
    const mirror = path.join(f.root, 'mirror');
    await mkdir(mirror);
    const filename = path.join(mirror, 'photo.jpg');
    await writeFile(filename, 'original-photo-bytes');
    const sha256 = await fileHash(filename);
    const libraryId = insertFolder(f.live.db, { path: f.root });
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

test('worker shutdown aborts the deferred remote purge and awaits its cleanup before SQLite closes; a restart gets a fresh tick', async () => {
  const f = await recoveryFixture();
  const restoreOtherMaintenance = isolateOtherMaintenance();
  const providerSpy = spyOn(backupEngine, 'provider').mockResolvedValue(f.provider);
  const entered = Promise.withResolvers<AbortSignal>();
  const aborted = Promise.withResolvers<void>();
  const releaseCleanup = Promise.withResolvers<void>();
  let shutdown: Promise<void> | undefined;
  let shutdownSettled = false;
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
      // cancellation. Shutdown must await this rather than just fire abort().
      await releaseCleanup.promise;
      signal.throwIfAborted();
      return null;
    },
  );
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
    startMaintenanceJobs();
    startMaintenanceJobs(); // Idempotent while a request is active.
    const firstSignal = await entered.promise;
    shutdown = stopWorkers().then(() => {
      shutdownSettled = true;
    });
    await aborted.promise;
    await Promise.resolve();
    expect(firstSignal.aborted).toBe(true);
    expect(shutdownSettled).toBe(false);
    expect(providerSpy).toHaveBeenCalledTimes(1);
    expect(f.live.db.query('SELECT completed,last_error FROM backup_purges').get()).toEqual({
      completed: 0,
      last_error: null,
    });
    releaseCleanup.resolve();
    await shutdown;
    expect(shutdownSettled).toBe(true);
    expect(
      f.live.db.query('SELECT completed,published,last_error FROM backup_purges').get(),
    ).toEqual({
      completed: 0,
      published: 0,
      last_error: null,
    });
    expect(f.live.db.query('SELECT COUNT(*) AS n FROM backup_objects').get()).toEqual({ n: 0 });

    const restarted = Promise.withResolvers<AbortSignal>();
    inspect.mockImplementation(async (_key: string, signal?: AbortSignal) => {
      if (!signal) throw new Error('Restart must supply a cancellation signal');
      restarted.resolve(signal);
      await new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true }),
      );
      signal.throwIfAborted();
      return null;
    });
    startMaintenanceJobs();
    const nextSignal = await restarted.promise;
    expect(nextSignal).not.toBe(firstSignal);
    expect(nextSignal.aborted).toBe(false);
    await stopMaintenanceJobs();
    expect(nextSignal.aborted).toBe(true);
    expect(providerSpy).toHaveBeenCalledTimes(2);
    expect(f.live.db.query('SELECT completed FROM backup_purges').get()).toEqual({ completed: 0 });
    // The actual worker entry point closes its pool only after stopWorkers.
    // Fixture cleanup below now closes real SQLite after both tasks drained.
  } finally {
    releaseCleanup.resolve();
    await shutdown;
    await stopMaintenanceJobs();
    inspect.mockRestore();
    providerSpy.mockRestore();
    restoreOtherMaintenance();
    await f.close();
  }
});
