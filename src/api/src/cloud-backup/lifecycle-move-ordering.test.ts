import { expect, test, spyOn } from 'bun:test';
import * as fs from '../fs/mirrored.ts';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  createLiveTestDatabase,
  insertAsset,
  insertFolder,
  insertLocation,
} from '../db/sqlite/test-sqlite.test-helpers.ts';
import { BackupRepository } from './repository.ts';
import { ObjectId } from '../db/object-id.ts';
import * as assetsRepo from '../db/repos/assets.repo.ts';
import { trashAssetById, restoreAssetById } from '../library/asset-trash.ts';
import { moveToTrash } from '../fs/trash.ts';
import {
  prepareLifecycle,
  recordLifecycleTarget,
  runLifecycleMove,
  lifecycleCommit,
  fenceLifecycleMove,
  reconcileLifecycle,
} from './lifecycle.ts';
import { reconcileInChild } from './lifecycle-process.test-helpers.ts';

async function fixture(trashed = false) {
  const live = await createLiveTestDatabase('file');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-owned-move-'));
  const libraryId = insertFolder(live.db, { path: root });
  const assetId = insertAsset(live.db, trashed ? { deletedAt: new Date().toISOString() } : {});
  const directory = trashed ? '.maple/trash' : '';
  insertLocation(live.db, { assetId, libraryId, path: directory, filename: 'photo.dng' });
  if (trashed)
    live.db.run('UPDATE assets SET original_path=? WHERE id=?', [
      path.join(root, 'photo.dng'),
      assetId,
    ]);
  const source = path.join(root, directory, 'photo.dng');
  await fs.mkdir(path.dirname(source), { recursive: true });
  await fs.writeFile(source, 'immutable original');
  const sidecar = path.join(path.dirname(source), 'photo.xmp');
  await fs.writeFile(sidecar, '<x:xmpmeta>exact source edit</x:xmpmeta>');
  const repo = new BackupRepository(live.handle);
  const destination = await repo.createDestination({
    libraryId,
    kind: 'google-drive',
    name: 'Drive',
    path: null,
  });
  const entry = await repo.ensureEntry(
    destination.id,
    assetId,
    0,
    path.posix.join(directory, 'photo.dng'),
  );
  return {
    live,
    root,
    libraryId,
    assetId,
    source,
    sidecar,
    repo,
    destination,
    entry,
    async close() {
      live.close();
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

test('expired API owner cannot unlink original or sidecar after another process cancels its preparation', async () => {
  const f = await fixture();
  try {
    const intent = await prepareLifecycle(f.assetId, 'trash', f.libraryId, 'photo.dng', f.repo);
    const result = await runLifecycleMove(intent, () =>
      moveToTrash(
        f.source,
        f.root,
        (target) => recordLifecycleTarget(intent, f.root, f.source, target, f.repo),
        async () => {
          f.live.db.run('UPDATE backup_lifecycle SET lease_until=0 WHERE id=?', [intent]);
          await reconcileInChild(f.live.path);
          await fenceLifecycleMove(intent);
        },
      ),
    );
    expect(result.kind).toBe('error');
    expect(await fs.readFile(f.source, 'utf8')).toBe('immutable original');
    expect(await fs.readFile(f.sidecar, 'utf8')).toBe('<x:xmpmeta>exact source edit</x:xmpmeta>');
    expect(await fs.stat(path.join(f.root, '.maple/trash/photo.dng')).catch(() => null)).toBeNull();
    expect(f.live.db.query('SELECT phase FROM backup_lifecycle WHERE id=?').get(intent)).toEqual({
      phase: 'cancelled',
    });
    expect(
      f.live.db.query('SELECT path FROM asset_locations WHERE asset_id=?').get(f.assetId),
    ).toEqual({ path: '' });
  } finally {
    await f.close();
  }
});

test('stale and missing lifecycle commit tokens roll back the complete asset transaction', async () => {
  const f = await fixture();
  try {
    const intent = await prepareLifecycle(f.assetId, 'trash', f.libraryId, 'photo.dng', f.repo);
    await runLifecycleMove(intent, async () => {
      const token = await lifecycleCommit(intent);
      f.live.db.run('UPDATE backup_lifecycle SET lease_until=0 WHERE id=?', [intent]);
      await reconcileInChild(f.live.path);
      for (const lifecycle of [token, { ...token, id: crypto.randomUUID() }]) {
        await expect(
          assetsRepo.markSoftDeleted({
            id: new ObjectId(f.assetId),
            libraryId: new ObjectId(f.libraryId),
            libraryRoot: f.root,
            newAbsPath: path.join(f.root, '.maple/trash/photo.dng'),
            originalAbsPath: f.source,
            source: { libraryId: new ObjectId(f.libraryId), path: '', filename: 'photo.dng' },
            lifecycle,
          }),
        ).rejects.toThrow();
      }
    });
    expect(f.live.db.query('SELECT deleted_at FROM assets WHERE id=?').get(f.assetId)).toEqual({
      deleted_at: null,
    });
    expect(
      f.live.db.query('SELECT path FROM asset_locations WHERE asset_id=?').get(f.assetId),
    ).toEqual({ path: '' });
    expect(
      f.live.db
        .query("SELECT name FROM sqlite_temp_master WHERE name='backup_lifecycle_commit_assert'")
        .get(),
    ).toBeNull();
    expect(await fs.readFile(f.source, 'utf8')).toBe('immutable original');
  } finally {
    await f.close();
  }
});

test('failed Trash DB commit reverts published files, retains the whole source pair and releases recovery lease', async () => {
  const f = await fixture();
  try {
    f.live.db.exec(
      "CREATE TRIGGER fail_owned_trash BEFORE UPDATE OF deleted_at ON assets WHEN NEW.deleted_at IS NOT NULL BEGIN SELECT RAISE(ABORT,'commit interrupted'); END",
    );
    expect((await trashAssetById(new ObjectId(f.assetId))).kind).toBe('error');
    expect(await fs.readFile(f.source, 'utf8')).toBe('immutable original');
    expect(await fs.readFile(f.sidecar, 'utf8')).toBe('<x:xmpmeta>exact source edit</x:xmpmeta>');
    expect(await fs.stat(path.join(f.root, '.maple/trash/photo.dng')).catch(() => null)).toBeNull();
    expect(
      f.live.db
        .query('SELECT phase,lease_owner,lease_until FROM backup_lifecycle WHERE asset_id=?')
        .get(f.assetId),
    ).toEqual({ phase: 'prepared', lease_owner: null, lease_until: 0 });
    await reconcileLifecycle(f.repo);
    expect(
      f.live.db.query('SELECT phase FROM backup_lifecycle WHERE asset_id=?').get(f.assetId),
    ).toEqual({ phase: 'cancelled' });
  } finally {
    await f.close();
  }
});

test('restore late backed watcher collision retains Trash pair, then retries a DB-only occupied name with a suffix', async () => {
  const f = await fixture(true);
  const occupied = assetsRepo.restoreBackupDestinationOccupied;
  const watcherId = insertAsset(f.live.db);
  const spy = spyOn(assetsRepo, 'restoreBackupDestinationOccupied');
  try {
    let inserted = false;
    spy.mockImplementation(async (...args) => {
      const result = await occupied(...args);
      if (!inserted) {
        inserted = true;
        insertLocation(f.live.db, {
          assetId: watcherId,
          libraryId: f.libraryId,
          path: '',
          filename: 'photo.dng',
        });
        await f.repo.ensureEntry(f.destination.id, watcherId, 0, 'photo.dng');
      }
      return result;
    });
    expect((await restoreAssetById(new ObjectId(f.assetId))).kind).toBe('error');
    expect(await fs.readFile(f.source, 'utf8')).toBe('immutable original');
    expect(await fs.readFile(f.sidecar, 'utf8')).toBe('<x:xmpmeta>exact source edit</x:xmpmeta>');
    expect(await fs.stat(path.join(f.root, 'photo.dng')).catch(() => null)).toBeNull();
    await reconcileLifecycle(f.repo);
    spy.mockRestore();
    expect((await restoreAssetById(new ObjectId(f.assetId))).kind).toBe('ok');
    expect(await fs.readFile(path.join(f.root, 'photo.restored.dng'), 'utf8')).toBe(
      'immutable original',
    );
    expect(await fs.readFile(path.join(f.root, 'photo.restored.xmp'), 'utf8')).toBe(
      '<x:xmpmeta>exact source edit</x:xmpmeta>',
    );
    expect(await fs.stat(f.source).catch(() => null)).toBeNull();
    expect(
      f.live.db.query('SELECT filename FROM asset_locations WHERE asset_id=?').get(watcherId),
    ).toEqual({ filename: 'photo.dng' });
    expect((await f.repo.entries(f.destination.id)).map((entry) => entry.id)).toContain(f.entry.id);
    expect(
      (await f.repo.entries(f.destination.id)).filter((entry) => entry.asset_id === watcherId),
    ).toHaveLength(1);
  } finally {
    spy.mockRestore();
    await f.close();
  }
});
