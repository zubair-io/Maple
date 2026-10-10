import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
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
import { createTestProvider } from './test-provider.test-helpers.ts';
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
  const provider = createTestProvider();
  const engine = new BackupEngine(async () => provider, repo);
  return { assetId, libraryId, destination, repo, provider, engine };
}

test('original and exact XMP bytes mirror to one current remote path without the local catalog', async () => {
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
  expect(remote.entries).toHaveLength(1);
  const latest = latestManifests(remote.entries)[0]!;
  expect(latest.sequence).toBeGreaterThan(first.sequence);
  expect(latest.files[0]!.object.locator).toBe(first.files[0]!.object.locator);
  expect((await repo.entries(destination.id))[0]!.verified_sequence).toBe(latest.sequence);
  run(live.db, 'DELETE FROM backup_entries');
  expect((await readRemoteCatalog(provider)).entries).toHaveLength(1);
  expect(await fs.readFile(path.join(root, 'photo.dng'), 'utf8')).toBe('immutable original');
});
test('successful Google reconnect clears resolved authorization errors but keeps unrelated failures', async () => {
  using live = await createLiveTestDatabase();
  const { assetId, destination, repo } = await setup(live);
  await repo.ensureEntry(destination.id, assetId, 0, 'photo.dng');
  const [entry] = await repo.entries(destination.id, assetId);
  expect(entry).toBeDefined();
  await repo.db.write('UPDATE backup_entries SET last_error=? WHERE id=?', [
    'Reconnect Google Drive to resume backup.',
    entry!.id,
  ]);
  await repo.clearResolvedGoogleConnectionErrors(destination.id);
  expect((await repo.entries(destination.id, assetId))[0]!.last_error).toBeNull();
  await repo.db.write('UPDATE backup_entries SET last_error=? WHERE id=?', [
    'Google object failed identity or integrity validation.',
    entry!.id,
  ]);
  await repo.clearResolvedGoogleConnectionErrors(destination.id);
  expect((await repo.entries(destination.id, assetId))[0]!.last_error).toBe(
    'Google object failed identity or integrity validation.',
  );
});
test('outgoing entry cleanup preserves a mirror path that another entry has claimed', async () => {
  using live = await createLiveTestDatabase();
  const { assetId, destination, repo, provider, engine } = await setup(live);
  expect(await engine.backupAsset(assetId)).toBe(true);
  const firstManifest = latestManifests((await readRemoteCatalog(provider)).entries)[0]!;
  const firstObject = firstManifest.files.find((file) => file.role === 'original')!.object;
  const otherEntryId = crypto.randomUUID();
  await repo.saveObject(destination.id, otherEntryId, firstObject.key, firstObject, null);

  run(live.db, 'UPDATE asset_locations SET filename=? WHERE asset_id=?', 'renamed.dng', assetId);
  await fs.rename(path.join(root, 'photo.dng'), path.join(root, 'renamed.dng'));
  run(live.db, 'UPDATE assets SET sidecar_ver=sidecar_ver+1 WHERE id=?', assetId);
  expect(await engine.backupAsset(assetId)).toBe(true);
  expect(provider.objects.has(firstObject.key)).toBe(true);
  expect((await repo.objectOwner(destination.id, firstObject.key))?.entryId).toBe(otherEntryId);
});
test('mirror migration removes an unreferenced legacy blob after publishing its replacement', async () => {
  using live = await createLiveTestDatabase();
  const { assetId, libraryId, destination, repo, provider, engine } = await setup(live);
  expect(await engine.backupAsset(assetId)).toBe(true);
  const prior = latestManifests((await readRemoteCatalog(provider)).entries)[0]!;
  const entry = (await repo.entries(destination.id))[0]!;
  const original = prior.files.find((file) => file.role === 'original')!;
  const bytes = provider.objects.get(original.object.key)!.bytes;
  async function publishLegacyBlob(content: Uint8Array) {
    const sha256 = createHash('sha256').update(content).digest('hex');
    const key = `libraries/${libraryId}/entries/${entry.id}/blobs/${sha256}`;
    const object = await provider.publish(
      key,
      {
        size: content.length,
        sha256,
        open: (offset) =>
          new ReadableStream({
            start(controller) {
              controller.enqueue(content.subarray(offset));
              controller.close();
            },
          }),
      },
      { saveCheckpoint: async () => {} },
    );
    await repo.saveObject(destination.id, entry.id, key, object, null);
    return { key, object };
  }
  const { key: legacyKey, object: legacyObject } = await publishLegacyBlob(bytes);
  const { key: historicalKey } = await publishLegacyBlob(Buffer.from('older backup sequence'));
  const legacyManifest = {
    ...prior,
    files: prior.files.map((file) =>
      file.path === original.path ? { ...file, object: legacyObject } : file,
    ),
  };
  await repo.db.write('UPDATE backup_entries SET manifest=? WHERE id=?', [
    JSON.stringify(legacyManifest),
    entry.id,
  ]);

  run(live.db, 'UPDATE assets SET sidecar_ver=sidecar_ver+1 WHERE id=?', assetId);
  expect(await engine.backupAsset(assetId)).toBe(true);
  expect(provider.objects.has(legacyKey)).toBe(false);
  expect(provider.objects.has(historicalKey)).toBe(false);
  expect(await repo.objectOwner(destination.id, legacyKey)).toBeNull();
  expect(await repo.objectOwner(destination.id, historicalKey)).toBeNull();
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
  const offline = createTestProvider();
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
  const blob = [...provider.objects.values()].find((row) => row.object.key.startsWith('mirror/'))!;
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
  const trashBackupResult = await engine.backupAsset(assetId);
  expect(trashBackupResult).toBe(true);
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
  const blob = [...provider.objects.values()].find((row) => row.object.key.startsWith('mirror/'))!;
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
  const transactions = spyOn(repo.db, 'transaction');
  try {
    await migrateFolderDestinations(repo);
    expect(transactions).not.toHaveBeenCalled();
  } finally {
    transactions.mockRestore();
  }
  await loadDestinationMirrors(new BackupRepository(live.handle));
  expect((await repo.destinations()).find((d) => d.kind === 'folder')!.id).toBe(first.id);
  expect(await engine.backupAsset(assetId)).toBe(true);
  await preparePurge(assetId, repo);
  await expect(
    repo.db.write('DELETE FROM backup_destinations WHERE id=?', [destination.id]),
  ).rejects.toThrow('pending cleanup');
});
