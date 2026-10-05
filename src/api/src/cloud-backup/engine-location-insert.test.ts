import { expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as fs from '../fs/mirrored.ts';
import { ObjectId } from '../db/object-id.ts';
import { appendOrRefreshLocation } from '../db/repos/assets.discover.dedup.ts';
import {
  createLiveTestDatabase,
  insertAsset,
  insertFolder,
  insertLocation,
  run,
} from '../db/sqlite/test-sqlite.test-helpers.ts';
import { BackupRepository } from './repository.ts';
import { BackupEngine } from './engine.ts';
import { createTestProvider } from './test-provider.test-helpers.ts';

test('dedup insertion into another library rearms its backup without invalidating verified destinations', async () => {
  using live = await createLiveTestDatabase();
  const directory = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'maple-location-backup-')));
  try {
    const first = join(directory, 'first');
    const second = join(directory, 'second');
    await fs.mkdir(first);
    await fs.mkdir(second);
    for (const root of [first, second])
      await fs.writeFile(join(root, 'photo.dng'), 'same deduplicated bytes');
    const libraryId = insertFolder(live.db, { path: first });
    const otherLibrary = insertFolder(live.db, { path: second });
    const assetId = insertAsset(live.db);
    insertLocation(live.db, { assetId, libraryId, path: '', filename: 'photo.dng' });
    const repo = new BackupRepository(live.handle);
    const healthy = await repo.createDestination({
      libraryId,
      kind: 'google-drive',
      name: 'First',
      path: null,
    });
    const additional = await repo.createDestination({
      libraryId: otherLibrary,
      kind: 'google-drive',
      name: 'Second',
      path: null,
    });
    await repo.updateDestination(healthy.id, { enabled: true });
    await repo.updateDestination(additional.id, { enabled: true });
    const providers = new Map([
      [healthy.id, createTestProvider()],
      [additional.id, createTestProvider()],
    ]);
    const engine = new BackupEngine(async (destination) => providers.get(destination.id)!, repo);
    expect(await engine.backupAsset(assetId)).toBe(true);
    const verified = (await repo.entries(healthy.id))[0]!;
    expect(await repo.entries(additional.id)).toEqual([]);
    const completeStage = () =>
      run(
        live.db,
        `INSERT INTO stage_state(asset_id,stage,version)
      VALUES(?,'cloud-backup',1) ON CONFLICT(asset_id,stage) DO UPDATE SET version=1`,
        assetId,
      );
    const stage = () =>
      live.db
        .query("SELECT version FROM stage_state WHERE asset_id=? AND stage='cloud-backup'")
        .get(assetId);
    completeStage();
    const existing = {
      id: new ObjectId(assetId),
      deletedAt: null,
      locations: [{ library_id: new ObjectId(libraryId), path: '', filename: 'photo.dng' }],
    };
    const entry = {
      library_id: new ObjectId(otherLibrary),
      path: '',
      filename: 'photo.dng',
      keep: false,
    };
    const stat = live.db
      .query('SELECT mtime,size,indexed_at FROM assets WHERE id=?')
      .get(assetId) as { mtime: number; size: number; indexed_at: string };
    const refresh = { mtime: stat.mtime, size: stat.size, indexedAt: stat.indexed_at };
    expect(await appendOrRefreshLocation(existing, entry, refresh, undefined, live.handle)).toBe(
      'append',
    );
    expect(stage()).toEqual({ version: 0 });
    expect((await repo.entries(healthy.id))[0]).toEqual(verified);
    expect(await engine.backupAsset(assetId)).toBe(true);
    expect((await repo.entries(additional.id))[0]!.verified_sequence).toBe(1);
    expect((await repo.entries(healthy.id))[0]).toEqual(verified);
    completeStage();
    // A concurrent discover worker with stale locations loses the insert race.
    // ON CONFLICT DO NOTHING must not rearm a second completed backup again.
    expect(await appendOrRefreshLocation(existing, entry, refresh, undefined, live.handle)).toBe(
      'append',
    );
    expect(stage()).toEqual({ version: 1 });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
