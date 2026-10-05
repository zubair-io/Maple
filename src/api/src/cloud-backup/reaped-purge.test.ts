import { expect, spyOn, test } from 'bun:test';
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
import { BackupRepository } from './repository.ts';
import { BackupEngine, entryPrefix } from './engine.ts';
import { createTestProvider } from './test-provider.test-helpers.ts';
import { readRemoteCatalog } from './catalog.ts';
import { preparePurge } from './lifecycle.ts';
import { drainPurges } from './purge.ts';
import { runTrashGcOnce } from '../workers/trash-gc.ts';
import { buildApp } from '../index.ts';
import { signAccessToken } from '../auth/tokens.ts';
import type { SqlValue } from '../db/sqlite/protocol.ts';

async function reapedFixture() {
  const live = await createLiveTestDatabase();
  const directory = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'maple-reaped-backup-')));
  const primary = join(directory, 'primary');
  await fs.mkdir(primary);
  const libraryId = insertFolder(live.db, { path: primary });
  const assetId = insertAsset(live.db);
  insertLocation(live.db, { assetId, libraryId, path: '', filename: 'photo.dng' });
  await fs.writeFile(join(primary, 'photo.dng'), 'returned original bytes');
  await fs.writeFile(join(primary, 'photo.xmp'), '<xmp>returned exact sidecar</xmp>');
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
  expect(await engine.backupAsset(assetId)).toBe(true);
  const old = new Date(Date.now() - 60 * 86_400_000).toISOString();
  run(live.db, 'UPDATE asset_locations SET missing_since=? WHERE asset_id=?', old, assetId);
  run(live.db, "UPDATE assets SET deleted_at=?,deleted_reason='reaped' WHERE id=?", old, assetId);
  return {
    live,
    directory,
    primary,
    assetId,
    repo,
    destination,
    provider,
    engine,
    async [Symbol.asyncDispose]() {
      await fs.rm(directory, { recursive: true, force: true });
      live.close();
    },
  };
}

test('reaped backup survives default retention while its volume is absent without remote purge intent', async () => {
  await using fixture = await reapedFixture();
  const { primary, directory, assetId, repo, destination, provider, live } = fixture;
  const parked = join(directory, 'offline-volume');
  await fs.rename(primary, parked);
  const remote = [...provider.objects.values()].map((row) => row.object);
  const writes = spyOn(live.handle, 'write');
  expect(await runTrashGcOnce({ retentionDays: 30 })).toEqual({ scanned: 1, purged: 0, errors: 0 });
  const issued = writes.mock.calls.find(([sql]) => sql.startsWith('DELETE FROM assets'))!;
  writes.mockRestore();
  const plan = live.db
    .query('EXPLAIN QUERY PLAN ' + issued[0])
    .all(...(issued[1] as SqlValue[])) as Array<{
    detail: string;
  }>;
  expect(plan.map((row) => row.detail).join('\n')).toContain('backup_entries_asset');
  expect(plan.map((row) => row.detail).join('\n')).not.toContain('SCAN backup_entries');
  expect(live.db.query('SELECT id FROM assets WHERE id=?').get(assetId)).toEqual({ id: assetId });
  expect(await repo.purges(destination.id)).toEqual([]);
  expect(live.db.query("SELECT id FROM backup_lifecycle WHERE kind='purge'").all()).toEqual([]);
  expect([...provider.objects.values()].map((row) => row.object)).toEqual(remote);
  expect((await readRemoteCatalog(provider)).entries).toHaveLength(1);
  expect(await fs.readFile(join(parked, 'photo.dng'), 'utf8')).toBe('returned original bytes');
  expect(await fs.readFile(join(parked, 'photo.xmp'), 'utf8')).toBe(
    '<xmp>returned exact sidecar</xmp>',
  );
});

