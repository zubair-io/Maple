import { afterEach, beforeEach, expect, test } from 'bun:test';
import * as fs from '../fs/mirrored.ts';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createLiveTestDatabase,
  insertAsset,
  insertFolder,
  insertLocation,
  run,
} from '../db/sqlite/test-sqlite.test-helpers.ts';
import { BackupRepository } from './repository.ts';
import { BackupEngine, entryPrefix } from './engine.ts';
import { assetInventory } from './inventory.ts';
import { TestProvider } from './test-provider.test-helpers.ts';
import { readRemoteCatalog, latestManifests } from './catalog.ts';
import { prepareLifecycle, finishLocalLifecycle, preparePurge } from './lifecycle.ts';
import { drainPurges } from './purge.ts';
import { migrateFolderDestinations, loadDestinationMirrors } from './local-mirror-bridge.ts';
import { trashAssetById, restoreAssetById } from '../library/asset-trash.ts';
import { ObjectId } from '../db/object-id.ts';

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-backup-engine-'));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});
async function setup(live: Awaited<ReturnType<typeof createLiveTestDatabase>>) {
  const libraryId = insertFolder(live.db, { path: root });
  const assetId = insertAsset(live.db);
  insertLocation(live.db, { assetId, libraryId, path: '', filename: 'photo.dng' });
  await fs.writeFile(path.join(root, 'photo.dng'), 'immutable original');
  await fs.writeFile(
    path.join(root, 'photo.xmp'),
    '<x:xmpmeta xmlns:x="adobe:ns:meta/"><unknown>keep exact bytes</unknown></x:xmpmeta>',
  );
  const repo = new BackupRepository(live.handle);
  const created = await repo.createDestination({
    libraryId,
    kind: 'google-drive',
    name: 'Drive',
    path: null,
  });
  await repo.updateDestination(created.id, { enabled: true });
  const destination = (await repo.destination(created.id))!;
  const provider = new TestProvider();
  const engine = new BackupEngine(async () => provider, repo);
  return { assetId, libraryId, destination, repo, provider, engine };
}

