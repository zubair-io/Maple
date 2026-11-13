/**
 * #5837: one folder destination, end to end through the mounted routes. A real
 * library and a real destination directory, the real mirror writer, the scan
 * and copy passes behind "Reconcile now", the real trash, restore and
 * permanent-delete routes, and one real SQLite database. Nothing is copied into
 * the destination by the test itself.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { signAccessToken } from '../auth/tokens.ts';
import { maintainBackup } from '../cloud-backup/runtime.ts';
import {
  createLiveTestDatabase,
  insertAsset,
  insertFolder,
  insertLocation,
  type LiveTestDatabase,
} from '../db/sqlite/test-sqlite.test-helpers.ts';
import { clearMirrorRoots, snapshotMirrorRoots } from '../fs/mirror-registry.ts';
import {
  flushPendingMirrorOps,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from '../fs/mirrored.ts';
import { buildApp } from '../index.ts';
import { invalidateLibraryRoots } from '../indexer/libraries.cache.ts';
import { runMirrorCopyOnce } from '../workers/mirror/copy.ts';
import { runMirrorScanOnce } from '../workers/mirror/scan.ts';

const FOLDER = '2024/Trip';
const RAW = 'IMG_0042.dng';
const XMP = 'IMG_0042.xmp';
const KEPT = 'IMG_0043.dng';
const RAW_BYTES = 'round-trip-original-bytes';
const XMP_BYTES =
  '<x:xmpmeta xmlns:x="adobe:ns:meta/"><vendor:unknown keep="byte-for-byte"/></x:xmpmeta>\n';
const KEPT_BYTES = 'neighbour-original-bytes';
const SECRET = 'folder-roundtrip-owner-test-secret-long';

let live: LiveTestDatabase;
let directory: string;
let library: string;
let destinationRoot: string;
let libraryId: string;
let assetId: string;
let owner: string;
let previousSecret: string | undefined;
let app: ReturnType<typeof buildApp>;

beforeEach(async () => {
  clearMirrorRoots();
  live = await createLiveTestDatabase();
  directory = await realpath(await mkdtemp(path.join(tmpdir(), 'maple-folder-roundtrip-')));
  library = path.join(directory, 'library');
  destinationRoot = path.join(directory, 'destination');
  await mkdir(path.join(library, FOLDER), { recursive: true });
  await mkdir(destinationRoot);
  await writeFile(path.join(library, FOLDER, RAW), RAW_BYTES);
  await writeFile(path.join(library, FOLDER, XMP), XMP_BYTES);
  await writeFile(path.join(library, FOLDER, KEPT), KEPT_BYTES);
  libraryId = insertFolder(live.db, { path: library });
  invalidateLibraryRoots();
  assetId = insertAsset(live.db);
  insertLocation(live.db, { assetId, libraryId, path: FOLDER, filename: RAW });
  insertLocation(live.db, {
    assetId: insertAsset(live.db),
    libraryId,
    path: FOLDER,
    filename: KEPT,
  });
  previousSecret = process.env.MAPLE_JWT_SECRET;
  process.env.MAPLE_JWT_SECRET = SECRET;
  owner = await signAccessToken(
    { sub: '111111111111111111111111', email: null, role: 'owner', file_access: true },
    SECRET,
  );
  app = buildApp({ stageNames: [] });
});

afterEach(async () => {
  await flushPendingMirrorOps();
  clearMirrorRoots();
  invalidateLibraryRoots();
  await rm(directory, { recursive: true, force: true });
  live.close();
  process.env.MAPLE_JWT_SECRET = previousSecret;
});

function request(url: string, method = 'GET', body?: unknown) {
  return app.handle(
    new Request('http://localhost' + url, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${owner}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

const read = (root: string, relative: string) =>
  readFile(path.join(root, relative), 'utf8').catch(() => null);

/** The same relative path read from the library and from the destination. */
const both = async (relative: string) => [
  await read(library, relative),
  await read(destinationRoot, relative),
];

function trashLocation() {
  const row = live.db
    .query(`SELECT path, filename FROM asset_locations WHERE asset_id = ?`)
    .get(assetId) as { path: string; filename: string };
  return path.posix.join(row.path, row.filename);
}

async function purgePending(id: string) {
  const { destinations } = (await (await request('/api/cloud-backup/destinations')).json()) as {
    destinations: Array<{ id: string; status: { purgePending: number } }>;
  };
  return destinations.find((row) => row.id === id)!.status.purgePending;
}

