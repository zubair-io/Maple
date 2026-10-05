import { expect, test } from 'bun:test';
import * as fs from '../fs/mirrored.ts';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createLiveTestDatabase,
  insertAsset,
  insertFolder,
  insertLocation,
} from '../db/sqlite/test-sqlite.test-helpers.ts';
import { BackupRepository } from './repository.ts';
import {
  prepareLifecycle,
  recordLifecycleTarget,
  runLifecycleMove,
  reconcileLifecycle,
  preparePurge,
} from './lifecycle.ts';
import { BackupEngine, entryPrefix, jsonSource } from './engine.ts';
import { TestProvider } from './test-provider.test-helpers.ts';
import { drainPurges } from './purge.ts';

test('restart completes a recorded verified Trash move, while an unperformed move is cancelled', async () => {
  using live = await createLiveTestDatabase();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-lifecycle-'));
  try {
    const libraryId = insertFolder(live.db, { path: root });
    const assetId = insertAsset(live.db);
    insertLocation(live.db, { assetId, libraryId, path: '', filename: 'photo.dng' });
    const original = path.join(root, 'photo.dng');
    const target = path.join(root, '.maple/trash/photo.1.dng');
    await fs.writeFile(original, 'original bytes');
    const repo = new BackupRepository(live.handle);
    const id = await prepareLifecycle(assetId, 'trash', libraryId, 'photo.dng', repo);
    await recordLifecycleTarget(id, root, original, target, repo);
    await runLifecycleMove(id, async () => {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.rename(original, target);
    });
    await reconcileLifecycle(repo);
    const [location] = await repo.db.read<{ path: string; filename: string }>(
      'SELECT path,filename FROM asset_locations WHERE asset_id=?',
      [assetId],
    );
    expect(location).toEqual({ path: '.maple/trash', filename: 'photo.1.dng' });
    expect(
      (
        await repo.db.read<{ phase: string }>('SELECT phase FROM backup_lifecycle WHERE id=?', [id])
      )[0]!.phase,
    ).toBe('applied');
    const retry = await prepareLifecycle(
      assetId,
      'restore',
      libraryId,
      '.maple/trash/photo.1.dng',
      repo,
    );
    await runLifecycleMove(retry, async () => {});
    await reconcileLifecycle(repo);
    expect(
      (
        await repo.db.read<{ phase: string }>('SELECT phase FROM backup_lifecycle WHERE id=?', [
          retry,
        ])
      )[0]!.phase,
    ).toBe('cancelled');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
test('offline folder purge cannot delete a newer photo that reused the recorded Trash path', async () => {
  using live = await createLiveTestDatabase();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-purge-source-'));
  const mirror = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-purge-target-'));
  try {
    const libraryId = insertFolder(live.db, { path: root });
    const assetId = insertAsset(live.db, { deletedAt: new Date().toISOString() });
    insertLocation(live.db, { assetId, libraryId, path: '.maple/trash', filename: 'photo.dng' });
    const relative = '.maple/trash/photo.dng';
    await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await fs.mkdir(path.dirname(path.join(mirror, relative)), { recursive: true });
    await fs.writeFile(path.join(root, relative), 'old photo');
    await fs.writeFile(path.join(mirror, relative), 'old photo');
    const repo = new BackupRepository(live.handle);
    const destination = await repo.createDestination({
      libraryId,
      kind: 'folder',
      name: 'Mirror',
      path: mirror,
    });
    await preparePurge(assetId, repo);
    await fs.unlink(path.join(root, relative));
    await fs.writeFile(path.join(mirror, relative), 'newer photo');
    const engine = new BackupEngine(async () => new TestProvider(), repo);
    await drainPurges(engine, destination);
    expect((await repo.purges(destination.id))[0]!.completed).toBe(0);
    expect(await fs.readFile(path.join(mirror, relative), 'utf8')).toBe('newer photo');
    await fs.writeFile(path.join(mirror, relative), 'old photo');
    await drainPurges(engine, destination);
    expect((await repo.purges(destination.id))[0]!.completed).toBe(1);
    expect(await fs.stat(path.join(mirror, relative)).catch(() => null)).toBeNull();
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(mirror, { recursive: true, force: true });
  }
});
test('a late moved upload between final list and completion cannot clear its erasure obligation', async () => {
  using live = await createLiveTestDatabase();
  const repo = new BackupRepository(live.handle);
  const libraryId = insertFolder(live.db);
  const destination = await repo.createDestination({
    libraryId,
    kind: 'google-drive',
    name: 'Drive',
    path: null,
  });
  const assetId = insertAsset(live.db);
  const entry = await repo.ensureEntry(destination.id, assetId, 0, 'photo.dng');
  await preparePurge(assetId, repo);
  const provider = new TestProvider();
  const prefix = entryPrefix(libraryId, entry.id);
  const list = provider.list.bind(provider);
  let rounds = 0;
  provider.list = async function* (key, signal) {
    yield* list(key, signal);
    if (key === prefix && ++rounds === 2) {
      const source = jsonSource('late original bytes');
      const object = await provider.publish(prefix + 'blobs/' + source.sha256, source, {
        saveCheckpoint: async () => {},
      });
      provider.objects.get(object.key)!.moved = true;
      await repo.saveObject(destination.id, entry.id, object.key, object, null);
    }
  };
  await drainPurges(new BackupEngine(async () => provider, repo), destination);
  expect((await repo.purges(destination.id))[0]!.completed).toBe(0);
  expect(provider.objects.size).toBe(2);
});
test('a durable purge prevents admitting a new backup location or destination for the same asset', async () => {
  using live = await createLiveTestDatabase();
  const repo = new BackupRepository(live.handle);
  const libraryId = insertFolder(live.db);
  const assetId = insertAsset(live.db);
  const destination = await repo.createDestination({
    libraryId,
    kind: 'google-drive',
    name: 'Drive',
    path: null,
  });
  await repo.ensureEntry(destination.id, assetId, 0, 'photo.dng');
  await preparePurge(assetId, repo);
  await expect(repo.ensureEntry(destination.id, assetId, 1, 'second/photo.dng')).rejects.toThrow();
  const second = await repo.createDestination({
    libraryId,
    kind: 'google-drive',
    name: 'Another Drive',
    path: null,
  });
  await expect(repo.ensureEntry(second.id, assetId, 0, 'photo.dng')).rejects.toThrow();
  expect(await repo.entries(second.id)).toHaveLength(0);
});
test('an interrupted purge marker resumes its reserved upload before erasure can complete', async () => {
  using live = await createLiveTestDatabase();
  const repo = new BackupRepository(live.handle);
  const libraryId = insertFolder(live.db);
  const assetId = insertAsset(live.db);
  const destination = await repo.createDestination({
    libraryId,
    kind: 'google-drive',
    name: 'Drive',
    path: null,
  });
  const entry = await repo.ensureEntry(destination.id, assetId, 0, 'photo.dng');
  await preparePurge(assetId, repo);
  const provider = new TestProvider();
  const publish = provider.publish.bind(provider);
  const checkpoint = { provider: 'test', version: 1 as const, state: { reservation: 'stable-id' } };
  let interrupted = true;
  provider.publish = async (key, source, options) => {
    if (interrupted) {
      interrupted = false;
      await options.saveCheckpoint(checkpoint);
      throw new Error('lost upload response');
    }
    expect(options.checkpoint).toEqual(checkpoint);
    return publish(key, source, options);
  };
  const engine = new BackupEngine(async () => provider, repo);
  await drainPurges(engine, destination);
  expect((await repo.purges(destination.id))[0]!.completed).toBe(0);
  await drainPurges(engine, destination);
  expect((await repo.purges(destination.id))[0]!.completed).toBe(1);
  const saved = await repo.object(destination.id, `purges/${entry.id}.json`);
  expect(saved.checkpoint).toBeNull();
  expect(saved.object?.locator).toBe(
    provider.objects.get(`purges/${entry.id}.json`)!.object.locator,
  );
});