test('owner permanent delete records reaped purge before hard-delete and erases remote versions after reconnect', async () => {
  await using fixture = await reapedFixture();
  const { primary, assetId, repo, destination, provider, live, engine } = fixture;
  live.db.exec(`CREATE TRIGGER require_reaped_purge_intent BEFORE DELETE ON assets
    WHEN NOT EXISTS(SELECT 1 FROM backup_lifecycle WHERE asset_id=OLD.id AND kind='purge')
    BEGIN SELECT RAISE(ABORT,'Purge intent must precede asset deletion'); END;`);
  const previous = process.env.MAPLE_JWT_SECRET;
  const secret = 'reaped-permanent-delete-owner-secret';
  process.env.MAPLE_JWT_SECRET = secret;
  try {
    const token = await signAccessToken(
      { sub: '111111111111111111111111', email: null, role: 'owner', file_access: true },
      secret,
    );
    const app = buildApp({ stageNames: [] });
    const response = await app.handle(
      new Request(`http://localhost/api/assets/${assetId}?intent=purge`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      }),
    );
    expect(response.status).toBe(204);
  } finally {
    process.env.MAPLE_JWT_SECRET = previous;
  }
  expect(live.db.query('SELECT id FROM assets WHERE id=?').get(assetId)).toBeNull();
  const entry = (await repo.entries(destination.id))[0]!;
  expect(entry.state).toBe('purged');
  expect((await repo.purges(destination.id))[0]!.completed).toBe(0);
  expect(await fs.readFile(join(primary, 'photo.dng'), 'utf8')).toBe('returned original bytes');
  expect(await fs.readFile(join(primary, 'photo.xmp'), 'utf8')).toBe(
    '<xmp>returned exact sidecar</xmp>',
  );
  provider.offline = true;
  await drainPurges(engine, destination);
  expect((await repo.purges(destination.id))[0]!.completed).toBe(0);
  provider.offline = false;
  await drainPurges(engine, destination);
  expect((await repo.purges(destination.id))[0]!.completed).toBe(1);
  expect((await readRemoteCatalog(provider)).entries).toEqual([]);
  expect(
    [...provider.objects.keys()].some((key) =>
      key.startsWith(entryPrefix(destination.libraryId, entry.id)),
    ),
  ).toBe(false);
});

test('retention resumes database cleanup after explicit reaped purge intent survived an interruption', async () => {
  await using fixture = await reapedFixture();
  const { primary, assetId, repo, destination, live } = fixture;
  await preparePurge(assetId, repo);
  expect(await runTrashGcOnce({ retentionDays: 30 })).toEqual({ scanned: 1, purged: 1, errors: 0 });
  expect(live.db.query('SELECT id FROM assets WHERE id=?').get(assetId)).toBeNull();
  expect(await repo.purges(destination.id)).toHaveLength(1);
  expect(await fs.readFile(join(primary, 'photo.dng'), 'utf8')).toBe('returned original bytes');
});

test('a backup admitted after retention candidate selection atomically preserves the reaped row', async () => {
  using live = await createLiveTestDatabase();
  const libraryId = insertFolder(live.db);
  const assetId = insertAsset(live.db, {
    deletedAt: new Date(Date.now() - 60 * 86_400_000).toISOString(),
  });
  run(live.db, "UPDATE assets SET deleted_reason='reaped' WHERE id=?", assetId);
  const repo = new BackupRepository(live.handle);
  const destination = await repo.createDestination({
    libraryId,
    kind: 'google-drive',
    name: 'Drive',
    path: null,
  });
  const originalWrite = live.handle.write;
  const writes = spyOn(live.handle, 'write').mockImplementation(async (sql, params) => {
    if (sql.startsWith('DELETE FROM assets'))
      await repo.ensureEntry(destination.id, assetId, 0, 'photo.dng');
    return originalWrite(sql, params);
  });
  try {
    expect(await runTrashGcOnce({ retentionDays: 30 })).toEqual({
      scanned: 1,
      purged: 0,
      errors: 0,
    });
  } finally {
    writes.mockRestore();
  }
  expect(live.db.query('SELECT id FROM assets WHERE id=?').get(assetId)).toEqual({ id: assetId });
  expect(await repo.entries(destination.id)).toHaveLength(1);
  expect(await repo.purges(destination.id)).toEqual([]);
});
