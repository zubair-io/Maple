import { expect, test } from 'bun:test';
import { Elysia } from 'elysia';
import * as fs from '../fs/mirrored.ts';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import {
  createLiveTestDatabase,
  insertAsset,
  insertFolder,
  insertLocation,
} from '../db/sqlite/test-sqlite.test-helpers.ts';
import { BackupRepository } from './repository.ts';
import { BackupEngine } from './engine.ts';
import { drainPurges } from './purge.ts';
import { inventoryFolderPurges } from './folder-purge-inventory.ts';
import { createTestProvider } from './test-provider.test-helpers.ts';
import { trashRoutes } from '../routes/assets/trash.ts';
import { fakeAuth } from '../../tests/helpers/test-auth.ts';

async function fixture(retainHashes = false) {
  const live = await createLiveTestDatabase();
  const directory = await fs.realpath(
    await fs.mkdtemp(path.join(tmpdir(), 'maple-reaped-mirror-')),
  );
  const primary = path.join(directory, 'original-volume');
  const mirror = path.join(directory, 'mirror-volume');
  const libraryId = insertFolder(live.db, { path: primary });
  const assetId = insertAsset(live.db);
  insertLocation(live.db, { assetId, libraryId, path: 'sub', filename: 'photo.dng' });
  live.db.run('UPDATE assets SET apple_rendered_path=? WHERE id=?', [
    'sub/photo-rendered.jpg',
    assetId,
  ]);
  const contents = new Map([
    ['sub/photo.dng', 'original photo bytes'],
    ['sub/photo.xmp', '<x:xmpmeta>exact canonical edit</x:xmpmeta>'],
    ['sub/photo (conflict from Mac).xmp', '<x:xmpmeta>exact conflict edit</x:xmpmeta>'],
    ['sub/photo-rendered.jpg', 'recorded Apple rendered photo'],
  ]);
  for (const root of [primary, mirror]) {
    await fs.mkdir(path.join(root, 'sub'), { recursive: true });
    for (const [relative, bytes] of contents) await fs.writeFile(path.join(root, relative), bytes);
  }
  await fs.writeFile(path.join(mirror, 'sub/unrelated.jpg'), 'unrelated photo');
  const repo = new BackupRepository(live.handle);
  // Disabled configured mirrors still owe permanent erasure.
  const destination = await repo.createDestination({
    libraryId,
    kind: 'folder',
    name: 'Mirror',
    path: mirror,
  });
  if (retainHashes) await inventoryFolderPurges(assetId, repo);
  live.db.run("UPDATE assets SET deleted_reason='reaped',deleted_at='2000-01-01' WHERE id=?", [
    assetId,
  ]);
  live.db.run("UPDATE asset_locations SET missing_since='2000-01-01' WHERE asset_id=?", [assetId]);
  const app = new Elysia().use(fakeAuth()).group('/api/assets', (group) => group.use(trashRoutes));
  return {
    live,
    directory,
    primary,
    mirror,
    assetId,
    contents,
    repo,
    destination,
    async purge() {
      return app.handle(
        new Request(`http://localhost/api/assets/${assetId}?intent=purge`, { method: 'DELETE' }),
      );
    },
    async drain() {
      await drainPurges(new BackupEngine(async () => createTestProvider(), repo), destination);
    },
    async close() {
      live.close();
      await fs.rm(directory, { recursive: true, force: true });
    },
  };
}

async function expectOriginals(root: string, contents: Map<string, string>) {
  for (const [relative, bytes] of contents)
    expect(await fs.readFile(path.join(root, relative), 'utf8')).toBe(bytes);
}

test('explicit reaped purge records original, both XMPs and companion mirror obligations while preserving returned primary bytes', async () => {
  const f = await fixture();
  try {
    expect((await f.purge()).status).toBe(204);
    expect(f.live.db.query('SELECT id FROM assets WHERE id=?').get(f.assetId)).toBeNull();
    const entry = (await f.repo.entries(f.destination.id))[0]!;
    const inventory = JSON.parse(entry.manifest!) as {
      localFiles: Array<{ path: string; sha256: string }>;
    };
    expect(new Set(inventory.localFiles.map((file) => file.path))).toEqual(
      new Set(f.contents.keys()),
    );
    expect(inventory.localFiles.every((file) => /^[a-f0-9]{64}$/.test(file.sha256))).toBe(true);
    expect((await f.repo.purges(f.destination.id))[0]!.completed).toBe(0);
    await f.drain();
    expect((await f.repo.purges(f.destination.id))[0]!.completed).toBe(1);
    for (const relative of f.contents.keys())
      expect(await fs.stat(path.join(f.mirror, relative)).catch(() => null)).toBeNull();
    await expectOriginals(f.primary, f.contents);
    expect(await fs.readFile(path.join(f.mirror, 'sub/unrelated.jpg'), 'utf8')).toBe(
      'unrelated photo',
    );
  } finally {
    await f.close();
  }
});

