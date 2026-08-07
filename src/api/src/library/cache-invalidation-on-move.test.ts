/**
 * Cross-surface cache-invalidation-on-move verification (#2659) — the ticket
 * that closes the File Management epic's last unproven claim: every relocate
 * implementation asserts (in comments and in docs/caching.md) that cache
 * keys are path-derived, so a move must NOT relocate cache files — it bumps
 * the thumb/preview stage-version and lets the workers regenerate at the
 * new path. This proves that end to end on the API surface, real files +
 * real MongoDB (skips, not fails, when Mongo is unreachable — same pattern
 * as `relocate-asset.test.ts`).
 *
 * Deliberately its OWN suite, not an extension of the #2633
 * `relocate.parity.test.ts` corpus. That corpus's model is a pure
 * before/after FILE-TREE comparison (`readTree` walks every regular file and
 * diffs it against `expected.tree`) replayed against three independent
 * per-platform primitives from ONE declarative JSON case. Cache invalidation
 * is fundamentally stateful in ways that model doesn't express: it needs
 * DB-side stage-version bookkeeping (Mongo, API-only — Apple and Windows have
 * no equivalent document to assert against), a worker HANDLER re-run (not
 * just the `relocateFile` primitive), and a time-travelled GC sweep pass.
 * Contorting the corpus schema to cover this would either bloat it with
 * fields only one of three runners can act on, or lose the sharp file-tree
 * diff the corpus is good at. A focused suite here, and the Apple/Windows
 * counterparts described in the PR, prove the SAME claim without forcing one
 * shared shape onto three architecturally different cache designs.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { MongoClient, ObjectId, type Db } from 'mongodb';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import sharp from 'sharp';
import { closeDb } from '../db/client.ts';
import { setLibraryRootsForTests } from '../indexer/libraries.cache.ts';
import { relocateAsset } from './relocate-asset.ts';
import thumbStage from '../workers/stages/thumb.ts';
import { resolveThumbPathForAsset } from '../fs/xmp.ts';
import { sweepOrphanedCaches } from '../workers/cache-gc.ts';

const MONGO_URI = process.env.MAPLE_MONGO_URI ?? 'mongodb://localhost:27017';
const TEST_DB = `maple_cache_invalidation_move_test_${process.pid}`;
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
    } catch {
      /* ignore */
    }
    return null;
  }
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'cache-invalidation-move-'));
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

/** A tiny real JPEG — routes `generateThumb` through the sharp/imgdecode
 * bitmap branch, which needs no libraw_ffi build, so this suite runs
 * anywhere `bun test` runs (unlike the RAW-fixture-gated tests elsewhere). */
async function writeJpeg(absPath: string): Promise<void> {
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  const buf = await sharp({
    create: { width: 400, height: 300, channels: 3, background: { r: 20, g: 120, b: 200 } },
  })
    .jpeg()
    .toBuffer();
  await fs.writeFile(absPath, buf);
}

/** Every per-image stage this asset carries, pre-relocate, all dirty
 * (non-zero versions / a processed_at / an attempt) so a test can tell
 * "reset" apart from "already zero". Includes the genuinely expensive
 * per-image stages (describe = VLM caption/OCR, face-detect/face-embed =
 * ML inference, geocode = reverse-geocode lookup) alongside thumb/preview,
 * because the ticket's subtle criterion is exactly the CONTRAST between
 * them: a move must bump the cheap raster-cache stages so they regenerate,
 * and must NOT force the expensive stages to redo multi-second inference
 * work that a mere path change can't have invalidated. */
function dirtyStagesFixture(): Record<string, unknown> {
  const dirty = (overrides: Record<string, unknown> = {}) => ({
    version: 3,
    attempts: 2,
    last_error: null,
    processed_at: new Date().toISOString(),
    dead: false,
    ...overrides,
  });
  return {
    exif: dirty({ version: 1 }),
    thumb: dirty(),
    preview: dirty(),
    'face-detect': dirty(),
    'face-embed': dirty(),
    describe: dirty(),
    geocode: dirty(),
    meili: dirty(),
    'sidecar-metadata-index': dirty(),
    'cf-thumb-sync': dirty(),
    transcribe: dirty(),
  };
}