test('a folder destination mirrors a library, follows Trash and Restore, and erases on Permanent Delete', async () => {
  const created = await request('/api/cloud-backup/destinations', 'POST', {
    libraryId,
    kind: 'folder',
    name: 'Shared folder',
    path: destinationRoot,
  });
  expect(created.status).toBe(200);
  const { destination } = (await created.json()) as {
    destination: { id: string; kind: string; path: string; enabled: boolean };
  };
  expect(destination).toMatchObject({ kind: 'folder', path: destinationRoot, enabled: false });
  expect(snapshotMirrorRoots()).toEqual({});
  expect(
    (
      await request(`/api/cloud-backup/destinations/${destination.id}`, 'PATCH', {
        enabled: true,
      })
    ).status,
  ).toBe(200);
  expect(snapshotMirrorRoots()).toEqual({ [library]: [destinationRoot] });
  expect(await read(destinationRoot, `${FOLDER}/${RAW}`)).toBeNull();

  expect(await runMirrorScanOnce()).toMatchObject({ enqueued: 3, errors: 0, skippedOffline: 0 });
  expect(await runMirrorCopyOnce()).toEqual({ claimed: 3, copied: 3, skipped: 0, failed: 0 });
  expect((await (await request('/api/mirror/status')).json()).queue).toEqual({
    pending: 0,
    dead: 0,
  });
  expect(await both(`${FOLDER}/${RAW}`)).toEqual([RAW_BYTES, RAW_BYTES]);
  expect(await both(`${FOLDER}/${XMP}`)).toEqual([XMP_BYTES, XMP_BYTES]);
  expect(await both(`${FOLDER}/${KEPT}`)).toEqual([KEPT_BYTES, KEPT_BYTES]);

  expect((await request(`/api/assets/${assetId}?intent=trash`, 'DELETE')).status).toBe(204);
  await flushPendingMirrorOps();
  const trashedRaw = trashLocation();
  const trashedXmp = trashedRaw.replace(/\.dng$/, '.xmp');
  expect(trashedRaw.startsWith('.maple/trash/')).toBe(true);
  expect(await both(trashedRaw)).toEqual([RAW_BYTES, RAW_BYTES]);
  expect(await both(trashedXmp)).toEqual([XMP_BYTES, XMP_BYTES]);
  expect(await both(`${FOLDER}/${RAW}`)).toEqual([null, null]);
  expect(await both(`${FOLDER}/${XMP}`)).toEqual([null, null]);

  const restored = await request(`/api/assets/${assetId}/restore`, 'POST', {});
  expect(restored.status).toBe(200);
  await flushPendingMirrorOps();
  expect(await both(`${FOLDER}/${RAW}`)).toEqual([RAW_BYTES, RAW_BYTES]);
  expect(await both(`${FOLDER}/${XMP}`)).toEqual([XMP_BYTES, XMP_BYTES]);
  expect(await both(trashedRaw)).toEqual([null, null]);
  expect(await both(trashedXmp)).toEqual([null, null]);

  expect((await request(`/api/assets/${assetId}?intent=trash`, 'DELETE')).status).toBe(204);
  await flushPendingMirrorOps();
  const purgedRaw = trashLocation();
  const purgedXmp = purgedRaw.replace(/\.dng$/, '.xmp');
  expect(await both(purgedRaw)).toEqual([RAW_BYTES, RAW_BYTES]);

  expect((await request(`/api/assets/${assetId}?intent=purge`, 'DELETE')).status).toBe(204);
  await flushPendingMirrorOps();
  expect(await read(library, purgedRaw)).toBeNull();
  expect(await read(library, purgedXmp)).toBeNull();
  expect(live.db.query(`SELECT id FROM assets WHERE id = ?`).get(assetId)).toBeNull();
  expect(await read(destinationRoot, purgedRaw)).toBe(RAW_BYTES);
  expect(await purgePending(destination.id)).toBe(1);
  expect((await request(`/api/cloud-backup/destinations/${destination.id}`, 'DELETE')).status).toBe(
    400,
  );

  await maintainBackup();
  expect(await both(purgedRaw)).toEqual([null, null]);
  expect(await both(purgedXmp)).toEqual([null, null]);
  expect(await both(`${FOLDER}/${RAW}`)).toEqual([null, null]);
  expect(await purgePending(destination.id)).toBe(0);
  expect(await both(`${FOLDER}/${KEPT}`)).toEqual([KEPT_BYTES, KEPT_BYTES]);

  expect((await request(`/api/cloud-backup/destinations/${destination.id}`, 'DELETE')).status).toBe(
    200,
  );
  expect(snapshotMirrorRoots()).toEqual({});
  expect(await (await request(`/api/folders/${libraryId}/mirror`)).json()).toEqual({ mirrors: [] });
  expect((await stat(path.join(destinationRoot, FOLDER, KEPT))).size).toBe(KEPT_BYTES.length);
});
