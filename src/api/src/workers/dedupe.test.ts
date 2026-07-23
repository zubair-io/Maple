/**
 * DeDuplicate worker integration tests. Run against a real Mongo (skip-pass when
 * unreachable, mirroring missing-reaper.test.ts / trash-gc.test.ts).
 *
 * Covers: collapse-to-one with the keeper ranking, file + sidecar relocation
 * into `_duplicates/`, fileinfo `$pull`, cache cleanup of the moved copy's
 * folder, cache-stage re-arm when the anchor moves, live-only gating
 * (tombstoned siblings ignored), missing-file skip, and dry-run.
 *
 * #1290: also covers live-aware candidate query — assets with one live + one
 * tombstoned (`missing_since` / `deleted_at`) entry must NOT be returned by the
 * worker's candidate prefilter (`liveAwareDuplicatePredicate`) and must NOT be
 * counted in the deduplicate ready/pending total (covered in routes.test.ts).
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

function fi(
  relDir: string,
  filename: string,
  tags: Partial<{ missing_since: string; keep: boolean }> = {},
) {
  return { path: relDir, filename, library_id: libraryId, ...tags };
}

/** Drop a `.keep` marker file into <root>/<rel dir>. */
function writeKeep(relDir: string): void {
  const dir = relDir === '' ? root : join(root, relDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '.keep'), '');
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
    // Both the current AVIF thumb and a legacy JPEG left over from before the
    // thumb stage's v3 format migration should be swept.
    mkdirSync(join(root, 'a', '.maple', 'thumbs'), { recursive: true });
    writeFileSync(join(root, 'a', '.maple', 'thumbs', `${MAPLE_ID}.avif`), 'avif');
    writeFileSync(join(root, 'a', '.maple', 'thumbs', `${MAPLE_ID}.jpg`), 'jpg');
    const id = await insertAsset([fi('a', 'IMG.dng'), fi('b', 'IMG.dng')]);

    const { runDeDuplicateOnce } = await import('./dedupe.ts');
    await runDeDuplicateOnce({});

    const asset = await getAsset(id);
    // Cache stages reset so the kept copy regenerates at folder b.
    expect(asset!.stages.thumb.version).toBe(0);
    expect(asset!.stages.preview.version).toBe(0);
    expect(asset!.stages.exif.version).toBe(1); // untouched — content-keyed
    // The orphaned cache in the moved-from folder was cleaned — both extensions.
    expect(existsSync(join(root, 'a', '.maple', 'thumbs', `${MAPLE_ID}.avif`))).toBe(false);
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
    // Verify that the absent entry was tagged missing_since so reaper can prune it.
    const ghost = asset!.fileinfo.find((e: any) => e.path === 'ghost');
    expect(ghost.missing_since).toBeTypeOf('string');
    // Structured provenance for the tag (#2171).
    expect(ghost.missing_reason).toBe('dedupe-absent');
  });

  it('does NOT tag absent entries when the library root is empty (unmounted mountpoint) — #2171', async () => {
    if (!mongoReachable) return;
    // Both copies stat ENOENT because the ROOT is an empty dir (unmounted
    // mount look-alike) — that is evidence about the root, not the files.
    // The asset must be skipped untouched, not mass-tagged missing.
    const id = await insertAsset([fi('a', 'IMG.dng'), fi('b', 'IMG.dng')]);

    const { runDeDuplicateOnce } = await import('./dedupe.ts');
    const summary = await runDeDuplicateOnce({});

    expect(summary.movedFiles).toBe(0);
    expect(summary.skippedOffline).toBe(1);
    const asset = await getAsset(id);
    for (const e of asset!.fileinfo as Array<{ missing_since?: string }>) {
      expect(e.missing_since ?? null).toBeNull();
    }
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
    // Verify that the absent entry was tagged missing_since so reaper can prune it.
    const b = asset!.fileinfo.find((e: any) => e.path === 'b');
    expect(b.missing_since).toBeTypeOf('string');
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

  // --- #1290: live-aware candidate prefilter ---
  // The worker's candidate query must use liveAwareDuplicatePredicate so that
  // assets with only one live entry (the other tombstoned) are not fetched at
  // all, avoiding wasted scan budget and stale-row starvation.

  it('#1290: asset with 1 live + 1 missing_since sibling is NOT fetched by the candidate query (scanned=0)', async () => {
    if (!mongoReachable) return;
    writeFile('live', 'IMG.dng');
    // Insert asset where the second entry is tombstoned via missing_since —
    // the coarse predicate `fileinfo.1 exists` would match this, but the
    // live-aware predicate must exclude it.
    await insertAsset([
      fi('live', 'IMG.dng'),
      fi('gone', 'IMG.dng', { missing_since: '2026-01-01T00:00:00Z' }),
    ]);

    const { runDeDuplicateOnce } = await import('./dedupe.ts');
    const summary = await runDeDuplicateOnce({});

    // With the live-aware prefilter, the asset is not fetched at all.
    expect(summary.scanned).toBe(0);
    expect(summary.deduped).toBe(0);
  });

  it('#1290: asset with 1 live + 1 deleted_at sibling is NOT fetched by the candidate query (scanned=0)', async () => {
    if (!mongoReachable) return;
    writeFile('live', 'IMG.dng');
    // Insert asset where the second entry is tombstoned via deleted_at.
    await insertAsset([
      fi('live', 'IMG.dng'),
      {
        path: 'replaced',
        filename: 'IMG.dng',
        library_id: libraryId,
        deleted_at: '2026-01-01T00:00:00Z',
      },
    ]);

    const { runDeDuplicateOnce } = await import('./dedupe.ts');
    const summary = await runDeDuplicateOnce({});

    // With the live-aware prefilter, the asset is not fetched at all.
    expect(summary.scanned).toBe(0);
    expect(summary.deduped).toBe(0);
  });

  it('#1290: asset with >=2 live entries IS fetched and processed by the candidate query', async () => {
    if (!mongoReachable) return;
    writeFile('a', 'IMG.dng');
    writeFile('b', 'IMG.dng');
    // Both entries are live (no tags) — should be fetched and deduped.
    const id = await insertAsset([fi('a', 'IMG.dng'), fi('b', 'IMG.dng')]);

    const { runDeDuplicateOnce } = await import('./dedupe.ts');
    const summary = await runDeDuplicateOnce({});

    expect(summary.scanned).toBe(1);
    expect(summary.deduped).toBe(1);
    const asset = await getAsset(id);
    expect(asset!.fileinfo).toHaveLength(1);
  });

  // --- `.keep` marker: pin copies in a folder against collapse ---

  it('keeps the copy in a `.keep` folder and moves the un-pinned one', async () => {
    if (!mongoReachable) return;
    // 'photos/2024' would normally be the keeper (rule 4 / clean), but the
    // operator pinned the 'extra' copy with a `.keep` marker — so 'extra' must
    // survive and the un-pinned 'photos/2024' copy is the one moved away.
    writeFile('photos/2024', 'IMG.dng');
    writeFile('extra', 'IMG.dng');
    writeKeep('extra');
    const id = await insertAsset([fi('photos/2024', 'IMG.dng'), fi('extra', 'IMG.dng')]);

    const { runDeDuplicateOnce } = await import('./dedupe.ts');
    const summary = await runDeDuplicateOnce({});

    expect(summary.deduped).toBe(1);
    expect(summary.movedFiles).toBe(1);
    // The pinned copy stays; the un-pinned one is quarantined.
    expect(existsSync(join(root, 'extra', 'IMG.dng'))).toBe(true);
    expect(existsSync(join(root, 'photos/2024', 'IMG.dng'))).toBe(false);
    expect(existsSync(join(root, DUP, 'photos/2024', 'IMG.dng'))).toBe(true);

    const asset = await getAsset(id);
    expect(asset!.fileinfo).toHaveLength(1);
    expect(asset!.fileinfo[0].path).toBe('extra');
  });

  it('keeps EVERY pinned copy when more than one folder is marked `.keep`', async () => {
    if (!mongoReachable) return;
    // Two pinned folders + one un-pinned copy: both pinned copies survive, only
    // the un-pinned one is moved.
    writeFile('keepA', 'IMG.dng');
    writeFile('keepB', 'IMG.dng');
    writeFile('loose', 'IMG.dng');
    writeKeep('keepA');
    writeKeep('keepB');
    const id = await insertAsset([
      fi('keepA', 'IMG.dng'),
      fi('keepB', 'IMG.dng'),
      fi('loose', 'IMG.dng'),
    ]);

    const { runDeDuplicateOnce } = await import('./dedupe.ts');
    const summary = await runDeDuplicateOnce({});

    expect(summary.deduped).toBe(1);
    expect(summary.movedFiles).toBe(1);
    expect(existsSync(join(root, 'keepA', 'IMG.dng'))).toBe(true);
    expect(existsSync(join(root, 'keepB', 'IMG.dng'))).toBe(true);
    expect(existsSync(join(root, 'loose', 'IMG.dng'))).toBe(false);
    expect(existsSync(join(root, DUP, 'loose', 'IMG.dng'))).toBe(true);

    const asset = await getAsset(id);
    const paths = (asset!.fileinfo as any[]).map((e) => e.path).sort();
    expect(paths).toEqual(['keepA', 'keepB']);
  });

  it('leaves the asset untouched when every on-disk copy is pinned `.keep`', async () => {
    if (!mongoReachable) return;
    writeFile('keepA', 'IMG.dng');
    writeFile('keepB', 'IMG.dng');
    writeKeep('keepA');
    writeKeep('keepB');
    const id = await insertAsset([fi('keepA', 'IMG.dng'), fi('keepB', 'IMG.dng')]);

    const { runDeDuplicateOnce } = await import('./dedupe.ts');
    const summary = await runDeDuplicateOnce({});

    expect(summary.deduped).toBe(0);
    expect(summary.movedFiles).toBe(0);
    expect(summary.skippedAllKept).toBe(1);
    // Both copies remain on disk and in the row.
    expect(existsSync(join(root, 'keepA', 'IMG.dng'))).toBe(true);
    expect(existsSync(join(root, 'keepB', 'IMG.dng'))).toBe(true);
    const asset = await getAsset(id);
    expect(asset!.fileinfo).toHaveLength(2);
  });

  it('re-confirms `.keep` on disk — a stale stored keep flag does not block collapse', async () => {
    if (!mongoReachable) return;
    // The stored flag claims 'a' is kept, but there is no `.keep` file on disk
    // (the marker was removed after indexing). The worker trusts disk and
    // collapses normally — keeping the last copy per rule 4.
    writeFile('a', 'IMG.dng');
    writeFile('b', 'IMG.dng');
    const id = await insertAsset([fi('a', 'IMG.dng', { keep: true }), fi('b', 'IMG.dng')]);

    const { runDeDuplicateOnce } = await import('./dedupe.ts');
    const summary = await runDeDuplicateOnce({});

    expect(summary.deduped).toBe(1);
    expect(summary.movedFiles).toBe(1);
    const asset = await getAsset(id);
    expect(asset!.fileinfo).toHaveLength(1);
    expect(asset!.fileinfo[0].path).toBe('b'); // rule 4 last-kept, marker ignored
  });

  it('#1290: absent+untagged entry (present+absent pair) is still fetched — tag-then-skip drain path preserved', async () => {
    if (!mongoReachable) return;
    // 'keep' exists on disk; 'ghost' does not (absent but NOT yet tagged).
    // Both are "live" by isLiveFileInfo (no missing_since / deleted_at).
    // The live-aware prefilter must still fetch this asset so processAsset
    // can stat the files, discover 'ghost' is absent, tag it, and return early.
    writeFile('keep', 'IMG.dng');
    const id = await insertAsset([fi('keep', 'IMG.dng'), fi('ghost', 'IMG.dng')]);

    const { runDeDuplicateOnce } = await import('./dedupe.ts');
    const summary = await runDeDuplicateOnce({});

    // Fetched (scanned), NOT deduped (only 1 on disk), absent entry tagged.
    expect(summary.scanned).toBe(1);
    expect(summary.deduped).toBe(0);
    expect(summary.skippedMissingFile).toBe(1);
    const asset = await getAsset(id);
    const ghost = (asset!.fileinfo as any[]).find((e: any) => e.path === 'ghost');
    expect(ghost.missing_since).toBeTypeOf('string');
  });
});
