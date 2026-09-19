/**
 * Route-integration test: the sidecar routes emit change-feed rows.
 *
 * `PUT`/`DELETE /api/assets/:id/xmp` each write the sidecar, flip `has_xmp` and
 * append a row to the journal. The journal is `asset_changes` in SQLite now, so
 * the assertion reads it back through `listChangesSince` from
 * `db/sqlite/repos/changes.repo.ts` (#3787).
 *
 * Each test gets a private database installed as the process-wide handle — what
 * the route resolves — plus its own temp library root.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assetsRoutes } from './assets.ts';
import {
  listChangesSince,
  __resetChangeFolderPathCacheForTests,
} from '../db/sqlite/repos/changes.repo.ts';
import { fakeAuth } from '../../tests/helpers/test-auth.ts';
import { registerLibrary, seedRouteAsset } from '../../tests/helpers/assets-route-fixtures.ts';
import {
  createLiveTestDatabase,
  type LiveTestDatabase,
} from '../db/sqlite/test-sqlite.test-helpers.ts';

let live: LiveTestDatabase;
let tmp: string;
let previousRoots: string | undefined;

/** `has_xmp` as the column stores it, or `null` when the asset is gone. */
function hasXmp(id: string): boolean | null {
  const row = live.db.query(`SELECT has_xmp AS v FROM assets WHERE id = ?`).get(id) as {
    v: number;
  } | null;
  return row === null ? null : row.v === 1;
}

beforeEach(async () => {
  live = await createLiveTestDatabase();
  // The relative-path resolver memoises `folders.path` for the life of the
  // process, and every test here mints a new library under a new temp root.
  __resetChangeFolderPathCacheForTests();
  tmp = await mkdtemp(join(tmpdir(), 'maple-changes-'));
  previousRoots = process.env.MAPLE_ROOTS;
  process.env.MAPLE_ROOTS = tmp;
});

afterEach(async () => {
  if (previousRoots === undefined) delete process.env.MAPLE_ROOTS;
  else process.env.MAPLE_ROOTS = previousRoots;
  live.close();
  await rm(tmp, { recursive: true, force: true });
});

describe('assets routes — change emission', () => {
  it('PUT /api/assets/:id/xmp emits a change row', async () => {
    await writeFile(join(tmp, 'a.dng'), Buffer.alloc(8));
    const libraryId = registerLibrary(live.db, tmp);
    const assetId = seedRouteAsset(live.db, {
      libraryId,
      path: '',
      filename: 'a.dng',
      size: 8,
    });

    const app = new Elysia().use(fakeAuth()).use(assetsRoutes);
    const res = await app.handle(
      new Request(`http://localhost/api/assets/${assetId}/xmp`, {
        method: 'PUT',
        headers: { 'Content-Type': 'text/plain' },
        body: '<x:xmpmeta />',
      }),
    );
    expect(res.status).toBe(204);

    const changes = await listChangesSince(live.handle, { since: 0, limit: 10 });
    expect(changes.length).toBeGreaterThanOrEqual(1);
    expect(changes.at(-1)?.asset_id?.toHexString()).toBe(assetId);
    expect(changes.at(-1)?.kind).toBe('update');

    expect(hasXmp(assetId)).toBe(true);
  });

  it('DELETE /api/assets/:id/xmp emits a change row and clears has_xmp', async () => {
    const rawPath = join(tmp, 'b.dng');
    await writeFile(rawPath, Buffer.alloc(8));
    await writeFile(`${rawPath}.xmp`, '<x:xmpmeta />');
    const libraryId = registerLibrary(live.db, tmp);
    const assetId = seedRouteAsset(live.db, {
      libraryId,
      path: '',
      filename: 'b.dng',
      size: 8,
    });
    live.db.run(`UPDATE assets SET has_xmp = 1 WHERE id = ?`, [assetId]);

    const app = new Elysia().use(fakeAuth()).use(assetsRoutes);
    const res = await app.handle(
      new Request(`http://localhost/api/assets/${assetId}/xmp`, { method: 'DELETE' }),
    );
    expect(res.status).toBe(204);

    const changes = await listChangesSince(live.handle, { since: 0, limit: 10 });
    expect(changes.length).toBeGreaterThanOrEqual(1);

    expect(hasXmp(assetId)).toBe(false);
  });
});
