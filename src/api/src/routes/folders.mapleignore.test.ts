/**
 * `.mapleignore` (#5398) on the folder routes that write into a library or
 * walk it outside the sweep: an upload into an ignored folder stores the
 * bytes but catalogues nothing, and a rescan's re-walk never indexes an
 * ignored subtree.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import {
  createLiveTestDatabase,
  insertAsset,
  insertFolder,
  insertLocation,
  type LiveTestDatabase,
} from '../db/sqlite/test-sqlite.test-helpers.ts';
import { invalidateLibraryRoots } from '../indexer/libraries.cache.ts';
import { foldersRoutes } from './folders.ts';
import { fakeAuth } from '../../tests/helpers/test-auth.ts';

describe('folder routes under a .mapleignore folder', () => {
  let live: LiveTestDatabase;
  let root: string;
  let folderId: string;
  const app = new Elysia().use(fakeAuth()).use(foldersRoutes);

  beforeEach(async () => {
    live = await createLiveTestDatabase();
    root = await mkdtemp(nodePath.join(tmpdir(), 'maple-ignore-routes-'));
    folderId = insertFolder(live.db, { path: root, slug: 'ignore-test' });
    invalidateLibraryRoots();
    await mkdir(nodePath.join(root, 'skip'), { recursive: true });
    await writeFile(nodePath.join(root, 'skip', '.mapleignore'), '');
  });

  afterEach(async () => {
    live.close();
    invalidateLibraryRoots();
    await rm(root, { recursive: true, force: true }).catch(() => {});
  });

  function count(sql: string): number {
    return (live.db.query(sql).get() as { n: number }).n;
  }

  function upload(target: string, bytes: Uint8Array<ArrayBuffer>): Promise<Response> {
    return app.handle(
      new Request(`http://localhost/api/folders/${folderId}/upload`, {
        method: 'POST',
        headers: { 'X-Maple-Target-Path': target, 'Content-Type': 'application/octet-stream' },
        body: bytes,
      }),
    );
  }

  it('stores an upload into an ignored (nested) folder without cataloguing it', async () => {
    const bytes = new Uint8Array([0x49, 0x49, 0x2a, 0x00, 0x01]);
    const res = await upload('skip/new/sub/photo.dng', bytes);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { abs_path: string; asset_id?: string };
    expect(body.asset_id).toBeUndefined();
    expect(new Uint8Array(await readFile(body.abs_path))).toEqual(bytes);
    expect(count(`SELECT COUNT(*) AS n FROM assets`)).toBe(0);

    // File Provider clients still see the stored file through the change feed.
    const change = live.db
      .query(`SELECT kind, asset_id, relative_path FROM asset_changes`)
      .get() as { kind: string; asset_id: string | null; relative_path: string };
    expect(change).toEqual({
      kind: 'create',
      asset_id: null,
      relative_path: 'skip/new/sub/photo.dng',
    });

    // Outside the ignored folder the same upload is catalogued as usual.
    const indexed = await upload('keep/photo.dng', bytes);
    expect(((await indexed.json()) as { asset_id?: string }).asset_id).toMatch(/^[a-f0-9]{24}$/);
  });

  it('replaces an excluded original as an uncatalogued file, keeping its bytes in Trash', async () => {
    const original = nodePath.join(root, 'skip', 'photo.dng');
    await writeFile(original, 'old bytes');
    const assetId = insertAsset(live.db);
    insertLocation(live.db, {
      assetId,
      libraryId: folderId,
      path: 'skip',
      filename: 'photo.dng',
      missingSince: '2026-10-25T00:00:00.000Z',
    });
    live.db.run(`UPDATE asset_locations SET missing_reason = 'mapleignore' WHERE asset_id = ?`, [
      assetId,
    ]);

    const res = await upload('skip/photo.dng', new Uint8Array([1, 2, 3]));
    expect(res.status).toBe(201);
    expect(new Uint8Array(await readFile(original))).toEqual(new Uint8Array([1, 2, 3]));
    const trashed = nodePath.join(root, '.maple', 'trash', 'skip', 'photo.dng');
    expect(await readFile(trashed, 'utf8')).toBe('old bytes');
    expect(count(`SELECT COUNT(*) AS n FROM assets WHERE deleted_at IS NOT NULL`)).toBe(0);
  });

  it('never indexes an ignored subtree during a rescan re-walk', async () => {
    await mkdir(nodePath.join(root, 'skip', 'nested'), { recursive: true });
    await writeFile(nodePath.join(root, 'skip', 'nested', 'b.jpg'), 'ignored bytes');
    await mkdir(nodePath.join(root, 'keep'), { recursive: true });
    await writeFile(nodePath.join(root, 'keep', 'a.jpg'), 'kept bytes');

    const res = await app.handle(
      new Request(`http://localhost/api/folders/${folderId}/rescan`, { method: 'POST' }),
    );
    expect(res.status).toBe(200);
    const paths = live.db.query(`SELECT path FROM asset_locations ORDER BY path`).all() as Array<{
      path: string;
    }>;
    expect(paths.map((p) => p.path)).toEqual(['keep']);
  });
});
