/**
 * Integration tests for POST /api/assets/batch-rename(/preview) (#2636).
 *
 * Route-level wiring on top of `library/batch-rename.test.ts`'s
 * already-thorough coverage of the sequential-apply/preview semantics —
 * this file checks the HTTP surface: body validation, status/shape
 * mapping, and one end-to-end pass to prove the route is actually wired to
 * the library functions.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Elysia } from 'elysia';
import { MongoClient, ObjectId, type Db } from 'mongodb';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { batchRenameRoutes } from './batch-rename.ts';
import { closeDb } from '../../db/client.ts';
import { setLibraryRootsForTests } from '../../indexer/libraries.cache.ts';
import { tryGetRawFfi } from '../../ffi/raw_ffi.ts';

// The two "end to end" tests below need a real rendered filename, which
// requires the native `raw-core` engine — unavailable in this repo's CI
// (`.github/workflows/api.yml` never builds `libraw_ffi`). Skip-gated the
// same way `library/batch-rename.test.ts` gates its render-dependent
// suites; see that file's module doc for the full rationale.
const ffiAvailable = tryGetRawFfi() !== null;
const maybeTest = ffiAvailable ? test : test.skip;

const MONGO_URI = process.env.MAPLE_MONGO_URI ?? 'mongodb://localhost:27017';
const TEST_DB = `maple_batch_rename_route_test_${process.pid}`;
const ORIGINAL_MONGO_DB = process.env.MAPLE_MONGO_DB;
const ORIGINAL_MONGO_URI = process.env.MAPLE_MONGO_URI;

const app = new Elysia({ prefix: '/api/assets' }).use(batchRenameRoutes);

async function post(urlPath: string, body: unknown): Promise<Response> {
  return app.handle(
    new Request(`http://localhost/api/assets${urlPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

describe('POST /api/assets/batch-rename — wiring', () => {
  test('returns 4xx for an empty ids array', async () => {
    const res = await post('/batch-rename', {
      ids: [],
      template: '{original}.{ext}',
      collision: 'auto-suffix',
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  test('returns 400 for a malformed id in the list', async () => {
    const res = await post('/batch-rename', {
      ids: [new ObjectId().toHexString(), 'not-an-object-id'],
      template: '{original}.{ext}',
      collision: 'auto-suffix',
    });
    expect(res.status).toBe(400);
  });

  test('returns 4xx for an invalid collision policy', async () => {
    const res = await post('/batch-rename', {
      ids: [new ObjectId().toHexString()],
      template: '{original}.{ext}',
      collision: 'yolo',
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  test('returns 4xx for a missing template', async () => {
    const res = await post('/batch-rename', {
      ids: [new ObjectId().toHexString()],
      collision: 'auto-suffix',
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });
});

describe('POST /api/assets/batch-rename/preview — wiring', () => {
  test('does not require a collision policy', async () => {
    const res = await post('/batch-rename/preview', {
      ids: [new ObjectId().toHexString()],
      template: '{original}.{ext}',
    });
    // Not-found item, but the request shape itself is valid — 200 with a
    // per-item error, not a 4xx.
    expect(res.status).toBe(200);
  });

  test('returns 400 for a malformed id in the list', async () => {
    const res = await post('/batch-rename/preview', {
      ids: ['not-an-object-id'],
      template: '{original}.{ext}',
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
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'batch-rename-route-'));
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

async function seedAssets(d: Db, names: string[]): Promise<ObjectId[]> {
  const libraryId = new ObjectId();
  await fs.mkdir(path.join(root, 'a'), { recursive: true });
  const ids: ObjectId[] = [];
  for (const filename of names) {
    const id = new ObjectId();
    await fs.writeFile(path.join(root, 'a', filename), 'pixels');
    await d.collection('assets').insertOne({
      _id: id,
      fileinfo: [{ path: 'a', filename, library_id: libraryId, deleted_at: null }],
      size: 6,
      mtime: 1_700_000_000_000,
      rating: 0,
      flag: 0,
      color_label: '',
      indexed_at: '2026-01-01T00:00:00Z',
      has_xmp: false,
      deleted_at: null,
    } as never);
    ids.push(id);
  }
  setLibraryRootsForTests(new Map([[libraryId.toHexString(), root]]));
  return ids;
}

describe('POST /api/assets/batch-rename — end to end', () => {
  maybeTest('applies the template sequentially and returns a summary', async () => {
    if (!db) return;
    const ids = await seedAssets(db, ['IMG_1.dng', 'IMG_2.dng']);

    const res = await post('/batch-rename', {
      ids: ids.map((id) => id.toHexString()),
      template: '{original}_{n}.{ext}',
      sequence_start: 1,
      sequence_pad_width: 2,
      collision: 'auto-suffix',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.summary).toEqual({ total: 2, relocated: 2, skipped: 0, failed: 0 });
    expect(body.results[0]).toMatchObject({ kind: 'relocated', new_filename: 'IMG_1_01.dng' });
    expect(body.results[1]).toMatchObject({ kind: 'relocated', new_filename: 'IMG_2_02.dng' });

    expect(await fs.readFile(path.join(root, 'a', 'IMG_1_01.dng'), 'utf8')).toBe('pixels');
  });
});

describe('POST /api/assets/batch-rename/preview — end to end', () => {
  maybeTest('renders names without applying anything', async () => {
    if (!db) return;
    const ids = await seedAssets(db, ['IMG_1.dng']);

    const res = await post('/batch-rename/preview', {
      ids: ids.map((id) => id.toHexString()),
      template: '{original}_preview.{ext}',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items[0]).toMatchObject({
      old_filename: 'IMG_1.dng',
      new_filename: 'IMG_1_preview.dng',
      duplicate: false,
    });

    // Unmoved.
    expect(await fs.readFile(path.join(root, 'a', 'IMG_1.dng'), 'utf8')).toBe('pixels');
  });
});
