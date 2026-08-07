/**
 * Integration tests for `batchRenameAssets` / `previewBatchRename` (#2636).
 *
 * Real temp-dir files + real Mongo (skips gracefully when Mongo is
 * unreachable), following `relocate-asset.test.ts`'s pattern. Covers: each
 * template token, sequential self-collision mid-batch (the design doc's
 * explicit acceptance criterion), partial-failure reporting, and the
 * preview/dry-run mode.
 *
 * Tests that need an actual RENDERED name (not just the fail-closed
 * per-item error) require the native `raw-core` engine — `tryGetRawFfi()`
 * returns `null` in this repo's CI (`.github/workflows/api.yml` runs `bun
 * test` without ever building `libraw_ffi`; only the local dev workflow
 * runs `build-raw-ffi.sh`). `maybeTest` skip-gates exactly those tests, the
 * same "skip when the native dependency isn't present, don't fail
 * spuriously" convention `test_color_pipeline.sh` and the XCUITest visual
 * harness already use for their own native/fixture dependencies. The
 * fail-closed tests at the bottom of this file are NOT gated — they force
 * `tryGetRawFfi()` to `null` themselves via `setRawFfiForTests`, so they're
 * deterministic in every environment, dylib or not.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { MongoClient, ObjectId, type Db } from 'mongodb';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { closeDb } from '../db/client.ts';
import { setLibraryRootsForTests } from '../indexer/libraries.cache.ts';
import { setRawFfiForTests, tryGetRawFfi } from '../ffi/raw_ffi.ts';
import { batchRenameAssets, previewBatchRename } from './batch-rename.ts';

const ffiAvailable = tryGetRawFfi() !== null;
const maybeTest = ffiAvailable ? test : test.skip;

const MONGO_URI = process.env.MAPLE_MONGO_URI ?? 'mongodb://localhost:27017';
const TEST_DB = `maple_batch_rename_test_${process.pid}`;
const ORIGINAL_MONGO_DB = process.env.MAPLE_MONGO_DB;
const ORIGINAL_MONGO_URI = process.env.MAPLE_MONGO_URI;

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
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'batch-rename-'));
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

/** Seed `count` assets on disk (`a/name0.dng`, `a/name1.dng`, ...) under one
 * library root, each with a distinct `exif.captured_at`, and wire the
 * in-memory library-roots cache. Returns ids in insertion (batch) order. */
async function seedAssets(
  d: Db,
  names: string[],
  capturedAt: (string | null)[] = [],
): Promise<ObjectId[]> {
  const libraryId = new ObjectId();
  await fs.mkdir(path.join(root, 'a'), { recursive: true });
  const ids: ObjectId[] = [];
  for (let i = 0; i < names.length; i++) {
    const id = new ObjectId();
    const filename = names[i]!;
    await fs.writeFile(path.join(root, 'a', filename), `pixels-${i}`);
    await d.collection('assets').insertOne({
      _id: id,
      fileinfo: [{ path: 'a', filename, library_id: libraryId, deleted_at: null }],
      size: 8,
      mtime: 1_700_000_000_000,
      rating: 0,
      flag: 0,
      color_label: '',
      indexed_at: '2026-01-01T00:00:00Z',
      has_xmp: false,
      deleted_at: null,
      exif: capturedAt[i] ? { captured_at: capturedAt[i] } : null,
    } as never);
    ids.push(id);
  }
  setLibraryRootsForTests(new Map([[libraryId.toHexString(), root]]));
  return ids;
}

