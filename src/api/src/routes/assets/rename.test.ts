/**
 * Integration tests for POST /api/assets/:id/rename (#2636).
 *
 * Mirrors `relocate.test.ts`'s pattern: wiring/validation cases need no
 * Mongo, then a real MongoDB + real temp-dir files for the end-to-end
 * cases (skipped gracefully when Mongo is unreachable).
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Elysia } from 'elysia';
import { MongoClient, ObjectId, type Db } from 'mongodb';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { renameRoutes } from './rename.ts';
import { closeDb } from '../../db/client.ts';
import { setLibraryRootsForTests } from '../../indexer/libraries.cache.ts';
import { setRawFfiForTests, tryGetRawFfi } from '../../ffi/raw_ffi.ts';
import { fakeAuth } from '../../../tests/helpers/test-auth.ts';

// Any test whose expected outcome depends on `validateNewFilename` actually
// consulting the native engine (a real accept/reject, or reaching
// `relocateAsset` at all) needs `tryGetRawFfi()` to be non-null — absent in
// this repo's CI (`.github/workflows/api.yml` never builds `libraw_ffi`;
// see `library/batch-rename.test.ts`'s module doc for the full rationale).
// The "fails closed" describe block below is exempt: it forces the engine
// to `null` itself via `setRawFfiForTests`, so it's deterministic either
// way and stays on plain `test`.
const ffiAvailable = tryGetRawFfi() !== null;
const maybeTest = ffiAvailable ? test : test.skip;

const MONGO_URI = process.env.MAPLE_MONGO_URI ?? 'mongodb://localhost:27017';
const TEST_DB = `maple_rename_route_test_${process.pid}`;
const ORIGINAL_MONGO_DB = process.env.MAPLE_MONGO_DB;
const ORIGINAL_MONGO_URI = process.env.MAPLE_MONGO_URI;

const app = new Elysia({ prefix: '/api/assets' }).use(fakeAuth()).use(renameRoutes);

async function postRename(id: string, body: unknown): Promise<Response> {
  return app.handle(
    new Request(`http://localhost/api/assets/${id}/rename`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

// ---------------------------------------------------------------------------
// Wiring / validation — no Mongo required.
// ---------------------------------------------------------------------------

describe('POST /api/assets/:id/rename — wiring', () => {
  test('returns 400 for a malformed asset id', async () => {
    const res = await postRename('not-an-object-id', {
      new_filename: 'IMG_0002.dng',
      collision: 'auto-suffix',
    });
    expect(res.status).toBe(400);
  });

  test('returns 4xx for an invalid collision policy', async () => {
    const res = await postRename(new ObjectId().toHexString(), {
      new_filename: 'IMG_0002.dng',
      collision: 'yolo',
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  test('rejects a new_filename carrying a path separator', async () => {
    const res = await postRename(new ObjectId().toHexString(), {
      new_filename: 'sub/IMG_0002.dng',
      collision: 'auto-suffix',
    });
    expect(res.status).toBe(400);
  });

  maybeTest('rejects a Windows-reserved-device-name new_filename', async () => {
    const res = await postRename(new ObjectId().toHexString(), {
      new_filename: 'CON.dng',
      collision: 'auto-suffix',
    });
    expect(res.status).toBe(400);
  });

  maybeTest('rejects a new_filename with a trailing dot', async () => {
    const res = await postRename(new ObjectId().toHexString(), {
      new_filename: 'IMG_0002.',
      collision: 'auto-suffix',
    });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Fail-closed when the native validation engine is unavailable — no Mongo
// required, since it must reject before ever reaching the DB/filesystem.
// ---------------------------------------------------------------------------

describe('POST /api/assets/:id/rename — fails closed when the engine is unavailable', () => {
  afterEach(() => {
    setRawFfiForTests(undefined); // restore real load/cache behaviour
  });

  test('returns 503, not a silently-passed rename, when tryGetRawFfi() is null', async () => {
    setRawFfiForTests(null);
    const res = await postRename(new ObjectId().toHexString(), {
      // Would PASS isSafeFilename (single segment, no leading dot) — proves
      // this is rejected by the fail-closed engine-unavailable branch, not
      // by the fast isSafeFilename check that runs regardless.
      new_filename: 'CON.dng',
      collision: 'auto-suffix',
    });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toMatch(/engine unavailable/i);
  });

  test('an isSafeFilename violation still 400s even with the engine unavailable', async () => {
    setRawFfiForTests(null);
    const res = await postRename(new ObjectId().toHexString(), {
      new_filename: 'sub/IMG_0002.dng',
      collision: 'auto-suffix',
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
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'rename-route-'));
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
async function seedAssetOnDisk(d: Db, filename = 'IMG_1.dng'): Promise<ObjectId> {
  const libraryId = new ObjectId();
  const id = new ObjectId();
  await fs.mkdir(path.join(root, 'a'), { recursive: true });
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
  setLibraryRootsForTests(new Map([[libraryId.toHexString(), root]]));
  return id;
}

/** Seed TWO asset docs in the SAME folder, sharing one library id, so a
 * same-folder rename (destination collision) is reachable. */
