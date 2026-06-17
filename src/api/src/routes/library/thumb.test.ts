/**
 * Integration tests for GET /api/thumb/:slug/*
 *
 * Does NOT exercise actual thumb generation (that requires real image files
 * and the native core). Tests the HTTP logic: slug resolution, 404/202 guards,
 * ETag / Cache-Control, and 304 short-circuit.
 */

import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { Elysia } from 'elysia';
import { MongoClient, ObjectId, type Db } from 'mongodb';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import * as path from 'node:path';
import { thumbRoutes } from './thumb.ts';
import { setLibraryBySlugForTests, invalidateLibraryRoots } from '../../indexer/libraries.cache.ts';

const TEST_DB = `maple_test_thumb_route_${process.pid}`;
process.env.MAPLE_MONGO_DB = TEST_DB;
const MONGO_URI = process.env.MAPLE_MONGO_URI ?? 'mongodb://localhost:27017';

let mongo: MongoClient | null = null;
let mongoReachable = false;
let db: Db | null = null;
let tmpDir = '';
let libraryId = new ObjectId();

const app = new Elysia().use(thumbRoutes);

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
    } catch {
      /* ignore */
    }
    return null;
  }
}

beforeAll(async () => {
  mongo = await tryConnect();
  mongoReachable = mongo !== null;
  if (!mongoReachable) {
    console.log('[thumb.test] skipping: MongoDB unreachable');
    return;
  }
  db = mongo!.db(TEST_DB);
  await db.dropDatabase();
  tmpDir = `/tmp/maple-thumb-test-${process.pid}`;
  await mkdir(tmpDir, { recursive: true });
  libraryId = new ObjectId();
  setLibraryBySlugForTests('thumblib', { libraryId, root: tmpDir, label: 'Thumb Test Library' });
});

beforeEach(async () => {
  if (!mongoReachable || !db) return;
  await db.collection('assets').deleteMany({});
});

afterAll(async () => {
  if (mongo) {
    try {
      await mongo.db(TEST_DB).dropDatabase();
    } catch {
      /* ignore */
    }
    try {
      await mongo.close();
    } catch {
      /* ignore */
    }
  }
  if (tmpDir) {
    try {
      await rm(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  invalidateLibraryRoots();
  const { closeDb } = await import('../../db/client.ts');
  await closeDb();
});

describe('GET /thumb/:slug/*', () => {
  test('returns 404 for unknown slug', async () => {
    const res = await app.handle(new Request('http://localhost/thumb/no-such-slug/photo.jpg'));
    expect(res.status).toBe(404);
  });

  test('returns 404 when file does not exist on disk and is not indexed', async () => {
    if (!mongoReachable) return;
    const res = await app.handle(new Request('http://localhost/thumb/thumblib/ghost.jpg'));
    expect(res.status).toBe(404);
  });

  test('returns 202 with Retry-After when file exists on disk but is not indexed', async () => {
    if (!mongoReachable) return;
    await writeFile(path.join(tmpDir, 'pending.jpg'), 'fake-jpeg');
    const res = await app.handle(new Request('http://localhost/thumb/thumblib/pending.jpg'));
    expect(res.status).toBe(202);
    expect(res.headers.get('Retry-After')).toBe('2');
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('indexing');
  });

  test('returns 304 when ETag matches If-None-Match', async () => {
    if (!mongoReachable) return;
    const mapleId = new ObjectId().toHexString();
    await db!.collection('assets').insertOne({
      maple_id: mapleId,
      fileinfo: [
        {
          library_id: libraryId,
          path: '',
          filename: 'cached.jpg',
          deleted_at: null,
          missing_since: null,
        },
      ],
      deleted_at: null,
    } as never);

    // Create a fake thumb so the route doesn't try to generate it
    const { mkdir: mkdirNative } = await import('node:fs/promises');
    const thumbDir = path.join(tmpDir, '.maple', 'thumbs');
    await mkdirNative(thumbDir, { recursive: true });
    // resolveThumbPathForAsset uses maple_id's first 2 chars as bucket dir
    const bucket = mapleId.slice(0, 2);
    const bucketDir = path.join(tmpDir, '.maple', 'thumbs', bucket);
    await mkdirNative(bucketDir, { recursive: true });
    await writeFile(path.join(bucketDir, `${mapleId}.jpg`), 'fake-thumb-bytes');

    const etag = `"${mapleId}"`;
    const res = await app.handle(
      new Request('http://localhost/thumb/thumblib/cached.jpg', {
        headers: { 'If-None-Match': etag },
      }),
    );
    expect(res.status).toBe(304);
    expect(res.headers.get('ETag')).toBe(etag);
  });
});