describe('batchRenameAssets — tokens', () => {
  maybeTest('{original}, {n}, {ext}, and {date:FORMAT} all render', async () => {
    if (!db) return;
    const ids = await seedAssets(
      db,
      ['IMG_1.dng', 'IMG_2.dng'],
      ['2024-06-01T12:00:00.000Z', '2024-06-02T13:00:00.000Z'],
    );

    const results = await batchRenameAssets({
      ids,
      template: '{date:%Y%m%d}_{original}_{n}.{ext}',
      sequenceStart: 1,
      sequencePadWidth: 3,
      collision: 'auto-suffix',
    });

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ kind: 'relocated', newFilename: '20240601_IMG_1_001.dng' });
    expect(results[1]).toMatchObject({ kind: 'relocated', newFilename: '20240602_IMG_2_002.dng' });

    expect(await fs.readFile(path.join(root, 'a', '20240601_IMG_1_001.dng'), 'utf8')).toBe(
      'pixels-0',
    );
    expect(await fs.readFile(path.join(root, 'a', '20240602_IMG_2_002.dng'), 'utf8')).toBe(
      'pixels-1',
    );
  });

  maybeTest(
    'a missing captured_at falls back to the engine placeholder, not a failure',
    async () => {
      if (!db) return;
      const ids = await seedAssets(db, ['IMG_1.dng']);

      const results = await batchRenameAssets({
        ids,
        template: '{date:%Y}_{original}.{ext}',
        sequenceStart: 0,
        sequencePadWidth: 0,
        collision: 'auto-suffix',
      });

      expect(results[0]).toMatchObject({
        kind: 'relocated',
        newFilename: 'unknown-date_IMG_1.dng',
      });
    },
  );
});

describe('batchRenameAssets — sequential self-collision mid-batch', () => {
  maybeTest(
    'a template that collides with itself is resolved by the collision policy per step',
    async () => {
      if (!db) return;
      // Every file renders to the SAME literal name — a template with no
      // distinguishing token, e.g. a user typo. Sequential application must
      // see each PRIOR step's result and auto-suffix against it, not just
      // against pre-existing files.
      const ids = await seedAssets(db, ['a.dng', 'b.dng', 'c.dng']);

      const results = await batchRenameAssets({
        ids,
        template: 'shared.dng',
        sequenceStart: 0,
        sequencePadWidth: 0,
        collision: 'auto-suffix',
      });

      expect(results).toHaveLength(3);
      const newNames = results.map((r) => (r.kind === 'relocated' ? r.newFilename : null));
      // All three destinations must be distinct — proves each step saw the
      // previous step's write, not a stale/pre-batch directory listing.
      expect(new Set(newNames).size).toBe(3);
      expect(newNames[0]).toBe('shared.dng');
      expect(newNames[1]).not.toBe('shared.dng');
      expect(newNames[2]).not.toBe('shared.dng');
      expect(newNames[2]).not.toBe(newNames[1]);

      // The files really exist on disk at their distinct destinations, and
      // the ORIGINAL content stayed attached to the right asset (no
      // cross-file data mixing from the collision).
      for (const [i, name] of newNames.entries()) {
        expect(await fs.readFile(path.join(root, 'a', name as string), 'utf8')).toBe(`pixels-${i}`);
      }
    },
  );

  maybeTest(
    'collision: "skip" leaves later self-collisions untouched, reported per item',
    async () => {
      if (!db) return;
      const ids = await seedAssets(db, ['a.dng', 'b.dng']);

      const results = await batchRenameAssets({
        ids,
        template: 'shared.dng',
        sequenceStart: 0,
        sequencePadWidth: 0,
        collision: 'skip',
      });

      expect(results[0]).toMatchObject({ kind: 'relocated', newFilename: 'shared.dng' });
      expect(results[1]).toMatchObject({ kind: 'skipped' });
      // The second file was never moved — it's still at its original name.
      expect(await fs.readFile(path.join(root, 'a', 'b.dng'), 'utf8')).toBe('pixels-1');
    },
  );
});

describe('batchRenameAssets — partial failure', () => {
  maybeTest(
    'an unknown id in the middle of the batch is reported, not thrown, and the rest still apply',
    async () => {
      if (!db) return;
      // One `seedAssets` call — it re-wires the in-memory library-roots cache
      // to a single map, so a second call would stomp the first's mapping.
      const [first, , third] = await seedAssets(db, ['a.dng', 'ignore-me.dng', 'c.dng']);
      const missing = new ObjectId();

      const results = await batchRenameAssets({
        ids: [first!, missing, third!],
        template: 'renamed_{n}.{ext}',
        sequenceStart: 0,
        sequencePadWidth: 0,
        collision: 'auto-suffix',
      });

      expect(results).toHaveLength(3);
      expect(results[0]).toMatchObject({ kind: 'relocated', newFilename: 'renamed_0.dng' });
      expect(results[1]).toMatchObject({ kind: 'not-found' });
      expect(results[2]).toMatchObject({ kind: 'relocated', newFilename: 'renamed_2.dng' });
    },
  );

  test('an unrenderable template (unknown token) is reported per-item as invalid', async () => {
    if (!db) return;
    const ids = await seedAssets(db, ['a.dng']);

    const results = await batchRenameAssets({
      ids,
      template: '{bogus}.{ext}',
      sequenceStart: 0,
      sequencePadWidth: 0,
      collision: 'auto-suffix',
    });

    expect(results[0]!.kind).toBe('invalid');
  });
});

