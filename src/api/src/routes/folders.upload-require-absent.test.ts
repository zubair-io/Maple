/**
 * Route-integration test: POST /api/folders/:id/upload with
 * `X-Maple-Require-Absent: true`. A client publishing a document it created
 * (the Android documents provider's `createDocument`) must never replace a
 * file another client put at that name meanwhile: the route answers 409 and
 * the client keeps both under another name.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import {
  createLiveTestDatabase,
  insertFolder,
  type LiveTestDatabase,
} from '../db/sqlite/test-sqlite.test-helpers.ts';
import { foldersRoutes } from './folders.ts';
import { fakeAuth } from '../../tests/helpers/test-auth.ts';

describe('POST /api/folders/:id/upload — X-Maple-Require-Absent', () => {
  const ORIGINAL = new Uint8Array([0x6f, 0x72, 0x69, 0x67]);
  const CREATED = new Uint8Array([0x6e, 0x65, 0x77, 0x21]);
  let live: LiveTestDatabase;
  let folderId: string;
  let folderPath: string;

  beforeEach(async () => {
    live = await createLiveTestDatabase();
    folderPath = await mkdtemp(nodePath.join(tmpdir(), 'maple-upload-absent-'));
    folderId = insertFolder(live.db, { path: folderPath, slug: 'upload-absent' });
  });

  afterEach(async () => {
    live.close();
    await rm(folderPath, { recursive: true, force: true }).catch(() => {});
  });

  function create(target: string): Promise<Response> {
    const app = new Elysia().use(fakeAuth()).use(foldersRoutes);
    return app.handle(
      new Request(`http://localhost/api/folders/${folderId}/upload`, {
        method: 'POST',
        headers: {
          'X-Maple-Target-Path': target,
          'X-Maple-Require-Absent': 'true',
          'Content-Type': 'application/octet-stream',
        },
        body: CREATED,
      }),
    );
  }

  for (const target of ['IMG_0001.JPG', 'notes.txt', 'clip.mov']) {
    it(`answers 409 and keeps the ${target} already at the name, untrashed`, async () => {
      await writeFile(nodePath.join(folderPath, target), ORIGINAL);
      const res = await create(target);
      expect(res.status).toBe(409);
      expect(new Uint8Array(await readFile(nodePath.join(folderPath, target)))).toEqual(ORIGINAL);
      // Nothing went to Maple Trash, and the streamed body left no temporary file.
      expect(await readdir(folderPath)).toEqual([target]);
    });
  }

  it('publishes into a free name', async () => {
    const res = await create('IMG_0002.JPG');
    expect(res.status).toBe(201);
    const body = (await res.json()) as { asset_id?: string };
    expect(body.asset_id).toMatch(/^[a-f0-9]{24}$/);
    expect(new Uint8Array(await readFile(nodePath.join(folderPath, 'IMG_0002.JPG')))).toEqual(
      CREATED,
    );
    expect(await readdir(folderPath)).toEqual(['IMG_0002.JPG']);
  });
});
