/**
 * DeDuplicate worker integration tests. Run against a real Mongo (skip-pass when
 * unreachable, mirroring missing-reaper.test.ts / trash-gc.test.ts).
 *
 * Covers: collapse-to-one with the keeper ranking, file + sidecar relocation
 * into `_duplicates/`, fileinfo `$pull`, cache cleanup of the moved copy's
 * folder, cache-stage re-arm when the anchor moves, live-only gating
 * (tombstoned siblings ignored), missing-file skip, and dry-run.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { MongoClient, ObjectId, type Db } from 'mongodb';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TEST_DB = `maple_test_dedupe_${process.pid}`;
process.env.MAPLE_MONGO_DB = TEST_DB;
const MONGO_URI = process.env.MAPLE_MONGO_URI ?? 'mongodb://localhost:27017';

let mongo: MongoClient | null = null;
let mongoReachable = false;
let db: Db | null = null;
let root: string;
let libraryId: ObjectId;

async function tryConnect(): Promise<MongoClient | null> {
  const c = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 1500, connectTimeoutMS: 1500 });
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
    console.log('[dedupe.test] skipping: MongoDB unreachable');
    return;
  }
  db = mongo!.db(TEST_DB);
  await db.dropDatabase();
  for (const name of ['users', 'credentials', 'invites', 'refresh_tokens', 'challenges']) {
    await db.createCollection(name).catch(() => undefined);
  }
  const { closeDb, ensureIndexes } = await import('../db/client.ts');
  await closeDb();
  await ensureIndexes();
});

beforeEach(async () => {
  if (!mongoReachable) return;
  await db!.collection('assets').deleteMany({});
  await db!.collection('folders').deleteMany({});
  // Fresh on-disk library root per test.
  root = mkdtempSync(join(tmpdir(), 'maple_dedupe_'));
  libraryId = new ObjectId();
  await db!.collection('folders').insertOne({
    _id: libraryId,
    path: root,
    label: 'test',
    last_scan: null,
    file_count: 0,
    created_at: new Date().toISOString(),
  });
  const { invalidateLibraryRoots } = await import('../indexer/libraries.cache.ts');
  invalidateLibraryRoots();
});

afterAll(async () => {
  if (mongo) {
    await mongo.db(TEST_DB).dropDatabase();
    await mongo.close();
  }
  const { closeDb } = await import('../db/client.ts');
  await closeDb();
  if (root) rmSync(root, { recursive: true, force: true });
});

const MAPLE_ID = 'a'.repeat(32);

function stageEntry(version: number) {
  return { version, attempts: 0, last_error: null, processed_at: null, dead: false };
}

/** Write a real file (+ optional xmp) on disk at <root>/<rel dir>/<filename>. */
function writeFile(relDir: string, filename: string, withXmp = true): void {
  const dir = relDir === '' ? root : join(root, relDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, filename), `bytes-${relDir}-${filename}`);
  if (withXmp) writeFileSync(join(dir, filename.replace(/\.[^.]+$/, '.xmp')), '<xmp/>');
}

function fi(relDir: string, filename: string, tags: Partial<{ missing_since: string }> = {}) {
  return { path: relDir, filename, library_id: libraryId, ...tags };
}

async function insertAsset(
  fileinfo: object[],
  stages?: Record<string, unknown>,
): Promise<ObjectId> {
  const id = new ObjectId();
  await db!.collection('assets').insertOne({
    _id: id,
    fileinfo,
    maple_id: MAPLE_ID,
    size: 1,
    mtime: 0,
    rating: 0,
    flag: 0,
    color_label: '',
    indexed_at: '2026-06-01T00:00:00Z',
    deleted_at: null,
    stages: stages ?? {
      exif: stageEntry(1),
      thumb: stageEntry(2),
      preview: stageEntry(1),
    },
  } as never);
  return id;
}

async function getAsset(id: ObjectId) {
  return db!.collection('assets').findOne({ _id: id });
}

const DUP = '_duplicates';

