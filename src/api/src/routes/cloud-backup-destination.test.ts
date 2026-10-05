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
import { saveConfig, savePending } from '../cloud-backup/google/repo.ts';
import { DEFAULT_GOOGLE_CONFIG } from '../cloud-backup/google/config.ts';

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

const destinationTables = [
  'backup_entries',
  'backup_objects',
  'backup_purges',
  'backup_google_connections',
  'backup_google_oauth',
] as const;
async function destinationState(f: Awaited<ReturnType<typeof fixture>>, id: string) {
  return Promise.all(
    destinationTables.map((table) =>
      f.repo.db.read(`SELECT * FROM ${table} WHERE destination_id=?`, [id]),
    ),
  );
}
async function seededDestination(f: Awaited<ReturnType<typeof fixture>>) {
  const row = await f.repo.createDestination({
    libraryId: f.libraryId,
    kind: 'google-drive',
    name: 'Archive',
    path: null,
  });
  const assetId = insertAsset(f.live.db);
  insertLocation(f.live.db, { assetId, libraryId: f.libraryId });
  const entry = await f.repo.ensureEntry(row.id, assetId, 0, 'photo.dng');
  await f.repo.db.write(
    'INSERT INTO backup_objects(destination_id,key,entry_id,object,checkpoint) VALUES(?,?,?,?,?)',
    [
      row.id,
      'blobs/photo',
      entry.id,
      JSON.stringify({ locator: 'remote-photo' }),
      JSON.stringify({ provider: 'google-drive', fileId: 'reserved-upload', offset: 1024 }),
    ],
  );
  await f.repo.db.write(
    'INSERT INTO backup_purges(destination_id,entry_id,record,completed) VALUES(?,?,?,1)',
    [row.id, entry.id, JSON.stringify({ entryId: entry.id })],
  );
  await saveConfig(
    row.id,
    {
      ...DEFAULT_GOOGLE_CONFIG,
      clientId: '12345-example.apps.googleusercontent.com',
      clientSecret: 'local-secret',
      refreshToken: 'local-refresh',
    },
    0,
  );
  await savePending({
    nonce: crypto.randomUUID(),
    destinationId: row.id,
    ownerId: '111111111111111111111111',
    epoch: 1,
    expiresAt: Date.now() + 600_000,
    state: crypto.randomUUID(),
    cookieHash: 'pending-browser',
    verifier: 'local-verifier',
    redirectUri: 'https://photos.example.com/api/cloud-backup/google/callback',
    callback: 'https://photos.example.com/api/cloud-backup/google/callback',
  });
  return { row, entry, assetId };
}

test('destination removal atomically forgets its local state and leaves other archives and source assets intact', async () => {
  await using f = await fixture();
  const selected = await seededDestination(f);
  const other = await seededDestination(f);
  const otherState = await destinationState(f, other.row.id);
  const source = f.live.db.query('SELECT * FROM assets WHERE id=?').get(selected.assetId);
  await f.repo.db.write(
    `INSERT INTO backup_lifecycle
    (id,asset_id,library_id,kind,phase,created_at) VALUES(?,?,?,'trash','committed',?)`,
    [crypto.randomUUID(), selected.assetId, f.libraryId, new Date().toISOString()],
  );
  const lifecycle = await f.repo.db.read('SELECT * FROM backup_lifecycle');
  expect((await destinationState(f, selected.row.id)).every((rows) => rows.length === 1)).toBe(
    true,
  );
  expect((await f.request(selected.row.id, 'DELETE')).status).toBe(200);
  expect(await f.repo.destination(selected.row.id)).toBeNull();
  expect(await destinationState(f, selected.row.id)).toEqual([[], [], [], [], []]);
  expect(await destinationState(f, other.row.id)).toEqual(otherState);
  expect(await f.repo.destination(other.row.id)).not.toBeNull();
  expect(f.live.db.query('SELECT * FROM assets WHERE id=?').get(selected.assetId)).toEqual(source);
  expect(await f.repo.db.read('SELECT * FROM backup_lifecycle')).toEqual(lifecycle);
});

test('removing an absent destination cannot discard orphaned credentials or cleanup records', async () => {
  await using f = await fixture();
  const { row } = await seededDestination(f);
  const before = await destinationState(f, row.id);
  await f.repo.db.write('DELETE FROM backup_destinations WHERE id=?', [row.id]);
  expect((await f.request(row.id, 'DELETE')).status).toBe(400);
  expect(await destinationState(f, row.id)).toEqual(before);
});

for (const obligation of ['purge', 'transfer'] as const) {
  test(`a ${obligation} admitted after the route precheck prevents all child cleanup`, async () => {
    await using f = await fixture();
    const { row, entry } = await seededDestination(f);
    const before = await destinationState(f, row.id);
    const transaction = f.live.handle.transaction.bind(f.live.handle);
    // Admit real durable work after the advisory reads but before BEGIN IMMEDIATE.
    f.live.handle.transaction = async (statements) => {
      if (obligation === 'purge') {
        await f.repo.db.write('UPDATE backup_purges SET completed=0 WHERE destination_id=?', [
          row.id,
        ]);
      } else {
        await f.repo.db.write('UPDATE backup_entries SET lease_until=? WHERE id=?', [
          Date.now() + 60_000,
          entry.id,
        ]);
      }
      return transaction(statements);
    };
    expect((await f.request(row.id, 'DELETE')).status).toBe(400);
    expect(await f.repo.destination(row.id)).not.toBeNull();
    const after = await destinationState(f, row.id);
    expect(after.map((rows) => rows.length)).toEqual([1, 1, 1, 1, 1]);
    expect(after[1]).toEqual(before[1]);
    expect(after[3]).toEqual(before[3]);
    expect(after[4]).toEqual(before[4]);
    const [purge] = await f.repo.purges(row.id);
    const [savedEntry] = await f.repo.entries(row.id);
    expect(purge!.completed).toBe(obligation === 'purge' ? 0 : 1);
    expect(savedEntry!.lease_until > Date.now()).toBe(obligation === 'transfer');
  });
}

test('a child cleanup SQL failure rolls back the destination and credentials already deleted in the transaction', async () => {
  await using f = await fixture();
  const { row } = await seededDestination(f);
  const before = await destinationState(f, row.id);
  f.live.db.exec(`CREATE TRIGGER refuse_object_cleanup BEFORE DELETE ON backup_objects
    BEGIN SELECT RAISE(ABORT,'Injected cleanup failure'); END;`);
  expect((await f.request(row.id, 'DELETE')).status).toBe(500);
  expect(await f.repo.destination(row.id)).not.toBeNull();
  expect(await destinationState(f, row.id)).toEqual(before);
});
