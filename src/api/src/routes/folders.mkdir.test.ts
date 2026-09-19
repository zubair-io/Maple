/**
 * Route-integration test: POST /api/folders/:id/mkdir
 *
 * Covers the folder-create hook used by the macOS File Provider
 * extension when Finder fires a folder createItem (either "New
 * Folder" in the FP mount, or the folder-create that precedes a
 * drag-in of a folder containing files).
 *
 * The handler reaches `sqliteDb()` with no override, so each test installs
 * its own database as the process-wide handle for the block.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { mkdtemp, rm, stat } from 'node:fs/promises';
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

describe('POST /api/folders/:id/mkdir', () => {
  let live: LiveTestDatabase;
  let folderId: string;
  let folderPath: string;

  beforeEach(async () => {
    live = await createLiveTestDatabase();
    folderPath = await mkdtemp(nodePath.join(tmpdir(), 'maple-mkdir-test-'));
    folderId = insertFolder(live.db, { path: folderPath, slug: 'mkdir-test' });
  });

  afterEach(async () => {
    live.close();
    await rm(folderPath, { recursive: true, force: true }).catch(() => {});
  });

  function call(target: string): Promise<Response> {
    const app = new Elysia().use(fakeAuth()).use(foldersRoutes);
    const url = `http://localhost/api/folders/${folderId}/mkdir`;
    return app.handle(
      new Request(url, {
        method: 'POST',
        headers: { 'X-Maple-Target-Path': target },
      }),
    );
  }

  it('creates a single-level subdirectory and returns 201 with abs_path', async () => {
    const res = await call('Pictures');
    expect(res.status).toBe(201);
    const body = (await res.json()) as { abs_path: string };
    const expected = nodePath.join(folderPath, 'Pictures');
    expect(body.abs_path).toBe(expected);
    const st = await stat(expected);
    expect(st.isDirectory()).toBe(true);
  });

  it('creates nested directories in one call (mkdir -p)', async () => {
    const res = await call('2026/Adam/04-02');
    expect(res.status).toBe(201);
    const st = await stat(nodePath.join(folderPath, '2026/Adam/04-02'));
    expect(st.isDirectory()).toBe(true);
  });

  it('is idempotent when the directory already exists', async () => {
    const first = await call('Pictures');
    expect(first.status).toBe(201);
    const second = await call('Pictures');
    expect(second.status).toBe(201);
  });

  it('rejects path traversal', async () => {
    const res = await call('../outside');
    expect(res.status).toBe(400);
  });

  it('rejects leading-dot path components', async () => {
    const res = await call('.maple/leaked');
    expect(res.status).toBe(400);
  });

  it('rejects absolute paths', async () => {
    const res = await call('/etc/evil');
    expect(res.status).toBe(400);
  });

  it('returns 404 for an unknown folder id', async () => {
    const app = new Elysia().use(fakeAuth()).use(foldersRoutes);
    const url = `http://localhost/api/folders/${new ObjectId().toHexString()}/mkdir`;
    const res = await app.handle(
      new Request(url, {
        method: 'POST',
        headers: { 'X-Maple-Target-Path': 'Pictures' },
      }),
    );
    expect(res.status).toBe(404);
  });
});
