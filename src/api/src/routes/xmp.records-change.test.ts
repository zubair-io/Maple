/**
 * #3563 — the path-keyed sidecar routes (the ones the web editor writes
 * through) must leave the same trail the id-keyed `PUT/DELETE
 * /api/assets/:id/xmp` do: `has_xmp` / `sidecar_ver` on the asset and an
 * `update` row on the change feed, so the File Provider extensions learn
 * that a mounted folder's `.xmp` changed on the server.
 *
 * Runs against SQLite (#3787): a private in-memory database per test,
 * installed as the process-wide handle, so the route's own `sqliteDb()` calls
 * reach it. Nothing skips — there is no external service to be unreachable.
 *
 * Note on the change-feed vocabulary: the cursor is allocated by the insert
 * itself now (`asset_changes.cursor` is an INTEGER PRIMARY KEY, hence a rowid
 * alias), so there is no separate allocation step to assert on — the rows
 * `listChangesSince` returns are the whole record.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { xmpPathRoutes } from './xmp.ts';
import {
  __resetChangeFolderPathCacheForTests,
  listChangesSince,
} from '../db/sqlite/repos/changes.repo.ts';
import { invalidateLibraryRoots } from '../indexer/libraries.cache.ts';
import { registerLibrary, seedRouteAsset } from '../../tests/helpers/assets-route-fixtures.ts';
import {
  createLiveTestDatabase,
  run,
  type LiveTestDatabase,
} from '../db/sqlite/test-sqlite.test-helpers.ts';

let live: LiveTestDatabase;
let tmp: string;
let libraryId: string;
let originalMapleRoots: string | undefined;

const app = new Elysia().use(xmpPathRoutes);

beforeEach(async () => {
  live = await createLiveTestDatabase();
  // realpath: on macOS os.tmpdir() sits under the /var → /private/var symlink,
  // and the write jail realpaths before its root check.
  tmp = await realpath(await mkdtemp(join(tmpdir(), 'maple-xmp-path-changes-')));
  // Captured inside the hook, not at module scope: bun runs every module body
  // before any hook, so a module-scope read would see whatever an earlier test
  // file left in the environment.
  originalMapleRoots = process.env.MAPLE_ROOTS;
  process.env.MAPLE_ROOTS = tmp;
  libraryId = registerLibrary(live.db, tmp);
});

afterEach(async () => {
  if (originalMapleRoots === undefined) delete process.env.MAPLE_ROOTS;
  else process.env.MAPLE_ROOTS = originalMapleRoots;
  invalidateLibraryRoots();
  // The change feed memoises folder id → root path for the life of the
  // process; each test registers its own library, so the cache is dropped with
  // the database that backed it.
  __resetChangeFolderPathCacheForTests();
  live.close();
  await rm(tmp, { recursive: true, force: true });
});

/** One indexed asset at the library root, optionally already carrying a sidecar. */
function seedIndexedAsset(filename: string, hasXmp: boolean): string {
  const assetId = seedRouteAsset(live.db, { libraryId, path: '', filename, size: 8 });
  if (hasXmp) run(live.db, `UPDATE assets SET has_xmp = 1 WHERE id = ?`, assetId);
  return assetId;
}

/** The two sidecar columns the route maintains. */
function sidecarState(assetId: string): { has_xmp: number; sidecar_ver: number } | null {
  return (live.db.query(`SELECT has_xmp, sidecar_ver FROM assets WHERE id = ?`).get(assetId) ??
    null) as { has_xmp: number; sidecar_ver: number } | null;
}

describe('path-keyed XMP routes — change emission (#3563)', () => {
  it('POST /api/xmp?path= records the edit and emits an update row', async () => {
    const rawPath = join(tmp, 'a.dng');
    await writeFile(rawPath, Buffer.alloc(8));
    const assetId = seedIndexedAsset('a.dng', false);

    const res = await app.handle(
      new Request(`http://localhost/api/xmp?path=${encodeURIComponent(rawPath)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/xml' },
        body: '<x:xmpmeta />',
      }),
    );
    expect(res.status).toBe(200);
    expect(await readFile(join(tmp, 'a.xmp'), 'utf8')).toBe('<x:xmpmeta />');

    const changes = await listChangesSince(live.handle, { since: 0, limit: 10 });
    expect(changes.length).toBe(1);
    expect(changes[0]?.asset_id?.toHexString()).toBe(assetId);
    expect(changes[0]?.kind).toBe('update');
    expect(changes[0]?.relative_path).toBe('a.dng');

    expect(sidecarState(assetId)).toEqual({ has_xmp: 1, sidecar_ver: 1 });
  });

  it('DELETE /api/xmp?path= clears has_xmp and emits an update row', async () => {
    const rawPath = join(tmp, 'b.dng');
    await writeFile(rawPath, Buffer.alloc(8));
    await writeFile(join(tmp, 'b.xmp'), '<x:xmpmeta />');
    const assetId = seedIndexedAsset('b.dng', true);

    const res = await app.handle(
      new Request(`http://localhost/api/xmp?path=${encodeURIComponent(rawPath)}`, {
        method: 'DELETE',
      }),
    );
    expect(res.status).toBe(204);

    const changes = await listChangesSince(live.handle, { since: 0, limit: 10 });
    expect(changes.length).toBe(1);
    expect(changes[0]?.asset_id?.toHexString()).toBe(assetId);

    expect(sidecarState(assetId)?.has_xmp).toBe(0);
  });

  it('POST for an unindexed path still writes and emits nothing', async () => {
    const rawPath = join(tmp, 'unindexed.dng');
    await writeFile(rawPath, Buffer.alloc(8));
    seedIndexedAsset('other.dng', false);

    const res = await app.handle(
      new Request(`http://localhost/api/xmp?path=${encodeURIComponent(rawPath)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/xml' },
        body: '<x:xmpmeta />',
      }),
    );
    expect(res.status).toBe(200);
    expect(await listChangesSince(live.handle, { since: 0, limit: 10 })).toHaveLength(0);
  });
});