describe('runDeDuplicateOnce', () => {
  it('collapses to one, relocating the unsorted copy + its xmp into _duplicates', async () => {
    if (!mongoReachable) return;
    writeFile('photos/2024', 'IMG.dng');
    writeFile('unsorted', 'IMG.dng');
    const id = await insertAsset([fi('unsorted', 'IMG.dng'), fi('photos/2024', 'IMG.dng')]);

    const { runDeDuplicateOnce } = await import('./dedupe.ts');
    const summary = await runDeDuplicateOnce({});

    expect(summary.deduped).toBe(1);
    expect(summary.movedFiles).toBe(1);

    // The clean copy is kept; the unsorted one is moved away.
    expect(existsSync(join(root, 'photos/2024', 'IMG.dng'))).toBe(true);
    expect(existsSync(join(root, 'unsorted', 'IMG.dng'))).toBe(false);
    expect(existsSync(join(root, DUP, 'unsorted', 'IMG.dng'))).toBe(true);
    // The sidecar travelled with it.
    expect(existsSync(join(root, DUP, 'unsorted', 'IMG.xmp'))).toBe(true);

    const asset = await getAsset(id);
    expect(asset!.fileinfo).toHaveLength(1);
    expect(asset!.fileinfo[0].path).toBe('photos/2024');
  });

  it('rule 4 — keeps the LAST copy when no signals distinguish them', async () => {
    if (!mongoReachable) return;
    writeFile('a', 'IMG.dng');
    writeFile('b', 'IMG.dng');
    const id = await insertAsset([fi('a', 'IMG.dng'), fi('b', 'IMG.dng')]);

    const { runDeDuplicateOnce } = await import('./dedupe.ts');
    await runDeDuplicateOnce({});

    const asset = await getAsset(id);
    expect(asset!.fileinfo).toHaveLength(1);
    expect(asset!.fileinfo[0].path).toBe('b'); // last kept
    expect(existsSync(join(root, DUP, 'a', 'IMG.dng'))).toBe(true);
  });

  it('re-arms thumb + preview when the cache anchor (fileinfo[0]) is moved away', async () => {
    if (!mongoReachable) return;
    writeFile('a', 'IMG.dng'); // index 0 = current anchor, will be moved
    writeFile('b', 'IMG.dng'); // keeper (rule 4)
    // Anchor folder has the maple_id-keyed cache; keeper folder does not.
    mkdirSync(join(root, 'a', '.maple', 'thumbs'), { recursive: true });
    writeFileSync(join(root, 'a', '.maple', 'thumbs', `${MAPLE_ID}.jpg`), 'jpg');
    const id = await insertAsset([fi('a', 'IMG.dng'), fi('b', 'IMG.dng')]);

    const { runDeDuplicateOnce } = await import('./dedupe.ts');
    await runDeDuplicateOnce({});

    const asset = await getAsset(id);
    // Cache stages reset so the kept copy regenerates at folder b.
    expect(asset!.stages.thumb.version).toBe(0);
    expect(asset!.stages.preview.version).toBe(0);
    expect(asset!.stages.exif.version).toBe(1); // untouched — content-keyed
    // The orphaned cache in the moved-from folder was cleaned.
    expect(existsSync(join(root, 'a', '.maple', 'thumbs', `${MAPLE_ID}.jpg`))).toBe(false);
  });

  it('ignores a tombstoned sibling — a single live entry is not a duplicate set', async () => {
    if (!mongoReachable) return;
    writeFile('live', 'IMG.dng');
    const id = await insertAsset([
      fi('live', 'IMG.dng'),
      fi('gone', 'IMG.dng', { missing_since: '2026-01-01T00:00:00Z' }),
    ]);

    const { runDeDuplicateOnce } = await import('./dedupe.ts');
    const summary = await runDeDuplicateOnce({});

    expect(summary.deduped).toBe(0);
    const asset = await getAsset(id);
    expect(asset!.fileinfo).toHaveLength(2); // untouched
  });

  // The move-in-progress race: discover recorded a new path before its `removed`
  // handler tombstoned the old one, so the asset has two "live" entries but only
  // ONE physical file. Nothing must be relocated — that would leave zero files
  // on disk. Covered for the stale entry being either first or second in the list.
  it('does not move anything when only one copy is actually on disk (stale entry first)', async () => {
    if (!mongoReachable) return;
    // 'ghost' has no file (stale); only 'keep' exists on disk.
    writeFile('keep', 'IMG.dng');
    const id = await insertAsset([fi('ghost', 'IMG.dng'), fi('keep', 'IMG.dng')]);

    const { runDeDuplicateOnce } = await import('./dedupe.ts');
    const summary = await runDeDuplicateOnce({});

    expect(summary.movedFiles).toBe(0);
    expect(summary.deduped).toBe(0);
    expect(summary.skippedMissingFile).toBe(1);
    // The single real file stayed put; nothing was quarantined.
    expect(existsSync(join(root, 'keep', 'IMG.dng'))).toBe(true);
    expect(existsSync(join(root, DUP, 'keep', 'IMG.dng'))).toBe(false);
    const asset = await getAsset(id);
    expect(asset!.fileinfo).toHaveLength(2); // nothing pulled
  });

  it('does not move anything when only one copy is actually on disk (stale entry last)', async () => {
    if (!mongoReachable) return;
    // Only 'a' exists; 'b' is the stale entry. Even though rule 4 would prefer
    // 'b' as keeper, it is not on disk so it is never chosen, and 'a' (the only
    // real file) is never moved.
    writeFile('a', 'IMG.dng');
    const id = await insertAsset([fi('a', 'IMG.dng'), fi('b', 'IMG.dng')]);

    const { runDeDuplicateOnce } = await import('./dedupe.ts');
    const summary = await runDeDuplicateOnce({});

    expect(summary.movedFiles).toBe(0);
    expect(summary.deduped).toBe(0);
    expect(summary.skippedMissingFile).toBe(1);
    expect(existsSync(join(root, 'a', 'IMG.dng'))).toBe(true); // only real copy untouched
    expect(existsSync(join(root, DUP, 'a', 'IMG.dng'))).toBe(false);
    const asset = await getAsset(id);
    expect(asset!.fileinfo).toHaveLength(2);
  });

  it('dry-run reports the work but mutates nothing', async () => {
    if (!mongoReachable) return;
    writeFile('a', 'IMG.dng');
    writeFile('b', 'IMG.dng');
    const id = await insertAsset([fi('a', 'IMG.dng'), fi('b', 'IMG.dng')]);

    const { runDeDuplicateOnce } = await import('./dedupe.ts');
    const summary = await runDeDuplicateOnce({ dryRun: true });

    expect(summary.dryRun).toBe(1);
    expect(summary.movedFiles).toBe(0);
    expect(existsSync(join(root, 'a', 'IMG.dng'))).toBe(true); // not moved
    const asset = await getAsset(id);
    expect(asset!.fileinfo).toHaveLength(2); // not pulled
  });
});