test('retained full hashes authorize reaped mirror cleanup while the original volume remains absent', async () => {
  const f = await fixture(true);
  const parked = path.join(f.directory, 'parked-originals');
  try {
    await fs.rename(f.primary, parked);
    expect((await f.purge()).status).toBe(204);
    await f.drain();
    expect((await f.repo.purges(f.destination.id))[0]!.completed).toBe(1);
    await expectOriginals(parked, f.contents);
    for (const relative of f.contents.keys())
      expect(await fs.stat(path.join(f.mirror, relative)).catch(() => null)).toBeNull();
  } finally {
    await f.close();
  }
});

test('an unavailable reaped mirror retains its row for reconnect and retry even with returned source bytes', async () => {
  const f = await fixture();
  const parked = path.join(f.directory, 'parked-mirror');
  try {
    await fs.rename(f.mirror, parked);
    const response = await f.purge();
    expect(response.status).toBe(500);
    expect(await response.text()).toContain('Reconnect the source/mirror');
    expect(f.live.db.query('SELECT id FROM assets WHERE id=?').get(f.assetId)).toEqual({
      id: f.assetId,
    });
    expect(await f.repo.purges(f.destination.id)).toEqual([]);
    await expectOriginals(f.primary, f.contents);
    await fs.rename(parked, f.mirror);
    expect((await f.purge()).status).toBe(204);
    await f.drain();
    expect((await f.repo.purges(f.destination.id))[0]!.completed).toBe(1);
  } finally {
    await f.close();
  }
});

test('hashing an unknown mirror alone cannot authorize deleting a reaped identity without source or retained SHA', async () => {
  const f = await fixture();
  const parked = path.join(f.directory, 'parked-source');
  try {
    await fs.rename(f.primary, parked);
    const response = await f.purge();
    expect(response.status).toBe(500);
    expect(await response.text()).toContain('manually verify and remove the retained mirror copy');
    expect(f.live.db.query('SELECT id FROM assets WHERE id=?').get(f.assetId)).toEqual({
      id: f.assetId,
    });
    expect(f.live.db.query("SELECT id FROM backup_lifecycle WHERE kind='purge'").all()).toEqual([]);
    await expectOriginals(f.mirror, f.contents);
    await fs.rename(parked, f.primary);
    expect((await f.purge()).status).toBe(204);
  } finally {
    await f.close();
  }
});

test('a newer mirror occupant cannot inherit an old reaped asset purge from its filename', async () => {
  const f = await fixture(true);
  try {
    await fs.writeFile(path.join(f.mirror, 'sub/photo.dng'), 'a newer unrelated photo');
    const response = await f.purge();
    expect(response.status).toBe(500);
    expect(f.live.db.query('SELECT id FROM assets WHERE id=?').get(f.assetId)).toEqual({
      id: f.assetId,
    });
    expect(await f.repo.purges(f.destination.id)).toEqual([]);
    expect(await fs.readFile(path.join(f.mirror, 'sub/photo.dng'), 'utf8')).toBe(
      'a newer unrelated photo',
    );
    await expectOriginals(f.primary, f.contents);
  } finally {
    await f.close();
  }
});

test('a secondary library mirror erases its recorded original without claiming an unrelated companion namesake', async () => {
  const f = await fixture();
  try {
    const source = path.join(f.directory, 'second-source');
    const mirror = path.join(f.directory, 'second-mirror');
    for (const root of [source, mirror]) {
      await fs.mkdir(path.join(root, 'sub'), { recursive: true });
      await fs.writeFile(path.join(root, 'sub/photo.dng'), 'original photo bytes');
      await fs.writeFile(path.join(root, 'sub/photo-rendered.jpg'), 'unrelated library photo');
    }
    const libraryId = insertFolder(f.live.db, { path: source });
    insertLocation(f.live.db, {
      assetId: f.assetId,
      libraryId,
      ordinal: 1,
      path: 'sub',
      filename: 'photo.dng',
    });
    const destination = await f.repo.createDestination({
      libraryId,
      kind: 'folder',
      name: 'Second mirror',
      path: mirror,
    });
    expect((await f.purge()).status).toBe(204);
    await drainPurges(new BackupEngine(async () => createTestProvider(), f.repo), destination);
    expect(await fs.stat(path.join(mirror, 'sub/photo.dng')).catch(() => null)).toBeNull();
    expect(await fs.readFile(path.join(mirror, 'sub/photo-rendered.jpg'), 'utf8')).toBe(
      'unrelated library photo',
    );
    expect(await fs.readFile(path.join(source, 'sub/photo.dng'), 'utf8')).toBe(
      'original photo bytes',
    );
  } finally {
    await f.close();
  }
});
