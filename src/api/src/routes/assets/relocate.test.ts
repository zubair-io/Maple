/**
 * Integration tests for POST /api/assets/:id/relocate (#2629).
 *
 * Mirrors `routes/library-relocate.test.ts`'s pattern for the
 * validation/wiring cases (no Mongo required), plus a real end-to-end
 * pass against a real MongoDB + real temp-dir files (skipped gracefully
 * when Mongo is unreachable, same as `library/relocate-asset.test.ts`).
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Elysia } from 'elysia';
import { MongoClient, ObjectId, type Db } from 'mongodb';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { relocateRoutes } from './relocate.ts';
import { closeDb } from '../../db/client.ts';
import { setLibraryRootsForTests } from '../../indexer/libraries.cache.ts';

const MONGO_URI = process.env.MAPLE_MONGO_URI ?? 'mongodb://localhost:27017';
const TEST_DB = `maple_relocate_route_test_${process.pid}`;
const ORIGINAL_MONGO_DB = process.env.MAPLE_MONGO_DB;
const ORIGINAL_MONGO_URI = process.env.MAPLE_MONGO_URI;

const app = new Elysia({ prefix: '/api/assets' }).use(relocateRoutes);

async function postRelocate(id: string, body: unknown): Promise<Response> {
  return app.handle(
    new Request(`http://localhost/api/assets/${id}/relocate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

// ---------------------------------------------------------------------------
// Wiring / validation — no Mongo required.
// ---------------------------------------------------------------------------

describe('POST /api/assets/:id/relocate — wiring', () => {
  test('returns 400 for a malformed asset id', async () => {
    const res = await postRelocate('not-an-object-id', {
      mode: 'move',
      collision: 'auto-suffix',
      destination_path: 'b',
    });
    expect(res.status).toBe(400);
  });

  test('returns 4xx for an invalid mode', async () => {
    const res = await postRelocate(new ObjectId().toHexString(), {
      mode: 'teleport',
      collision: 'auto-suffix',
      destination_path: 'b',
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  test('returns 4xx for an invalid collision policy', async () => {
    const res = await postRelocate(new ObjectId().toHexString(), {
      mode: 'move',
      collision: 'yolo',
      destination_path: 'b',
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  test('returns 4xx when destination_path is missing', async () => {
    const res = await postRelocate(new ObjectId().toHexString(), {
      mode: 'move',
      collision: 'auto-suffix',
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });
});

// ---------------------------------------------------------------------------
// Path traversal — rejected at the HTTP boundary, before Mongo or the
// filesystem are ever touched (jules review on #2669).
// ---------------------------------------------------------------------------

describe('POST /api/assets/:id/relocate — path traversal is rejected with 400', () => {
  test('destination_path with ../.. traversal', async () => {
    const res = await postRelocate(new ObjectId().toHexString(), {
      mode: 'move',
      collision: 'auto-suffix',
      destination_path: '../../etc/passwd',
    });
    expect(res.status).toBe(400);
  });

  test('an absolute destination_path', async () => {
    const res = await postRelocate(new ObjectId().toHexString(), {
      mode: 'move',
      collision: 'auto-suffix',
      destination_path: '/etc/passwd',
    });
    expect(res.status).toBe(400);
  });

  test('a backslash-variant destination_path', async () => {
    const res = await postRelocate(new ObjectId().toHexString(), {
      mode: 'move',
      collision: 'auto-suffix',
      destination_path: 'a\\..\\..\\etc\\passwd',
    });
    expect(res.status).toBe(400);
  });

  test('a destination_filename carrying its own traversal', async () => {
    const res = await postRelocate(new ObjectId().toHexString(), {
      mode: 'move',
      collision: 'auto-suffix',
      destination_path: 'b',
      destination_filename: '../../../etc/passwd',
    });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// End-to-end — real Mongo + real temp-dir files.
// ---------------------------------------------------------------------------

let client: MongoClient | null = null;
let db: Db | null = null;
let root: string;

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

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'relocate-route-'));
  client = await tryConnect();
  if (!client) return;
  await closeDb();
  process.env.MAPLE_MONGO_URI = MONGO_URI;
  process.env.MAPLE_MONGO_DB = TEST_DB;
  db = client.db(TEST_DB);
  await db.dropDatabase();
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
  setLibraryRootsForTests(null);
});

afterAll(async () => {
  if (db) await db.dropDatabase();
  if (client) await client.close();
  if (ORIGINAL_MONGO_DB === undefined) delete process.env.MAPLE_MONGO_DB;
  else process.env.MAPLE_MONGO_DB = ORIGINAL_MONGO_DB;
  if (ORIGINAL_MONGO_URI === undefined) delete process.env.MAPLE_MONGO_URI;
  else process.env.MAPLE_MONGO_URI = ORIGINAL_MONGO_URI;
  await closeDb();
});

/** Write `a/IMG_1.dng` under `root` and seed a matching asset doc pointing
 * at it, wiring the in-memory library-roots cache to resolve it. */
async function seedAssetOnDisk(d: Db): Promise<ObjectId> {
  const libraryId = new ObjectId();
  const id = new ObjectId();
  await fs.mkdir(path.join(root, 'a'), { recursive: true });
  await fs.writeFile(path.join(root, 'a', 'IMG_1.dng'), 'pixels');
  await d.collection('assets').insertOne({
    _id: id,
    fileinfo: [{ path: 'a', filename: 'IMG_1.dng', library_id: libraryId, deleted_at: null }],
    size: 6,
    mtime: 1_700_000_000_000,
    rating: 0,
    flag: 0,
    color_label: '',
    indexed_at: '2026-01-01T00:00:00Z',
    has_xmp: false,
    deleted_at: null,
  } as never);
  setLibraryRootsForTests(new Map([[libraryId.toHexString(), root]]));
  return id;
}

describe('POST /api/assets/:id/relocate — end to end', () => {
  test('moves the asset, returns the new path, and repoints the DB', async () => {
    if (!db) return;
    const id = await seedAssetOnDisk(db);

    const res = await postRelocate(id.toHexString(), {
      mode: 'move',
      collision: 'auto-suffix',
      destination_path: 'b',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.new_path).toBe('b');
    expect(body.new_filename).toBe('IMG_1.dng');
    expect(body.renamed_on_collision).toBe(false);

    const row = (await db.collection('assets').findOne({ _id: id })) as unknown as {
      fileinfo: Array<{ path: string; filename: string }>;
    };
    expect(row.fileinfo[0]!.path).toBe('b');
    await expect(fs.readFile(path.join(root, 'a', 'IMG_1.dng'), 'utf8')).rejects.toThrow();
    expect(await fs.readFile(path.join(root, 'b', 'IMG_1.dng'), 'utf8')).toBe('pixels');
  });

  test('returns 404 for an unknown asset id', async () => {
    if (!db) return;
    const res = await postRelocate(new ObjectId().toHexString(), {
      mode: 'move',
      collision: 'auto-suffix',
      destination_path: 'b',
    });
    expect(res.status).toBe(404);
  });
});