describe('previewBatchRename — dry run', () => {
  maybeTest('renders names without touching the filesystem or the DB', async () => {
    if (!db) return;
    const ids = await seedAssets(db, ['IMG_1.dng', 'IMG_2.dng']);

    const preview = await previewBatchRename({
      ids,
      template: '{original}_{n}.{ext}',
      sequenceStart: 1,
      sequencePadWidth: 2,
    });

    expect(preview).toEqual([
      {
        id: ids[0]!.toHexString(),
        oldFilename: 'IMG_1.dng',
        newFilename: 'IMG_1_01.dng',
        error: null,
        duplicate: false,
      },
      {
        id: ids[1]!.toHexString(),
        oldFilename: 'IMG_2.dng',
        newFilename: 'IMG_2_02.dng',
        error: null,
        duplicate: false,
      },
    ]);

    // Nothing on disk moved.
    expect(await fs.readFile(path.join(root, 'a', 'IMG_1.dng'), 'utf8')).toBe('pixels-0');
    expect(await fs.readFile(path.join(root, 'a', 'IMG_2.dng'), 'utf8')).toBe('pixels-1');
  });

  maybeTest('flags a self-colliding template as duplicate, without applying anything', async () => {
    if (!db) return;
    const ids = await seedAssets(db, ['a.dng', 'b.dng']);

    const preview = await previewBatchRename({
      ids,
      template: 'shared.dng',
      sequenceStart: 0,
      sequencePadWidth: 0,
    });

    expect(preview[0]).toMatchObject({ newFilename: 'shared.dng', duplicate: false });
    expect(preview[1]).toMatchObject({ newFilename: 'shared.dng', duplicate: true });
    // Still unmoved — preview never writes.
    expect(await fs.readFile(path.join(root, 'a', 'a.dng'), 'utf8')).toBe('pixels-0');
    expect(await fs.readFile(path.join(root, 'a', 'b.dng'), 'utf8')).toBe('pixels-1');
  });
});

describe('batch-rename — fails closed when the engine is unavailable', () => {
  afterEach(() => {
    setRawFfiForTests(undefined); // restore real load/cache behaviour
  });

  test('batchRenameAssets reports every item as invalid, applies nothing', async () => {
    if (!db) return;
    const ids = await seedAssets(db, ['IMG_1.dng', 'IMG_2.dng']);
    setRawFfiForTests(null);

    const results = await batchRenameAssets({
      ids,
      template: '{original}_renamed.{ext}',
      sequenceStart: 0,
      sequencePadWidth: 0,
      collision: 'auto-suffix',
    });

    expect(results).toHaveLength(2);
    for (const r of results) {
      expect(r.kind).toBe('invalid');
      expect(r.kind === 'invalid' && r.error).toMatch(/engine unavailable/i);
    }
    // Nothing moved — the render step itself never produces a name without
    // the engine, so relocateAsset is never reached.
    expect(await fs.readFile(path.join(root, 'a', 'IMG_1.dng'), 'utf8')).toBe('pixels-0');
    expect(await fs.readFile(path.join(root, 'a', 'IMG_2.dng'), 'utf8')).toBe('pixels-1');
  });

  test('previewBatchRename surfaces the same per-item error, not a fabricated name', async () => {
    if (!db) return;
    const ids = await seedAssets(db, ['IMG_1.dng']);
    setRawFfiForTests(null);

    const preview = await previewBatchRename({
      ids,
      template: '{original}_renamed.{ext}',
      sequenceStart: 0,
      sequencePadWidth: 0,
    });

    expect(preview[0]!.newFilename).toBeNull();
    expect(preview[0]!.error).toMatch(/engine unavailable/i);
  });
});