async function seedAsset(
  d: Db,
  relPath: string,
  filename: string,
): Promise<{ id: ObjectId; libraryId: ObjectId }> {
  const libraryId = new ObjectId();
  const id = new ObjectId();
  await d.collection('assets').insertOne({
    _id: id,
    fileinfo: [{ path: relPath, filename, library_id: libraryId, deleted_at: null }],
    size: 6,
    mtime: 1_700_000_000_000,
    rating: 0,
    flag: 0,
    color_label: '',
    indexed_at: '2026-01-01T00:00:00Z',
    has_xmp: false,
    deleted_at: null,
    stages: dirtyStagesFixture(),
  } as never);
  setLibraryRootsForTests(new Map([[libraryId.toHexString(), root]]));
  return { id, libraryId };
}

type StageRow = { version: number; attempts: number; processed_at: unknown };
type AssetRow = {
  fileinfo: Array<{ path: string; filename: string; library_id: ObjectId }>;
  stages: Record<string, StageRow>;
};

async function fetchAssetRow(d: Db, id: ObjectId): Promise<AssetRow> {
  return (await d.collection('assets').findOne({ _id: id })) as unknown as AssetRow;
}

/** Age a file past `sweepOrphanedCaches`' 60s TOCTOU recency guard, so it's
 * eligible for the sweep to consider deleting it. Mirrors `agePast` in
 * `workers/cache-gc.test.ts`. */
async function agePast(p: string): Promise<void> {
  const past = new Date(Date.now() - 5 * 60 * 1000);
  await fs.utimes(p, past, past);
}

