import { expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as fs from '../fs/mirrored.ts';
import {
  createLiveTestDatabase,
  insertAsset,
  insertFolder,
  insertLocation,
  run,
} from '../db/sqlite/test-sqlite.test-helpers.ts';
import { BackupEngine } from './engine.ts';
import { BackupRepository } from './repository.ts';
import { assetInventory } from './inventory.ts';
import { createTestProvider } from './test-provider.test-helpers.ts';
import { prepareLifecycle, finishLocalLifecycle, preparePurge } from './lifecycle.ts';

async function fixture() {
  const live = await createLiveTestDatabase();
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'maple-verified-retry-')));
  const primary = join(root, 'primary');
  const other = join(root, 'other');
  await fs.mkdir(primary);
  await fs.mkdir(other);
  const libraryId = insertFolder(live.db, { path: primary });
  const otherLibrary = insertFolder(live.db, { path: other });
  const assetId = insertAsset(live.db);
  insertLocation(live.db, {
    assetId,
    libraryId,
    filename: 'photo.dng',
    path: '',
  });
  insertLocation(live.db, {
    assetId,
    libraryId: otherLibrary,
    ordinal: 1,
    filename: 'photo.dng',
    path: '',
  });
  await fs.writeFile(join(primary, 'photo.dng'), 'original photo bytes');
  await fs.writeFile(join(primary, 'photo.xmp'), '<xmp>exact initial edit</xmp>');
  await fs.writeFile(join(other, 'photo.dng'), 'original photo bytes');
  const repo = new BackupRepository(live.handle);
  const healthy = await repo.createDestination({
    libraryId,
    kind: 'google-drive',
    name: 'Healthy',
    path: null,
  });
  const offline = await repo.createDestination({
    libraryId: otherLibrary,
    kind: 'google-drive',
    name: 'Offline',
    path: null,
  });
  await repo.updateDestination(healthy.id, { enabled: true });
  await repo.updateDestination(offline.id, { enabled: true });
  const provider = createTestProvider();
  const unavailable = createTestProvider();
  unavailable.offline = true;
  const calls = { healthy: 0, offline: 0 };
  const engine = new BackupEngine(async (destination) => {
    if (destination.id === healthy.id) {
      calls.healthy++;
      return provider;
    }
    calls.offline++;
    return unavailable;
  }, repo);
  return {
    root,
    primary,
    assetId,
    libraryId,
    healthy,
    offline,
    repo,
    engine,
    provider,
    unavailable,
    calls,
    async [Symbol.asyncDispose]() {
      await fs.rm(root, { recursive: true, force: true });
      live.close();
    },
    db: live.db,
  };
}

test('an offline destination retry never reclaims, reads or probes already verified targets', async () => {
  await using setup = await fixture();
  const { assetId, primary, root, repo, healthy, offline, engine, calls, unavailable } = setup;
  expect(await engine.backupAsset(assetId)).toBe(false);
  const completed = (await repo.entries(healthy.id))[0]!;
  expect(completed.verified_sequence).toBe(completed.sequence);
  expect(calls).toEqual({ healthy: 1, offline: 1 });
  // The verified source volume disappears while the other destination retries.
  // A repeated capture/hash would fail here and change its lease/error state.
  const parked = join(root, 'parked');
  await fs.rename(primary, parked);
  for (let attempt = 0; attempt < 3; attempt++) {
    await repo.retry(offline.id);
    expect(await engine.backupAsset(assetId)).toBe(false);
    expect((await repo.entries(healthy.id))[0]).toEqual(completed);
  }
  expect(calls).toEqual({ healthy: 1, offline: 4 });
  await fs.rename(parked, primary);
  unavailable.offline = false;
  await repo.retry(offline.id);
  expect(await engine.backupAsset(assetId)).toBe(true);
  expect(calls).toEqual({ healthy: 1, offline: 5 });
  expect((await repo.entries(healthy.id))[0]).toEqual(completed);
});

test('indexed edits invalidate the completed sequence and publish the real updated sidecar', async () => {
  await using setup = await fixture();
  const { engine, assetId, healthy, repo, calls, primary, provider, db } = setup;
  expect(await engine.backupAsset(assetId)).toBe(false);
  const previous = (await repo.entries(healthy.id))[0]!;
  const xmp = '<xmp>changed edit with unknown passthrough</xmp>';
  await fs.writeFile(join(primary, 'photo.xmp'), xmp);
  run(db, 'UPDATE assets SET sidecar_ver=sidecar_ver+1 WHERE id=?', assetId);
  expect(await engine.backupAsset(assetId)).toBe(false);
  const current = (await repo.entries(healthy.id))[0]!;
  expect(current.sequence).toBeGreaterThan(previous.sequence);
  expect(current.verified_sequence).toBe(current.sequence);
  expect(calls.healthy).toBe(2);
  const sidecar = JSON.parse(current.manifest!).files.find(
    (file: { role: string }) => file.role === 'sidecar',
  );
  expect(Buffer.from(provider.objects.get(sidecar.object.key)!.bytes).toString()).toBe(xmp);
});

test('a completed entry cannot bypass a prepared move, permanent purge or captured destination fence', async () => {
  await using setup = await fixture();
  const { engine, assetId, healthy, libraryId, repo, calls, db } = setup;
  expect(await engine.backupAsset(assetId)).toBe(false);
  const destination = (await repo.destination(healthy.id))!;
  const location = (await assetInventory(assetId, libraryId, repo))[0]!;
  // Configuration changed after this transfer captured its destination snapshot.
  await repo.updateDestination(healthy.id, { name: 'Renamed' });
  expect(await engine.transfer(destination, location)).toBe(false);
  expect(calls.healthy).toBe(1);
  const current = (await repo.destination(healthy.id))!;
  // A current metadata-only generation retains its completed sequence.
  expect(await engine.transfer(current, location)).toBe(true);
  expect(calls.healthy).toBe(1);
  // Root identity is fenced even if a concurrent write fails to advance generation.
  run(db, 'UPDATE backup_destinations SET root_id=? WHERE id=?', 'changed-root', healthy.id);
  expect(await engine.transfer(current, location)).toBe(false);
  expect(calls.healthy).toBe(1);
  run(
    db,
    'UPDATE backup_destinations SET root_id=NULL,account_id=? WHERE id=?',
    'another-account',
    healthy.id,
  );
  expect(await engine.transfer(current, location)).toBe(false);
  await repo.updateDestination(healthy.id, { enabled: false });
  expect(await engine.transfer((await repo.destination(healthy.id))!, location)).toBe(false);
  await repo.updateDestination(healthy.id, { enabled: true });
  const intent = await prepareLifecycle(assetId, 'trash', libraryId, 'photo.dng', repo);
  expect(await engine.backupAsset(assetId)).toBe(false);
  expect(calls.healthy).toBe(1);
  await finishLocalLifecycle(intent, true, repo);
  await preparePurge(assetId, repo);
  expect(await engine.backupAsset(assetId)).toBe(false);
  expect(calls.healthy).toBe(1);
});
