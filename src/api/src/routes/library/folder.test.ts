/**
 * Integration tests for GET /api/folder/:slug/*
 *
 * Uses a real Mongo DB (MAPLE_MONGO_URI, separate test DB) + a real temp
 * directory so `readdir` calls work. Skips gracefully when Mongo is unreachable.
 */

import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { Elysia } from 'elysia';
import { MongoClient, ObjectId, type Db } from 'mongodb';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import * as path from 'node:path';
import { folderRoutes } from './folder.ts';
import { setLibraryBySlugForTests } from '../../indexer/libraries.cache.ts';
import { invalidateLibraryRoots } from '../../indexer/libraries.cache.ts';

const TEST_DB = `maple_test_folder_route_${process.pid}`;
process.env.MAPLE_MONGO_DB = TEST_DB;
const MONGO_URI = process.env.MAPLE_MONGO_URI ?? 'mongodb://localhost:27017';

let mongo: MongoClient | null = null;
let mongoReachable = false;
let db: Db | null = null;
let tmpDir = '';
let libraryId = new ObjectId();

const app = new Elysia().use(folderRoutes);

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
  // Make this file order-independent: another test file's module-load may have
  // overwritten MAPLE_MONGO_DB and/or left the shared db-client singleton
  // connected to a different DB. Re-assert our DB and reset the singleton so
  // the route's getDb() reconnects to TEST_DB on first use.
  process.env.MAPLE_MONGO_DB = TEST_DB;
  await (await import('../../db/client.ts')).closeDb();

  mongo = await tryConnect();
  mongoReachable = mongo !== null;
  if (!mongoReachable) {
    console.log('[folder.test] skipping: MongoDB unreachable');
    return;
  }
  db = mongo!.db(TEST_DB);
  await db.dropDatabase();
  tmpDir = `/tmp/maple-folder-test-${process.pid}`;
  await mkdir(tmpDir, { recursive: true });

  // Wire the slug → library in the in-memory cache
  libraryId = new ObjectId();
  setLibraryBySlugForTests('testlib', {
    libraryId,
    root: tmpDir,
    label: 'Test Library',
  });
});