describe('cache invalidation on move (#2659)', () => {
  test('criterion 3 — a move resets ONLY the cheap raster-cache stages (thumb/preview); the expensive VLM/ML stages (describe/face-detect/face-embed/geocode) are left alone', async () => {
    if (!db) return;
    await writeJpeg(path.join(root, 'a', 'IMG_1.jpg'));
    const { id } = await seedAsset(db, 'a', 'IMG_1.jpg');
    const before = await fetchAssetRow(db, id);
    // Sanity: every stage really did start dirty, or "left alone" below would
    // trivially pass by never having anything to disturb.
    for (const name of ['describe', 'face-detect', 'face-embed', 'geocode']) {
      expect(before.stages[name]!.version).toBe(3);
    }

    const result = await relocateAsset({
      id,
      mode: 'move',
      collision: 'auto-suffix',
      destinationPath: 'b',
    });
    expect(result.kind).toBe('relocated');

    const after = await fetchAssetRow(db, id);
    // The cheap tier — path-keyed raster caches — is bumped back to
    // unprocessed so the workers regenerate at the new path.
    expect(after.stages.thumb!.version).toBe(0);
    expect(after.stages.preview!.version).toBe(0);
    // The expensive tier is untouched: the pixels didn't change, so a
    // VLM caption, a face embedding, and a reverse-geocode lookup computed
    // before the move are still valid after it. Re-running them on every
    // rename/move in a library would turn an O(1) filesystem op into an
    // O(inference) one — exactly the "expensive full re-decode" the
    // ticket's third criterion rules out.
    expect(after.stages['face-detect']!.version).toBe(3);
    expect(after.stages['face-embed']!.version).toBe(3);
    expect(after.stages.describe!.version).toBe(3);
    expect(after.stages.geocode!.version).toBe(3);
    expect(after.stages['face-detect']!.processed_at).toEqual(
      before.stages['face-detect']!.processed_at,
    );
    expect(after.stages.describe!.processed_at).toEqual(before.stages.describe!.processed_at);
  });

  test('criterion 1 — the new path serves a correct thumbnail after re-running only the thumb stage handler, no full rescan', async () => {
    if (!db) return;
    const oldAbsPath = path.join(root, 'a', 'IMG_1.jpg');
    await writeJpeg(oldAbsPath);
    const { id, libraryId } = await seedAsset(db, 'a', 'IMG_1.jpg');
    const libs = new Map([[libraryId.toHexString(), root]]);

    // Populate the OLD location's thumb, as a real cold-open would have.
    const docBefore = await fetchAssetRow(db, id);
    const oldThumbPath = resolveThumbPathForAsset(docBefore as never, libs);
    expect(oldThumbPath).not.toBeNull();
    const oldResult = await thumbStage.handler(docBefore as never, {} as never);
    expect(oldResult).toEqual({ wrote: true });
    const oldStat = await fs.stat(oldThumbPath as string);
    expect(oldStat.size).toBeGreaterThan(0);

    const relocateResult = await relocateAsset({
      id,
      mode: 'move',
      collision: 'auto-suffix',
      destinationPath: 'b',
    });
    expect(relocateResult.kind).toBe('relocated');

    // Re-run ONLY the thumb stage handler for this one asset — the same unit
    // of work the version-reset arms in production, never a folder-wide
    // discover/rescan. That handler alone must be sufficient to produce a
    // correct thumbnail at the new path.
    const docAfter = await fetchAssetRow(db, id);
    const newThumbPath = resolveThumbPathForAsset(docAfter as never, libs);
    expect(newThumbPath).not.toBeNull();
    expect(newThumbPath).not.toBe(oldThumbPath);
    const newResult = await thumbStage.handler(docAfter as never, {} as never);
    expect(newResult).toEqual({ wrote: true });
    const newStat = await fs.stat(newThumbPath as string);
    expect(newStat.size).toBeGreaterThan(0);
    // The regenerated thumb decodes as a real image (not a truncated/corrupt
    // write) — `finalizeAvifRender`'s validation gate already enforces this
    // at write time, this re-confirms it end to end.
    const meta = await sharp(newThumbPath as string).metadata();
    expect(meta.width).toBeGreaterThan(0);
    expect(meta.height).toBeGreaterThan(0);
  });

  test('criterion 2 — the old thumbnail is not served for the new path, and is reclaimed (not kept forever) once cache-gc sweeps it', async () => {
    if (!db) return;
    const oldAbsPath = path.join(root, 'a', 'IMG_1.jpg');
    await writeJpeg(oldAbsPath);
    const { id, libraryId } = await seedAsset(db, 'a', 'IMG_1.jpg');
    const libs = new Map([[libraryId.toHexString(), root]]);

    const docBefore = await fetchAssetRow(db, id);
    const oldThumbPath = resolveThumbPathForAsset(docBefore as never, libs) as string;
    await thumbStage.handler(docBefore as never, {} as never);
    await fs.stat(oldThumbPath); // exists

    await relocateAsset({ id, mode: 'move', collision: 'auto-suffix', destinationPath: 'b' });

    // Not served: a reader resolving the NEW path's thumb never lands on the
    // OLD file — the two are different filesystem paths by construction
    // (path-keyed hash), never the same cache slot repointed.
    const docAfter = await fetchAssetRow(db, id);
    const newThumbPath = resolveThumbPathForAsset(docAfter as never, libs) as string;
    expect(newThumbPath).not.toBe(oldThumbPath);
    await thumbStage.handler(docAfter as never, {} as never);

    // Does not leak forever: right after the move the orphaned old file is
    // still physically present (a synchronous per-file delete isn't part of
    // this API's design — see relocate-asset.ts's CACHE_STAGES doc comment),
    // but cache-gc's sweep reclaims it once it ages past the TOCTOU recency
    // guard, while leaving the live new-path thumb untouched.
    await fs.stat(oldThumbPath); // still there immediately after the move
    await agePast(oldThumbPath);
    const sweep = await sweepOrphanedCaches(root);
    expect(sweep.deleted).toBeGreaterThanOrEqual(1);
    await expect(fs.stat(oldThumbPath)).rejects.toThrow();
    const newStat = await fs.stat(newThumbPath);
    expect(newStat.size).toBeGreaterThan(0);
  });

  test('a move relocates byte-identical content, so the eventual re-render re-extracts the SAME bytes rather than reimporting changed ones', async () => {
    if (!db) return;
    const oldAbsPath = path.join(root, 'a', 'IMG_1.jpg');
    await writeJpeg(oldAbsPath);
    const beforeBytes = await fs.readFile(oldAbsPath);
    const { id } = await seedAsset(db, 'a', 'IMG_1.jpg');

    const result = await relocateAsset({
      id,
      mode: 'move',
      collision: 'auto-suffix',
      destinationPath: 'b',
    });
    expect(result.kind).toBe('relocated');
    if (result.kind !== 'relocated') return;

    const newAbsPath = path.join(root, result.newPath, result.newFilename);
    const afterBytes = await fs.readFile(newAbsPath);
    // `relocateFile` always copies-then-verifies-then-deletes (never a bare
    // rename — crash safety, see fs/relocate.ts's module doc step 2-3), so
    // the destination's mtime is a fresh write time, NOT preserved from the
    // source — that's expected and is in fact what makes `primary_mtime`
    // a correct component of the Apple preview-cache key (docs/caching.md
    // §3): a relocate always changes it, so a stale-adjustment entry can
    // never be served under a reused key. What's load-bearing for "cheap
    // regeneration" is that the CONTENT crossing to the new path is
    // byte-for-byte the original — `relocateFile`'s own `filesIdentical`
    // verify already enforces this before it ever publishes the copy; this
    // assertion re-confirms it from the caller's side.
    expect(Buffer.compare(afterBytes, beforeBytes)).toBe(0);
  });
});
