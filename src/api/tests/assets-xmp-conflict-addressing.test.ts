/**
 * GET / PUT / DELETE /api/assets/:id/xmp?conflict=<basename>
 *
 * Verifies the conflict-addressing query parameter:
 *   - GET reads the specific conflict file (404 if absent or invalid)
 *   - PUT unconditionally overwrites the named conflict file, no precondition
 *   - DELETE removes the named conflict file (idempotent; 204 if absent)
 *   - Invalid basenames (traversal, wrong asset, malformed suffix) return 404
 *
 * Real Mongo; skip-passes if MongoDB is unreachable.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import { MongoClient, ObjectId, type Db } from 'mongodb';
import { pendingEnrichment } from '../src/db/schema.ts';

const TEST_DB = `maple_test_fp2_conflict_addr_${process.pid}`;
const PRIOR_MONGO_DB = process.env.MAPLE_MONGO_DB;
const MONGO_URI = process.env.MAPLE_MONGO_URI ?? 'mongodb://localhost:27017';

let mongo: MongoClient | null = null;
let mongoReachable = false;
let db: Db | null = null;
let tmpRoot: string;
let realTmpRoot: string;
let rawPath: string;
let conflictXmpPath: string;
let assetId: ObjectId;

async function tryConnect(): Promise<MongoClient | null> {
  const c = new MongoClient(MONGO_URI, {
    serverSelectionTimeoutMS: 1500,
    connectTimeoutMS: 1500,
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

async function call(
  method: 'GET' | 'PUT' | 'DELETE',
  query: string,
  body?: string,
): Promise<Response> {
  const { assetsRoutes } = await import('../src/routes/assets.ts');
  const url = `http://test/api/assets/${assetId.toHexString()}/xmp${query}`;
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { 'content-type': 'text/plain' };
    init.body = body;
  }
  return assetsRoutes.handle(new Request(url, init));
}

describe('XMP routes — ?conflict=<basename> addressing', () => {
  beforeAll(async () => {
    const { closeDb } = await import('../src/db/client.ts');
    await closeDb();
    process.env.MAPLE_MONGO_DB = TEST_DB;
    mongo = await tryConnect();
    mongoReachable = mongo !== null;
    if (!mongoReachable) return;

    db = mongo!.db(TEST_DB);
    await db.dropDatabase();

    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-fp2-confaddr-'));
    realTmpRoot = await fs.realpath(tmpRoot);
    process.env.MAPLE_ROOTS = realTmpRoot;

    rawPath = path.join(realTmpRoot, 'IMG_1.ARW');
    conflictXmpPath = path.join(realTmpRoot, 'IMG_1 (conflict from MacBook).xmp');
    await fs.writeFile(rawPath, new Uint8Array([0xff, 0xd8, 0xff]));
    await fs.writeFile(conflictXmpPath, '<x:xmpmeta>conflict-v1</x:xmpmeta>');

    const now = new Date().toISOString();
    assetId = new ObjectId();
    // Post drop-abs-path-2026-05-21: see assets-xmp-conflict.test.ts
    // for the seed-folder + fileinfo[] pattern. The route resolves
    // rawPath from the library root + primary fileinfo entry.
    const libraryId = new ObjectId();
    await db.collection('folders').insertOne({
      _id: libraryId,
      path: realTmpRoot,
      label: 'test',
      created_at: now,
      file_count: 0,
    } as never);
    const { invalidateLibraryRoots } = await import('../src/indexer/libraries.cache.ts');
    invalidateLibraryRoots();
    await db.collection('assets').insertOne({
      _id: assetId,
      fileinfo: [{ library_id: libraryId, path: '', filename: 'IMG_1.ARW', deleted_at: null }],
      size: 3,
      mtime: now,
      indexed_at: now,
      enrichment: pendingEnrichment(),
    } as never);
  });

  afterAll(async () => {
    const { closeDb } = await import('../src/db/client.ts');
    await closeDb();
    if (mongo) {
      try {
        await db?.dropDatabase();
      } catch {}
      await mongo.close();
    }
    try {
      await fs.rm(tmpRoot, { recursive: true, force: true });
    } catch {}
    if (PRIOR_MONGO_DB === undefined) delete process.env.MAPLE_MONGO_DB;
    else process.env.MAPLE_MONGO_DB = PRIOR_MONGO_DB;
  });

  it('GET ?conflict=<basename> reads the specific conflict file', async () => {
    if (!mongoReachable) return;
    const res = await call(
      'GET',
      '?conflict=' + encodeURIComponent('IMG_1 (conflict from MacBook)'),
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('conflict-v1');
  });

  it('PUT ?conflict=<basename> overwrites unconditionally, no precondition needed', async () => {
    if (!mongoReachable) return;
    const res = await call(
      'PUT',
      '?conflict=' + encodeURIComponent('IMG_1 (conflict from MacBook)'),
      '<x:xmpmeta>conflict-v2</x:xmpmeta>',
    );
    expect(res.status).toBe(204);
    expect(res.headers.get('last-modified')).toBeTruthy();
    const onDisk = await fs.readFile(conflictXmpPath, 'utf8');
    expect(onDisk).toContain('conflict-v2');
  });

  it('DELETE ?conflict=<basename> removes the specific conflict file', async () => {
    if (!mongoReachable) return;
    const res = await call(
      'DELETE',
      '?conflict=' + encodeURIComponent('IMG_1 (conflict from MacBook)'),
    );
    expect(res.status).toBe(204);
    await expect(fs.access(conflictXmpPath)).rejects.toThrow();
    await fs.access(rawPath); // RAW must still exist.
  });

  it('DELETE ?conflict=<basename> is idempotent (returns 204 when absent)', async () => {
    if (!mongoReachable) return;
    // Already deleted above.
    const res = await call(
      'DELETE',
      '?conflict=' + encodeURIComponent('IMG_1 (conflict from MacBook)'),
    );
    expect(res.status).toBe(204);
  });

  it('rejects path-traversal in the conflict basename', async () => {
    if (!mongoReachable) return;
    const res = await call('GET', '?conflict=' + encodeURIComponent('../etc/passwd'));
    expect(res.status).toBe(404);
  });

  it('rejects wrong-asset basenames', async () => {
    if (!mongoReachable) return;
    // Basename matches the conflict-suffix pattern but for a DIFFERENT raw.
    const res = await call(
      'GET',
      '?conflict=' + encodeURIComponent('IMG_2 (conflict from MacBook)'),
    );
    expect(res.status).toBe(404);
  });

  it('PUT ?conflict=<numbered-variant> works for pickFreeConflictPath output', async () => {
    if (!mongoReachable) return;
    // Numbered variant from pickFreeConflictPath collision handling.
    const res = await call(
      'PUT',
      '?conflict=' + encodeURIComponent('IMG_1 (conflict from MacBook) (2)'),
      '<x:xmpmeta>numbered</x:xmpmeta>',
    );
    expect(res.status).toBe(204);
    const expected = path.join(realTmpRoot, 'IMG_1 (conflict from MacBook) (2).xmp');
    const onDisk = await fs.readFile(expected, 'utf8');
    expect(onDisk).toContain('numbered');
  });
});