test('original and exact XMP bytes publish durable versions recoverable without the local catalog', async () => {
  using live = await createLiveTestDatabase();
  const { assetId, destination, repo, provider, engine } = await setup(live);
  expect(await engine.backupAsset(assetId)).toBe(true);
  const first = latestManifests((await readRemoteCatalog(provider)).entries)[0]!;
  expect(first.files.map((f) => f.role)).toEqual(['original', 'sidecar']);
  const sidecar = first.files.find((f) => f.role === 'sidecar')!;
  expect(Buffer.from(provider.objects.get(sidecar.object.key)!.bytes).toString()).toBe(
    await fs.readFile(path.join(root, 'photo.xmp'), 'utf8'),
  );
  await fs.writeFile(path.join(root, 'photo.xmp'), '<xmp>new edit with unknown passthrough</xmp>');
  run(live.db, 'UPDATE assets SET sidecar_ver=sidecar_ver+1 WHERE id=?', assetId);
  expect(await engine.backupAsset(assetId)).toBe(true);
  const remote = await readRemoteCatalog(provider);
  expect(remote.entries).toHaveLength(2);
  const latest = latestManifests(remote.entries)[0]!;
  expect(latest.sequence).toBeGreaterThan(first.sequence);
  expect(latest.files[0]!.object.locator).toBe(first.files[0]!.object.locator);
  expect((await repo.entries(destination.id))[0]!.verified_sequence).toBe(latest.sequence);
  run(live.db, 'DELETE FROM backup_entries');
  expect((await readRemoteCatalog(provider)).entries).toHaveLength(2);
  expect(await fs.readFile(path.join(root, 'photo.dng'), 'utf8')).toBe('immutable original');
});
test('a disconnected target retries independently while healthy targets publish', async () => {
  using live = await createLiveTestDatabase();
  const setupResult = await setup(live);
  const { repo, assetId, libraryId, provider } = setupResult;
  const second = await repo.createDestination({
    libraryId,
    kind: 'google-drive',
    name: 'Offline',
    path: null,
  });
  await repo.updateDestination(second.id, { enabled: true });
  const offline = new TestProvider();
  offline.offline = true;
  const engine = new BackupEngine(async (d) => (d.id === second.id ? offline : provider), repo);
  expect(await engine.backupAsset(assetId)).toBe(false);
  expect((await repo.entries(setupResult.destination.id))[0]!.verified_sequence).toBeGreaterThan(0);
  expect((await repo.entries(second.id))[0]!.last_error).toBe('Destination offline');
  offline.offline = false;
  await repo.retry(second.id);
  expect(await engine.backupAsset(assetId)).toBe(true);
});
test('a known object moved outside the backup root blocks reuse and retains its cleanup locator', async () => {
  using live = await createLiveTestDatabase();
  const { assetId, destination, repo, provider, engine } = await setup(live);
  expect(await engine.backupAsset(assetId)).toBe(true);
  const blob = [...provider.objects.values()].find((row) => row.object.key.includes('/blobs/'))!;
  const locator = blob.object.locator;
  const count = provider.objects.size;
  blob.moved = true;
  run(live.db, 'UPDATE assets SET sidecar_ver=sidecar_ver+1 WHERE id=?', assetId);
  expect(await engine.backupAsset(assetId)).toBe(false);
  expect((await repo.object(destination.id, blob.object.key)).object?.locator).toBe(locator);
  expect(provider.objects.size).toBe(count);
  expect((await repo.entries(destination.id))[0]!.last_error).toContain('outside root');
});
test('prepared local moves and changed destination generations fence admission and completion', async () => {
  using live = await createLiveTestDatabase();
  const { assetId, libraryId, destination, repo, engine } = await setup(live);
  const location = (await assetInventory(assetId, libraryId, repo))[0]!;
  const entry = await repo.ensureEntry(destination.id, assetId, 0, 'photo.dng');
  const intent = await prepareLifecycle(assetId, 'trash', libraryId, 'photo.dng', repo);
  expect(await repo.claim(entry, 'old-worker')).toBe(false);
  expect(await engine.transfer(destination, location)).toBe(false);
  await finishLocalLifecycle(intent, true, repo);
  const fresh = (await repo.entries(destination.id))[0]!;
  expect(await repo.claim(fresh, 'worker')).toBe(true);
  await repo.updateDestination(destination.id, { enabled: false });
  expect(await repo.fence(fresh, destination, 'worker')).toBe(false);
});
test('Trash and restore advance the remote state without rewriting original bytes', async () => {
  using live = await createLiveTestDatabase();
  const { assetId, engine, provider } = await setup(live);
  expect(await engine.backupAsset(assetId)).toBe(true);
  expect((await trashAssetById(new ObjectId(assetId))).kind).toBe('ok');
  expect(await engine.backupAsset(assetId)).toBe(true);
  expect(latestManifests((await readRemoteCatalog(provider)).entries)[0]!.state).toBe('trash');
  expect((await restoreAssetById(new ObjectId(assetId))).kind).toBe('ok');
  expect(await engine.backupAsset(assetId)).toBe(true);
  expect(latestManifests((await readRemoteCatalog(provider)).entries)[0]!.state).toBe('active');
  expect(await fs.readFile(path.join(root, 'photo.dng'), 'utf8')).toBe('immutable original');
});
test('permanent purge remains durable offline, suppresses old catalogs, and blocks moved-object cleanup', async () => {
  using live = await createLiveTestDatabase();
  const { assetId, destination, repo, engine, provider } = await setup(live);
  expect(await engine.backupAsset(assetId)).toBe(true);
  const entry = (await repo.entries(destination.id))[0]!;
  await preparePurge(assetId, repo);
  run(live.db, 'DELETE FROM assets WHERE id=?', assetId);
  provider.offline = true;
  await drainPurges(engine, destination);
  expect((await repo.purges(destination.id))[0]!.completed).toBe(0);
  provider.offline = false;
  const blob = [...provider.objects.values()].find((row) => row.object.key.includes('/blobs/'))!;
  blob.moved = true;
  await drainPurges(engine, destination);
  expect((await repo.purges(destination.id))[0]!.completed).toBe(0);
  expect((await readRemoteCatalog(provider)).entries).toHaveLength(0);
  blob.moved = false;
  await drainPurges(engine, destination);
  expect((await repo.purges(destination.id))[0]!.completed).toBe(1);
  expect(
    [...provider.objects.keys()].some((key) =>
      key.startsWith(entryPrefix(destination.libraryId, entry.id)),
    ),
  ).toBe(false);
  expect([...provider.objects.keys()]).toContain(`purges/${entry.id}.json`);
});
test('legacy mirror IDs survive restart and destination deletion cannot abandon pending purges', async () => {
  using live = await createLiveTestDatabase();
  const { libraryId, destination, repo, engine, assetId } = await setup(live);
  run(
    live.db,
    'UPDATE folders SET mirrors=? WHERE id=?',
    JSON.stringify([{ path: root + '-mirror', enabled: true }]),
    libraryId,
  );
  await migrateFolderDestinations(repo);
  const first = (await repo.destinations()).find((d) => d.kind === 'folder')!;
  await loadDestinationMirrors(new BackupRepository(live.handle));
  expect((await repo.destinations()).find((d) => d.kind === 'folder')!.id).toBe(first.id);
  expect(await engine.backupAsset(assetId)).toBe(true);
  await preparePurge(assetId, repo);
  await expect(
    repo.db.write('DELETE FROM backup_destinations WHERE id=?', [destination.id]),
  ).rejects.toThrow('pending cleanup');
});
