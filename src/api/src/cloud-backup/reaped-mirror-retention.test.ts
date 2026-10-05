import { expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdir, mkdtemp, realpath, rm, writeFile, readFile, stat } from '../fs/mirrored.ts';
import {
  createLiveTestDatabase,
  insertAsset,
  insertFolder,
  insertLocation,
} from '../db/sqlite/test-sqlite.test-helpers.ts';
import { BackupRepository } from './repository.ts';
import { preparePurge } from './lifecycle.ts';
import { runTrashGcOnce } from '../workers/trash-gc.ts';

async function fixture() {
  const live = await createLiveTestDatabase();
  const root = await realpath(await mkdtemp(join(tmpdir(), 'maple-reaped-mirror-')));
  const primary = join(root, 'primary');
  const mirror = join(root, 'mirror');
  await mkdir(primary);
  await mkdir(mirror);
  for (const directory of [primary, mirror]) {
    await writeFile(join(directory, 'photo.dng'), 'original-photo-bytes');
    await writeFile(join(directory, 'photo.xmp'), '<xmp>preserved</xmp>');
  }
  const libraryId = insertFolder(live.db, { path: primary });
  const assetId = insertAsset(live.db, { deletedAt: '2000-01-01T00:00:00Z' });
  insertLocation(live.db, {
    assetId,
    libraryId,
    path: '',
    filename: 'photo.dng',
    missingSince: '2000-01-01T00:00:00Z',
  });
  const source = await stat(join(primary, 'photo.dng'));
  live.db
    .query("UPDATE assets SET deleted_reason='reaped',size=?,mtime=? WHERE id=?")
    .run(source.size, source.mtimeMs, assetId);
  const repo = new BackupRepository(live.handle);
  return {
    live,
    root,
    primary,
    mirror,
    libraryId,
    assetId,
    repo,
    createMirror: (coveredLibrary = libraryId) =>
      repo.createDestination({
        libraryId: coveredLibrary,
        kind: 'folder',
        name: 'Photo mirror',
        path: mirror,
      }),
    async [Symbol.asyncDispose]() {
      live.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
async function retainedBytes(f: Awaited<ReturnType<typeof fixture>>) {
  expect(await readFile(join(f.mirror, 'photo.dng'), 'utf8')).toBe('original-photo-bytes');
  expect(await readFile(join(f.mirror, 'photo.xmp'), 'utf8')).toBe('<xmp>preserved</xmp>');
  expect(await readFile(join(f.primary, 'photo.dng'), 'utf8')).toBe('original-photo-bytes');
  expect(await readFile(join(f.primary, 'photo.xmp'), 'utf8')).toBe('<xmp>preserved</xmp>');
}

for (const enabled of [false, true]) {
  test(`retention preserves a reaped asset covered only by an ${enabled ? 'enabled' : 'disabled'} folder mirror`, async () => {
    await using f = await fixture();
    const destination = await f.createMirror();
    await f.repo.updateDestination(destination.id, { enabled });
    expect(await f.repo.entries(destination.id)).toEqual([]);
    expect(await runTrashGcOnce({ retentionDays: 30 })).toEqual({
      scanned: 1,
      purged: 0,
      errors: 0,
    });
    expect(f.live.db.query('SELECT id FROM assets WHERE id=?').get(f.assetId)).not.toBeNull();
    expect(await f.repo.purges(destination.id)).toEqual([]);
    expect(f.live.db.query("SELECT id FROM backup_lifecycle WHERE kind='purge'").all()).toEqual([]);
    await retainedBytes(f);
  });
}

test('orphaned entries from a removed destination do not block unbacked reaped retention forever', async () => {
  await using f = await fixture();
  const destination = await f.repo.createDestination({
    libraryId: f.libraryId,
    kind: 'google-drive',
    name: 'Removed Drive',
    path: null,
  });
  const entry = await f.repo.ensureEntry(destination.id, f.assetId, 0, 'photo.dng');
  f.live.db.query('DELETE FROM backup_destinations WHERE id=?').run(destination.id);
  expect(await runTrashGcOnce({ retentionDays: 30 })).toEqual({ scanned: 1, purged: 1, errors: 0 });
  expect(f.live.db.query('SELECT id FROM assets WHERE id=?').get(f.assetId)).toBeNull();
  expect((await f.repo.entries(destination.id))[0]!.id).toBe(entry.id);
  await retainedBytes(f);
});

test('a mirror for another library does not claim the reaped asset location', async () => {
  await using f = await fixture();
  const otherLibrary = insertFolder(f.live.db);
  await f.createMirror(otherLibrary);
  expect(await runTrashGcOnce({ retentionDays: 30 })).toEqual({ scanned: 1, purged: 1, errors: 0 });
  expect(f.live.db.query('SELECT id FROM assets WHERE id=?').get(f.assetId)).toBeNull();
  await retainedBytes(f);
});

test('mirror admission after retention selects candidates is seen by the final guarded delete', async () => {
  await using f = await fixture();
  const write = f.live.handle.write.bind(f.live.handle);
  f.live.handle.write = async (sql, params) => {
    if (sql.startsWith('DELETE FROM assets AS a')) {
      f.live.db
        .query(
          `INSERT INTO backup_destinations(id,library_id,kind,name,path,enabled,created_at)
        VALUES(?,?,'folder','New offline mirror',?,0,?)`,
        )
        .run(crypto.randomUUID(), f.libraryId, f.mirror, new Date().toISOString());
    }
    return write(sql, params);
  };
  expect(await runTrashGcOnce({ retentionDays: 30 })).toEqual({ scanned: 1, purged: 0, errors: 0 });
  expect(f.live.db.query('SELECT id FROM assets WHERE id=?').get(f.assetId)).not.toBeNull();
  expect(f.live.db.query('SELECT id FROM backup_entries').all()).toEqual([]);
  await retainedBytes(f);
});

test('an explicit permanent purge intent authorizes subsequent DB-only cleanup of a mirror-covered reaped row', async () => {
  await using f = await fixture();
  await f.createMirror();
  expect(await runTrashGcOnce({ retentionDays: 30 })).toEqual({ scanned: 1, purged: 0, errors: 0 });
  await preparePurge(f.assetId, f.repo);
  expect(
    f.live.db
      .query("SELECT id FROM backup_lifecycle WHERE asset_id=? AND kind='purge'")
      .all(f.assetId),
  ).toHaveLength(1);
  expect(await runTrashGcOnce({ retentionDays: 30 })).toEqual({ scanned: 1, purged: 1, errors: 0 });
  expect(f.live.db.query('SELECT id FROM assets WHERE id=?').get(f.assetId)).toBeNull();
  // Retention is still DB-only; destination erasure follows the durable explicit intent.
  await retainedBytes(f);
});
