/**
 * Route-integration tests: POST /api/folders/:id/trash-folder and
 * POST /api/folders/:id/restore-folder (#2630).
 *
 * The orchestration itself is covered exhaustively by
 * `library/folder-trash.test.ts`; this file just proves the HTTP wiring —
 * header validation, folder lookup, and the summary JSON shape — matches
 * `/mkdir` and `/move`'s conventions.
 *
 * The handlers reach `sqliteDb()` with no override, so each test installs its
 * own database as the process-wide handle for the block.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { mkdtemp, rm, mkdir, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import { ObjectId } from '../db/object-id.ts';
import {
  createLiveTestDatabase,
  insertAsset,
  insertFolder,
  insertLocation,
  type LiveTestDatabase,
} from '../db/sqlite/test-sqlite.test-helpers.ts';
import { invalidateLibraryRoots } from '../indexer/libraries.cache.ts';
import { foldersTrashRoutes } from './folders-trash.ts';
import { fakeAuth } from '../../tests/helpers/test-auth.ts';

describe('POST /api/folders/:id/trash-folder + /restore-folder', () => {
  let live: LiveTestDatabase;
  let folderId: string;
  let folderPath: string;

  beforeEach(async () => {
    live = await createLiveTestDatabase();
    folderPath = await mkdtemp(nodePath.join(tmpdir(), 'maple-folder-trash-route-test-'));
    folderId = insertFolder(live.db, { path: folderPath, slug: 'folder-trash-route-test' });
    // The library-roots cache is process-wide and keyed on nothing but the
    // folders table, so a previous test's roots would otherwise answer this
    // one's path resolution.
    invalidateLibraryRoots();
  });

  afterEach(async () => {
    live.close();
    invalidateLibraryRoots();
    await rm(folderPath, { recursive: true, force: true }).catch(() => {});
  });

  function call(action: 'trash-folder' | 'restore-folder', target: string): Promise<Response> {
    const app = new Elysia().use(fakeAuth()).use(foldersTrashRoutes);
    const url = `http://localhost/api/folders/${folderId}/${action}`;
    return app.handle(
      new Request(url, {
        method: 'POST',
        headers: { 'X-Maple-Target-Path': target },
      }),
    );
  }

  /** The asset row's soft-delete stamp, read straight off the table. */
  function deletedAt(assetId: string): string | null {
    const row = live.db.query(`SELECT deleted_at FROM assets WHERE id = ?`).get(assetId) as {
      deleted_at: string | null;
    } | null;
    return row?.deleted_at ?? null;
  }

  it('trashes every asset under the target subfolder and reports a summary', async () => {
    const absDir = nodePath.join(folderPath, 'sub');
    await mkdir(absDir, { recursive: true });
    await writeFile(nodePath.join(absDir, 'IMG_1.dng'), 'pixels');

    const assetId = insertAsset(live.db);
    insertLocation(live.db, {
      assetId,
      libraryId: folderId,
      path: 'sub',
      filename: 'IMG_1.dng',
    });

    const res = await call('trash-folder', 'sub');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { total: number; succeeded: number; failed: number };
    expect(body.total).toBe(1);
    expect(body.succeeded).toBe(1);
    expect(body.failed).toBe(0);

    await expect(stat(nodePath.join(absDir, 'IMG_1.dng'))).rejects.toThrow();
    expect(deletedAt(assetId)).not.toBeNull();

    const restoreRes = await call('restore-folder', 'sub');
    expect(restoreRes.status).toBe(200);
    const restoreBody = (await restoreRes.json()) as { total: number; succeeded: number };
    expect(restoreBody.total).toBe(1);
    expect(restoreBody.succeeded).toBe(1);

    const restoredStat = await stat(nodePath.join(absDir, 'IMG_1.dng'));
    expect(restoredStat.isFile()).toBe(true);
    expect(deletedAt(assetId)).toBeNull();
  });

  it('rejects a hostile X-Maple-Target-Path with 400, same as /mkdir and /move', async () => {
    const res = await call('trash-folder', '../../etc');
    expect(res.status).toBe(400);
  });

  it('404s for an unknown folder id', async () => {
    folderId = new ObjectId().toHexString(); // unregistered id
    const res = await call('trash-folder', 'sub');
    expect(res.status).toBe(404);
  });
});
