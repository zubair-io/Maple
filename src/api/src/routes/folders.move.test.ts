/**
 * Route-integration test: POST /api/folders/:id/move
 *
 * Covers the folder rename/move hook used by the macOS File Provider
 * extension when Finder fires a folder `modifyItem` (a rename, e.g.
 * "untitled folder" -> "0002", or a move into another folder). The
 * route `fs.rename`s the whole directory and leaves DB reconciliation
 * to the discover watcher.
 *
 * The handler reaches `sqliteDb()` with no override, so each test installs
 * its own database as the process-wide handle for the block.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import { ObjectId } from 'mongodb';
import {
  createLiveTestDatabase,
  insertFolder,
  type LiveTestDatabase,
} from '../db/sqlite/test-sqlite.test-helpers.ts';
import { foldersRoutes } from './folders.ts';
import { fakeAuth } from '../../tests/helpers/test-auth.ts';

describe('POST /api/folders/:id/move', () => {
  let live: LiveTestDatabase;
  let folderId: string;
  let folderPath: string;

  beforeEach(async () => {
    live = await createLiveTestDatabase();
    folderPath = await mkdtemp(nodePath.join(tmpdir(), 'maple-move-test-'));
    folderId = insertFolder(live.db, { path: folderPath, slug: 'move-test' });
  });

  afterEach(async () => {
    live.close();
    await rm(folderPath, { recursive: true, force: true }).catch(() => {});
  });

  function call(source: string, target: string, id?: string): Promise<Response> {
    const app = new Elysia().use(fakeAuth()).use(foldersRoutes);
    const url = `http://localhost/api/folders/${id ?? folderId}/move`;
    return app.handle(
      new Request(url, {
        method: 'POST',
        headers: {
          'X-Maple-Source-Path': source,
          'X-Maple-Target-Path': target,
        },
      }),
    );
  }

  it('renames a folder and moves its contents along', async () => {
    await mkdir(nodePath.join(folderPath, 'untitled folder'), { recursive: true });
    await writeFile(nodePath.join(folderPath, 'untitled folder', 'a.dng'), 'raw');

    const res = await call('untitled folder', '0002');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { abs_path: string };
    expect(body.abs_path).toBe(nodePath.join(folderPath, '0002'));

    // Old gone, new present with the child carried along.
    await expect(stat(nodePath.join(folderPath, 'untitled folder'))).rejects.toThrow();
    const moved = await stat(nodePath.join(folderPath, '0002', 'a.dng'));
    expect(moved.isFile()).toBe(true);
  });

  it('moves a folder into a different existing parent', async () => {
    await mkdir(nodePath.join(folderPath, 'src'), { recursive: true });
    await mkdir(nodePath.join(folderPath, 'dest'), { recursive: true });

    const res = await call('src', 'dest/src');
    expect(res.status).toBe(200);
    const st = await stat(nodePath.join(folderPath, 'dest', 'src'));
    expect(st.isDirectory()).toBe(true);
  });

  it('returns 409 when the target already exists', async () => {
    await mkdir(nodePath.join(folderPath, 'a'), { recursive: true });
    await mkdir(nodePath.join(folderPath, 'b'), { recursive: true });

    const res = await call('a', 'b');
    expect(res.status).toBe(409);
    // Source untouched.
    const st = await stat(nodePath.join(folderPath, 'a'));
    expect(st.isDirectory()).toBe(true);
  });

  it('returns 404 when the source folder does not exist', async () => {
    const res = await call('ghost', 'renamed');
    expect(res.status).toBe(404);
  });

  it('rejects moving a folder into its own subtree', async () => {
    await mkdir(nodePath.join(folderPath, 'a'), { recursive: true });
    const res = await call('a', 'a/b');
    expect(res.status).toBe(400);
  });

  it('rejects path traversal in either path', async () => {
    await mkdir(nodePath.join(folderPath, 'a'), { recursive: true });
    expect((await call('../outside', 'a')).status).toBe(400);
    expect((await call('a', '../outside')).status).toBe(400);
  });

  it('rejects leading-dot path components', async () => {
    await mkdir(nodePath.join(folderPath, 'a'), { recursive: true });
    expect((await call('a', '.maple/leaked')).status).toBe(400);
  });

  it('returns 400 when a path header is missing', async () => {
    const app = new Elysia().use(fakeAuth()).use(foldersRoutes);
    const url = `http://localhost/api/folders/${folderId}/move`;
    const res = await app.handle(
      new Request(url, {
        method: 'POST',
        headers: { 'X-Maple-Target-Path': '0002' },
      }),
    );
    expect(res.status).toBe(400);
  });

  it('returns 404 for an unknown folder id', async () => {
    const res = await call('a', 'b', new ObjectId().toHexString());
    expect(res.status).toBe(404);
  });
});