async function seedTwoAssetsOnDiskSameLibrary(
  d: Db,
  a: { filename: string; content: string },
  b: { filename: string; content: string },
): Promise<{ idA: ObjectId; idB: ObjectId }> {
  const libraryId = new ObjectId();
  const idA = new ObjectId();
  const idB = new ObjectId();
  await fs.mkdir(path.join(root, 'a'), { recursive: true });
  for (const [id, entry] of [
    [idA, a],
    [idB, b],
  ] as const) {
    await fs.writeFile(path.join(root, 'a', entry.filename), entry.content);
    await d.collection('assets').insertOne({
      _id: id,
      fileinfo: [{ path: 'a', filename: entry.filename, library_id: libraryId, deleted_at: null }],
      size: entry.content.length,
      mtime: 1_700_000_000_000,
      rating: 0,
      flag: 0,
      color_label: '',
      indexed_at: '2026-01-01T00:00:00Z',
      has_xmp: false,
      deleted_at: null,
    } as never);
  }
  setLibraryRootsForTests(new Map([[libraryId.toHexString(), root]]));
  return { idA, idB };
}

describe('POST /api/assets/:id/rename — replace collision guard (#2843)', () => {
  maybeTest(
    'renaming onto a filename occupied by another live indexed asset is refused with 409',
    async () => {
      if (!db) return;
      const { idA: incomingId, idB: occupantId } = await seedTwoAssetsOnDiskSameLibrary(
        db,
        { filename: 'incoming.dng', content: 'incoming-pixels' },
        { filename: 'occupant.dng', content: 'occupant-pixels' },
      );

      const res = await postRename(incomingId.toHexString(), {
        new_filename: 'occupant.dng',
        collision: 'replace',
      });

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.occupied_by_asset_id).toBe(occupantId.toHexString());
      expect(await fs.readFile(path.join(root, 'a', 'incoming.dng'), 'utf8')).toBe(
        'incoming-pixels',
      );
      expect(await fs.readFile(path.join(root, 'a', 'occupant.dng'), 'utf8')).toBe(
        'occupant-pixels',
      );
    },
  );

  maybeTest(
    'renaming onto a filename occupied only by an untracked file still succeeds (200)',
    async () => {
      if (!db) return;
      const id = await seedAssetOnDisk(db);
      await fs.writeFile(path.join(root, 'a', 'untracked.dng'), 'stale-untracked-bytes');

      const res = await postRename(id.toHexString(), {
        new_filename: 'untracked.dng',
        collision: 'replace',
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.new_filename).toBe('untracked.dng');
    },
  );
});

describe('POST /api/assets/:id/rename — end to end', () => {
  maybeTest('renames the asset in place (same folder), returns the new address', async () => {
    if (!db) return;
    const id = await seedAssetOnDisk(db);

    const res = await postRename(id.toHexString(), {
      new_filename: 'IMG_renamed.dng',
      collision: 'auto-suffix',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.new_path).toBe('a');
    expect(body.new_filename).toBe('IMG_renamed.dng');
    expect(body.renamed_on_collision).toBe(false);
    expect(body.extension_changed).toBe(false);

    const row = (await db.collection('assets').findOne({ _id: id })) as unknown as {
      fileinfo: Array<{ path: string; filename: string }>;
    };
    expect(row.fileinfo[0]!.path).toBe('a');
    expect(row.fileinfo[0]!.filename).toBe('IMG_renamed.dng');
    await expect(fs.readFile(path.join(root, 'a', 'IMG_1.dng'), 'utf8')).rejects.toThrow();
    expect(await fs.readFile(path.join(root, 'a', 'IMG_renamed.dng'), 'utf8')).toBe('pixels');
  });

  maybeTest('flags an extension change in the response, but still allows it', async () => {
    if (!db) return;
    const id = await seedAssetOnDisk(db);

    const res = await postRename(id.toHexString(), {
      new_filename: 'IMG_renamed.jpg',
      collision: 'auto-suffix',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.new_filename).toBe('IMG_renamed.jpg');
    expect(body.extension_changed).toBe(true);
  });

  maybeTest('a collision with an existing file at the destination auto-suffixes', async () => {
    if (!db) return;
    const id = await seedAssetOnDisk(db);
    await fs.writeFile(path.join(root, 'a', 'existing.dng'), 'other pixels');

    const res = await postRename(id.toHexString(), {
      new_filename: 'existing.dng',
      collision: 'auto-suffix',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.renamed_on_collision).toBe(true);
    expect(body.new_filename).not.toBe('existing.dng');
  });

  maybeTest('returns 404 for an unknown asset id', async () => {
    if (!db) return;
    const res = await postRename(new ObjectId().toHexString(), {
      new_filename: 'IMG_renamed.dng',
      collision: 'auto-suffix',
    });
    expect(res.status).toBe(404);
  });
});
