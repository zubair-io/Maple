/**
 * Route-integration tests: POST /api/folders/:id/trash-folder and
 * POST /api/folders/:id/restore-folder (#2630).
 *
 * The orchestration itself is covered exhaustively by
 * `library/folder-trash.test.ts`; this file just proves the HTTP wiring —
 * header validation, folder lookup, and the summary JSON shape — matches
 * `/mkdir` and `/move`'s conventions. Requires a running MongoDB (skips
 * gracefully if unreachable).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { mkdtemp, rm, mkdir, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import { MongoClient, ObjectId, type Db } from 'mongodb';
import { closeDb } from '../db/client.ts';
import { invalidateLibraryRoots } from '../indexer/libraries.cache.ts';
import { foldersTrashRoutes } from './folders-trash.ts';

const MONGO_URI = process.env.MAPLE_MONGO_URI ?? 'mongodb://localhost:27017';
const TEST_DB = `maple_folders_trash_route_test_${process.pid}`;

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

describe('POST /api/folders/:id/trash-folder + /restore-folder', () => {
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
    folderPath = await mkdtemp(nodePath.join(tmpdir(), 'maple-folder-trash-route-test-'));
    folderId = new ObjectId();
    await db.collection('folders').insertOne({
      _id: folderId,
      path: folderPath,
      slug: 'folder-trash-route-test',
      label: 'folder-trash-route-test',
      last_scan: null,
      file_count: 0,
      created_at: new Date().toISOString(),
    } as never);
    invalidateLibraryRoots();
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

  function call(action: 'trash-folder' | 'restore-folder', target: string): Promise<Response> {
    const app = new Elysia().use(foldersTrashRoutes);
    const url = `http://localhost/api/folders/${folderId!.toHexString()}/${action}`;
    return app.handle(
      new Request(url, {
        method: 'POST',
        headers: { 'X-Maple-Target-Path': target },
      }),
    );
  }

  it('trashes every asset under the target subfolder and reports a summary', async () => {
    if (!mongo || !db || !folderId || !folderPath) {
      console.log('[folders-trash.test] MongoDB unreachable — skipping');
      return;
    }

    const absDir = nodePath.join(folderPath, 'sub');
    await mkdir(absDir, { recursive: true });
    await writeFile(nodePath.join(absDir, 'IMG_1.dng'), 'pixels');

    const assetId = new ObjectId();
    await db.collection('assets').insertOne({
      _id: assetId,
      fileinfo: [{ path: 'sub', filename: 'IMG_1.dng', library_id: folderId, deleted_at: null }],
      size: 6,
      mtime: 1_700_000_000_000,
      rating: 0,
      flag: 0,
      color_label: '',
      indexed_at: '2026-01-01T00:00:00Z',
      has_xmp: false,
      deleted_at: null,
    } as never);

    const res = await call('trash-folder', 'sub');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { total: number; succeeded: number; failed: number };
    expect(body.total).toBe(1);
    expect(body.succeeded).toBe(1);
    expect(body.failed).toBe(0);

    await expect(stat(nodePath.join(absDir, 'IMG_1.dng'))).rejects.toThrow();
    const trashedRow = await db.collection('assets').findOne({ _id: assetId });
    expect((trashedRow as unknown as { deleted_at: string | null })?.deleted_at).not.toBeNull();

    const restoreRes = await call('restore-folder', 'sub');
    expect(restoreRes.status).toBe(200);
    const restoreBody = (await restoreRes.json()) as { total: number; succeeded: number };
    expect(restoreBody.total).toBe(1);
    expect(restoreBody.succeeded).toBe(1);

    const restoredStat = await stat(nodePath.join(absDir, 'IMG_1.dng'));
    expect(restoredStat.isFile()).toBe(true);
    const restoredRow = await db.collection('assets').findOne({ _id: assetId });
    expect((restoredRow as unknown as { deleted_at: string | null })?.deleted_at).toBeNull();
  });

  it('rejects a hostile X-Maple-Target-Path with 400, same as /mkdir and /move', async () => {
    if (!mongo || !db || !folderId) {
      console.log('[folders-trash.test] MongoDB unreachable — skipping');
      return;
    }
    const res = await call('trash-folder', '../../etc');
    expect(res.status).toBe(400);
  });

  it('404s for an unknown folder id', async () => {
    if (!mongo || !db) {
      console.log('[folders-trash.test] MongoDB unreachable — skipping');
      return;
    }
    folderId = new ObjectId(); // unregistered id
    const res = await call('trash-folder', 'sub');
    expect(res.status).toBe(404);
  });
});
