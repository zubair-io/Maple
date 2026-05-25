/**
 * Route-integration test: POST /api/folders/:id/move
 *
 * Covers the folder rename/move hook used by the macOS File Provider
 * extension when Finder fires a folder `modifyItem` (a rename, e.g.
 * "untitled folder" -> "0002", or a move into another folder). The
 * route `fs.rename`s the whole directory and leaves DB reconciliation
 * to the discover watcher.
 *
 * Requires a running MongoDB (skips gracefully if unreachable).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import { MongoClient, ObjectId, type Db } from 'mongodb';
import { closeDb } from '../db/client.ts';
import { foldersRoutes } from './folders.ts';

const MONGO_URI = process.env.MAPLE_MONGO_URI ?? 'mongodb://localhost:27017';
const TEST_DB = `maple_folders_move_test_${process.pid}`;

async function tryConnect(): Promise<MongoClient | null> {
  const c = new MongoClient(MONGO_URI, {
    serverSelectionTimeoutMS: 1_500,
    connectTimeoutMS: 1_500,
  });
  try {
    await c.connect();
    await c.db('admin').command({ ping: 1 });
    return c;
  } catch {
    try {
      await c.close();
    } catch {}
    return null;
  }
}

describe('POST /api/folders/:id/move', () => {
  let mongo: MongoClient | null = null;
  let db: Db | null = null;
  let folderId: ObjectId | null = null;
  let folderPath: string | null = null;

  beforeEach(async () => {
    mongo = await tryConnect();
    if (!mongo) return;
    process.env.MAPLE_MONGO_URI = MONGO_URI;
    process.env.MAPLE_MONGO_DB = TEST_DB;
    await closeDb();
    db = mongo.db(TEST_DB);
    await db.dropDatabase();
    folderPath = await mkdtemp(nodePath.join(tmpdir(), 'maple-move-test-'));
    folderId = new ObjectId();
    await db.collection('folders').insertOne({
      _id: folderId,
      path: folderPath,
      label: 'move-test',
      last_scan: null,
      file_count: 0,
      created_at: new Date().toISOString(),
    } as never);
  });

  afterEach(async () => {
    if (db) await db.dropDatabase().catch(() => {});
    if (mongo) await mongo.close().catch(() => {});
    if (folderPath) await rm(folderPath, { recursive: true, force: true }).catch(() => {});
    await closeDb();
    db = null;
    mongo = null;
    folderId = null;
    folderPath = null;
  });

  function call(source: string, target: string, id?: string): Promise<Response> {
    const app = new Elysia().use(foldersRoutes);
    const url = `http://localhost/api/folders/${id ?? folderId!.toHexString()}/move`;
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
    if (!mongo || !db || !folderId) {
      console.log('[folders.move.test] MongoDB unreachable — skipping');
      return;
    }
    await mkdir(nodePath.join(folderPath!, 'untitled folder'), { recursive: true });
    await writeFile(nodePath.join(folderPath!, 'untitled folder', 'a.dng'), 'raw');

    const res = await call('untitled folder', '0002');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { abs_path: string };
    expect(body.abs_path).toBe(nodePath.join(folderPath!, '0002'));

    // Old gone, new present with the child carried along.
    await expect(stat(nodePath.join(folderPath!, 'untitled folder'))).rejects.toThrow();
    const moved = await stat(nodePath.join(folderPath!, '0002', 'a.dng'));
    expect(moved.isFile()).toBe(true);
  });

  it('moves a folder into a different existing parent', async () => {
    if (!mongo || !db || !folderId) return;
    await mkdir(nodePath.join(folderPath!, 'src'), { recursive: true });
    await mkdir(nodePath.join(folderPath!, 'dest'), { recursive: true });

    const res = await call('src', 'dest/src');
    expect(res.status).toBe(200);
    const st = await stat(nodePath.join(folderPath!, 'dest', 'src'));
    expect(st.isDirectory()).toBe(true);
  });

  it('returns 409 when the target already exists', async () => {
    if (!mongo || !db || !folderId) return;
    await mkdir(nodePath.join(folderPath!, 'a'), { recursive: true });
    await mkdir(nodePath.join(folderPath!, 'b'), { recursive: true });

    const res = await call('a', 'b');
    expect(res.status).toBe(409);
    // Source untouched.
    const st = await stat(nodePath.join(folderPath!, 'a'));
    expect(st.isDirectory()).toBe(true);
  });

  it('returns 404 when the source folder does not exist', async () => {
    if (!mongo || !db || !folderId) return;
    const res = await call('ghost', 'renamed');
    expect(res.status).toBe(404);
  });

  it('rejects moving a folder into its own subtree', async () => {
    if (!mongo || !db || !folderId) return;
    await mkdir(nodePath.join(folderPath!, 'a'), { recursive: true });
    const res = await call('a', 'a/b');
    expect(res.status).toBe(400);
  });

  it('rejects path traversal in either path', async () => {
    if (!mongo || !db || !folderId) return;
    await mkdir(nodePath.join(folderPath!, 'a'), { recursive: true });
    expect((await call('../outside', 'a')).status).toBe(400);
    expect((await call('a', '../outside')).status).toBe(400);
  });

  it('rejects leading-dot path components', async () => {
    if (!mongo || !db || !folderId) return;
    await mkdir(nodePath.join(folderPath!, 'a'), { recursive: true });
    expect((await call('a', '.maple/leaked')).status).toBe(400);
  });

  it('returns 400 when a path header is missing', async () => {
    if (!mongo || !db || !folderId) return;
    const app = new Elysia().use(foldersRoutes);
    const url = `http://localhost/api/folders/${folderId.toHexString()}/move`;
    const res = await app.handle(
      new Request(url, {
        method: 'POST',
        headers: { 'X-Maple-Target-Path': '0002' },
      }),
    );
    expect(res.status).toBe(400);
  });

  it('returns 404 for an unknown folder id', async () => {
    if (!mongo || !db) return;
    const res = await call('a', 'b', new ObjectId().toHexString());
    expect(res.status).toBe(404);
  });
});