beforeEach(async () => {
  if (!mongoReachable || !db) return;
  await db.collection('assets').deleteMany({});
  await db.collection('folders').deleteMany({});
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

describe('GET /folder/:slug/*', () => {
  test('returns 404 for unknown slug', async () => {
    const res = await app.handle(new Request('http://localhost/folder/no-such-slug/'));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/slug/i);
  });

  test('matches the library root WITHOUT a trailing slash (regression: no SPA fallback)', async () => {
    if (!mongoReachable) return;
    // The web client requests `/api/folder/<slug>` (NO trailing slash) for the
    // library root. `/folder/:slug/*` alone does NOT match that, so the request
    // fell through to the SPA static handler and returned index.html (the live
    // "Http failure during parsing" bug). The root route must match it.
    const res = await app.handle(new Request('http://localhost/folder/testlib'));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toMatch(/application\/json/);
    const body = (await res.json()) as { address: string };
    expect(body.address).toBe('testlib:');
  });

  test('returns empty listing for a root with no files or subdirs', async () => {
    if (!mongoReachable) return;
    const subDir = path.join(tmpDir, `empty-${Date.now()}`);
    await mkdir(subDir, { recursive: true });
    const slugEntry = {
      libraryId: new ObjectId(),
      root: subDir,
      label: 'Empty',
    };
    setLibraryBySlugForTests('emptylib', slugEntry);

    const res = await app.handle(new Request('http://localhost/folder/emptylib/'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      address: string;
      parent: null;
      folders: unknown[];
      images: unknown[];
    };
    expect(body.address).toBe('emptylib:');
    expect(body.parent).toBeNull();
    expect(body.folders).toEqual([]);
    expect(body.images).toEqual([]);
  });

  test('returns indexed images from catalog', async () => {
    if (!mongoReachable) return;
    const mapleId = new ObjectId().toHexString();

    // Insert a catalog asset
    await db!.collection('assets').insertOne({
      maple_id: mapleId,
      fileinfo: [
        {
          library_id: libraryId,
          path: '',
          filename: 'shot.dng',
          deleted_at: null,
          missing_since: null,
        },
      ],
      deleted_at: null,
      exif: { width: 3000, height: 2000, captured_at: '2026-06-01T12:00:00Z' },
    } as never);

    const res = await app.handle(new Request('http://localhost/folder/testlib/'));
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      images: Array<{
        name: string;
        address: string;
        mapleId: string | null;
        indexed: boolean;
        width?: number;
        height?: number;
        capturedAt?: string;
      }>;
    };
    const img = body.images.find((i) => i.name === 'shot.dng');
    expect(img).toBeDefined();
    expect(img!.indexed).toBe(true);
    expect(img!.mapleId).toBe(mapleId);
    expect(img!.width).toBe(3000);
    expect(img!.address).toBe('testlib:shot.dng');
  });

  test('on-disk unindexed files appear with indexed:false', async () => {
    if (!mongoReachable) return;
    // Write a file to disk that is not in the catalog
    await writeFile(path.join(tmpDir, 'new-file.jpg'), 'fake-jpeg');

    const res = await app.handle(new Request('http://localhost/folder/testlib/'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      images: Array<{ name: string; indexed: boolean; mapleId: null }>;
    };
    const unindexed = body.images.find((i) => i.name === 'new-file.jpg');
    expect(unindexed).toBeDefined();
    expect(unindexed!.indexed).toBe(false);
    expect(unindexed!.mapleId).toBeNull();
  });

  test('Server-Timing header is present', async () => {
    if (!mongoReachable) return;
    const res = await app.handle(new Request('http://localhost/folder/testlib/'));
    expect(res.headers.get('Server-Timing')).toMatch(/^total;dur=\d+$/);
  });

  test('lists subdirectories', async () => {
    if (!mongoReachable) return;
    const sub = path.join(tmpDir, 'sub-album');
    await mkdir(sub, { recursive: true });
    const res = await app.handle(new Request('http://localhost/folder/testlib/'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { folders: Array<{ name: string; address: string }> };
    const found = body.folders.find((f) => f.name === 'sub-album');
    expect(found).toBeDefined();
    expect(found!.address).toBe('testlib:sub-album');
  });

  test('does NOT leak a deduplicated asset whose (library,path) live in different fileinfo entries', async () => {
    if (!mongoReachable) return;
    // Regression: a loose `{'fileinfo.library_id': id, 'fileinfo.path': relPath}`
    // query cross-matches when library_id and path come from DIFFERENT entries.
    // This asset has the test library at folderB and a *different* library at
    // folderA — querying folderA must NOT surface its folderB filename.
    await mkdir(path.join(tmpDir, 'folderA'), { recursive: true });
    await mkdir(path.join(tmpDir, 'folderB'), { recursive: true });
    await db!.collection('assets').insertOne({
      maple_id: new ObjectId().toHexString(),
      fileinfo: [
        {
          library_id: libraryId,
          path: 'folderB',
          filename: 'b.jpg',
          deleted_at: null,
          missing_since: null,
        },
        {
          library_id: new ObjectId(),
          path: 'folderA',
          filename: 'a.jpg',
          deleted_at: null,
          missing_since: null,
        },
      ],
      deleted_at: null,
    } as never);

    const res = await app.handle(new Request('http://localhost/folder/testlib/folderA'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { images: Array<{ name: string }> };
    expect(body.images.find((i) => i.name === 'b.jpg')).toBeUndefined();
    expect(body.images.find((i) => i.name === 'a.jpg')).toBeUndefined();
    expect(body.images).toEqual([]);
  });

  test('percent-decodes the wildcard so folders/files with spaces resolve', async () => {
    if (!mongoReachable) return;
    // Regression: Elysia does not decode path params; without explicit
    // decoding, `My%20Album` never matches the on-disk dir or the catalog path.
    await mkdir(path.join(tmpDir, 'My Album'), { recursive: true });
    await db!.collection('assets').insertOne({
      maple_id: new ObjectId().toHexString(),
      fileinfo: [
        {
          library_id: libraryId,
          path: 'My Album',
          filename: 'x.jpg',
          deleted_at: null,
          missing_since: null,
        },
      ],
      deleted_at: null,
    } as never);

    const res = await app.handle(new Request('http://localhost/folder/testlib/My%20Album'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      address: string;
      images: Array<{ name: string; address: string }>;
    };
    expect(body.address).toBe('testlib:My Album');
    const img = body.images.find((i) => i.name === 'x.jpg');
    expect(img).toBeDefined();
    expect(img!.address).toBe('testlib:My Album/x.jpg');
  });
});
