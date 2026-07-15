/**
 * Integration tests for GET /api/preview/:slug/*
 *
 * Like thumb.test.ts: exercises HTTP logic without invoking actual preview
 * generation (which requires native image files and the core).
 */

import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { Elysia } from 'elysia';
import { MongoClient, ObjectId, type Db } from 'mongodb';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import * as path from 'node:path';
import { previewRoutes } from './preview.ts';
import {
  setLibraryRootsForTests,
  setLibraryBySlugForTests,
  invalidateLibraryRoots,
} from '../../indexer/libraries.cache.ts';

const TEST_DB = `maple_test_preview_route_${process.pid}`;
process.env.MAPLE_MONGO_DB = TEST_DB;
const MONGO_URI = process.env.MAPLE_MONGO_URI ?? 'mongodb://localhost:27017';

let mongo: MongoClient | null = null;
let mongoReachable = false;
let db: Db | null = null;
let tmpDir = '';
let libraryId = new ObjectId();

const app = new Elysia().use(previewRoutes);

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
    console.log('[preview.test] skipping: MongoDB unreachable');
    return;
  }
  db = mongo!.db(TEST_DB);
  await db.dropDatabase();
  tmpDir = `/tmp/maple-preview-test-${process.pid}`;
  await mkdir(tmpDir, { recursive: true });
  libraryId = new ObjectId();
  // Seed byId (loadLibraryRoots — used to resolve the preview cache path) AND
  // bySlug (resolveAddress). setLibraryRootsForTests first so the bySlug add
  // below appends to the same cache entry rather than being wiped.
  setLibraryRootsForTests(new Map([[libraryId.toHexString(), tmpDir]]));
  setLibraryBySlugForTests('prevlib', { libraryId, root: tmpDir, label: 'Preview Test Library' });
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

describe('GET /preview/:slug/*', () => {
  test('returns 400 when no filename is provided (empty wildcard)', async () => {
    // A request to /preview/:slug/ with no filename segment must be rejected
    // with 400, not treated as a library-root browse returning 202.
    const res = await app.handle(new Request('http://localhost/preview/prevlib/'));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/filename/i);
  });

  test('returns 404 for unknown slug', async () => {
    const res = await app.handle(new Request('http://localhost/preview/no-such-slug/photo.jpg'));
    expect(res.status).toBe(404);
  });

  test('returns 404 when file does not exist on disk and is not indexed', async () => {
    if (!mongoReachable) return;
    const res = await app.handle(new Request('http://localhost/preview/prevlib/ghost.jpg'));
    expect(res.status).toBe(404);
  });

  test('returns 202 with Retry-After when file exists on disk but is not indexed', async () => {
    if (!mongoReachable) return;
    await writeFile(path.join(tmpDir, 'pending.jpg'), 'fake-jpeg');
    const res = await app.handle(new Request('http://localhost/preview/prevlib/pending.jpg'));
    expect(res.status).toBe(202);
    expect(res.headers.get('Retry-After')).toBe('2');
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('indexing');
  });

  test('serves the single <filename>.avif with a file-based ETag and 304s on If-None-Match', async () => {
    if (!mongoReachable) return;
    const mapleId = new ObjectId().toHexString();
    await db!.collection('assets').insertOne({
      maple_id: mapleId,
      fileinfo: [
        {
          library_id: libraryId,
          path: '',
          filename: 'ready.jpg',
          deleted_at: null,
          missing_since: null,
        },
      ],
      deleted_at: null,
    } as never);

    // Pre-stage the one preview file so the route serves it without generating.
    // The serving path only stats/reads it (no decode), so arbitrary bytes work.
    const previewPath = path.join(tmpDir, '.maple', 'previews', 'ready.jpg.avif');
    await mkdir(path.dirname(previewPath), { recursive: true });
    await writeFile(previewPath, 'fake-preview-bytes');

    // First request: 200 with an ETag derived from the file's mtime/size, and a
    // revalidate (not immutable) Cache-Control — the preview is a mutable cache.
    const res = await app.handle(new Request('http://localhost/preview/prevlib/ready.jpg'));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/avif');
    expect(res.headers.get('Cache-Control')).toBe('private, max-age=0, must-revalidate');
    const etag = res.headers.get('ETag');
    expect(etag).toBeTruthy();

    // Conditional request with that ETag: 304.
    const revalidated = await app.handle(
      new Request('http://localhost/preview/prevlib/ready.jpg', {
        headers: { 'If-None-Match': etag! },
      }),
    );
    expect(revalidated.status).toBe(304);
    expect(revalidated.headers.get('ETag')).toBe(etag);
  });
});
