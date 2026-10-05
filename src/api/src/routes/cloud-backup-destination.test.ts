import { expect, test } from 'bun:test';
import { buildApp } from '../index.ts';
import * as os from 'node:os';
import * as path from 'node:path';
import { mkdtemp, mkdir, realpath, rm } from '../fs/mirrored.ts';
import { setMirrorRoots } from '../fs/mirror-registry.ts';
import { signAccessToken } from '../auth/tokens.ts';
import {
  createLiveTestDatabase,
  insertAsset,
  insertFolder,
  insertLocation,
} from '../db/sqlite/test-sqlite.test-helpers.ts';
import { BackupRepository } from '../cloud-backup/repository.ts';
import { preparePurge } from '../cloud-backup/lifecycle.ts';

async function fixture() {
  const live = await createLiveTestDatabase();
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'maple-backup-route-')));
  const libraryPath = path.join(root, 'library');
  const mirrorPath = path.join(root, 'mirror');
  await mkdir(libraryPath);
  await mkdir(mirrorPath);
  const libraryId = insertFolder(live.db, { path: libraryPath });
  const previous = process.env.MAPLE_JWT_SECRET;
  process.env.MAPLE_JWT_SECRET = 'backup-destination-route-owner-test-secret';
  const token = await signAccessToken(
    { sub: '111111111111111111111111', email: null, role: 'owner', file_access: true },
    process.env.MAPLE_JWT_SECRET,
  );
  const app = buildApp({ stageNames: [] });
  const repo = new BackupRepository(live.handle);
  return {
    live,
    root,
    libraryPath,
    mirrorPath,
    libraryId,
    repo,
    request(id: string, method: string, body?: unknown) {
      return app.handle(
        new Request(`http://localhost/api/cloud-backup/destinations/${id}`, {
          method,
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      );
    },
    async [Symbol.asyncDispose]() {
      setMirrorRoots(new Map());
      process.env.MAPLE_JWT_SECRET = previous;
      live.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('Drive destinations can be renamed or paused but require an attached root before enabling', async () => {
  await using f = await fixture();
  const destination = await f.repo.createDestination({
    libraryId: f.libraryId,
    kind: 'google-drive',
    name: 'Drive',
    path: null,
  });
  expect((await f.request(destination.id, 'PATCH', { name: 'Photo archive' })).status).toBe(200);
  const rejected = await f.request(destination.id, 'PATCH', { enabled: true });
  expect(rejected.status).toBe(400);
  expect(await rejected.json()).toMatchObject({
    code: 'bad_request',
    error: 'Backup request rejected; check the supplied settings',
  });
  expect((await f.repo.destination(destination.id))!.enabled).toBe(false);
  await f.repo.db.write('UPDATE backup_destinations SET root_id=? WHERE id=?', [
    'owned-root',
    destination.id,
  ]);
  expect((await f.request(destination.id, 'PATCH', { enabled: true })).status).toBe(200);
  expect((await f.request(destination.id, 'PATCH', { enabled: false })).status).toBe(200);
  expect((await f.repo.destination(destination.id))!.name).toBe('Photo archive');
});

test('folder destination roots cannot be repointed and an unavailable root cannot be enabled', async () => {
  await using f = await fixture();
  const destination = await f.repo.createDestination({
    libraryId: f.libraryId,
    kind: 'folder',
    name: 'Mirror',
    path: f.mirrorPath,
  });
  expect(
    (await f.request(destination.id, 'PATCH', { enabled: true, path: f.mirrorPath })).status,
  ).toBe(200);
  const repoint = await f.request(destination.id, 'PATCH', { path: f.libraryPath });
  expect(repoint.status).toBe(400);
  expect(await repoint.json()).toMatchObject({
    code: 'bad_request',
    error: 'Backup request rejected; check the supplied settings',
  });
  expect((await f.request(destination.id, 'PATCH', { enabled: false })).status).toBe(200);
  await rm(f.mirrorPath, { recursive: true });
  expect((await f.request(destination.id, 'PATCH', { enabled: true })).status).toBe(400);
  expect((await f.repo.destination(destination.id))!.path).toBe(f.mirrorPath);
  expect((await f.repo.destination(destination.id))!.enabled).toBe(false);
});

test('destination removal cannot abandon an active transfer or a permanent purge obligation', async () => {
  await using f = await fixture();
  const destination = await f.repo.createDestination({
    libraryId: f.libraryId,
    kind: 'google-drive',
    name: 'Drive',
    path: null,
  });
  const assetId = insertAsset(f.live.db);
  insertLocation(f.live.db, { assetId, libraryId: f.libraryId });
  const entry = await f.repo.ensureEntry(destination.id, assetId, 0, 'photo.dng');
  await f.repo.db.write('UPDATE backup_entries SET lease_until=? WHERE id=?', [
    Date.now() + 60_000,
    entry.id,
  ]);
  const active = await f.request(destination.id, 'DELETE');
  expect(active.status).toBe(400);
  expect(await active.json()).toMatchObject({
    code: 'bad_request',
    error: 'Backup request rejected; check the supplied settings',
  });
  await f.repo.db.write('UPDATE backup_entries SET lease_until=0 WHERE id=?', [entry.id]);
  await preparePurge(assetId, f.repo);
  const purge = await f.request(destination.id, 'DELETE');
  expect(purge.status).toBe(400);
  expect(await purge.json()).toMatchObject({
    code: 'bad_request',
    error: 'Backup request rejected; check the supplied settings',
  });
  expect(await f.repo.destination(destination.id)).not.toBeNull();
  await f.repo.db.write('UPDATE backup_purges SET completed=1 WHERE destination_id=?', [
    destination.id,
  ]);
  expect((await f.request(destination.id, 'DELETE')).status).toBe(200);
  expect(await f.repo.destination(destination.id)).toBeNull();
});

test('removing a folder destination removes its compatibility projection', async () => {
  await using f = await fixture();
  const destination = await f.repo.createDestination({
    libraryId: f.libraryId,
    kind: 'folder',
    name: 'Mirror',
    path: f.mirrorPath,
  });
  expect((await f.request(destination.id, 'PATCH', { enabled: true })).status).toBe(200);
  expect((await f.request(destination.id, 'DELETE')).status).toBe(200);
  const [row] = await f.repo.db.read<{ mirrors: string }>(
    'SELECT mirrors FROM folders WHERE id=?',
    [f.libraryId],
  );
  expect(JSON.parse(row!.mirrors)).toEqual([]);
});
