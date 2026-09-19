/**
 * Cross-surface cache-invalidation-on-move verification (#2659) — the ticket
 * that closes the File Management epic's last unproven claim: every relocate
 * implementation asserts (in comments and in docs/caching.md) that cache keys
 * are path-derived, so a move must NOT relocate cache files — it bumps the
 * thumb/preview stage-version and lets the workers regenerate at the new
 * path. This proves that end to end on the API surface: real files, and one
 * real SQLite database per test (#3787) installed as the process-wide handle.
 *
 * Deliberately its OWN suite, not an extension of the #2633
 * `relocate.parity.test.ts` corpus. That corpus's model is a pure
 * before/after FILE-TREE comparison (`readTree` walks every regular file and
 * diffs it against `expected.tree`) replayed against three independent
 * per-platform primitives from ONE declarative JSON case. Cache invalidation
 * is fundamentally stateful in ways that model doesn't express: it needs
 * DB-side stage-version bookkeeping (API-only — Apple and Windows have no
 * equivalent rows to assert against) and a worker HANDLER re-run, not just
 * the `relocateFile` primitive. Contorting the corpus schema to cover this
 * would either bloat it with fields only one of three runners can act on, or
 * lose the sharp file-tree diff the corpus is good at. A focused suite here,
 * and the Apple/Windows counterparts described in the PR, prove the SAME
 * claim without forcing one shared shape onto three architecturally different
 * cache designs.
 *
 * Two collaborators are deliberately not called here: the thumb stage's own
 * handler (`workers/stages/thumb.ts`, for its `cf-thumb-sync` cascade) and the
 * orphan sweep (`workers/cache-gc.ts`). Where the handler would have been
 * re-run, this calls the same `assetAbsPath` + `resolveThumbPathForAsset` +
 * `generateThumb` trio it is built from, which is the part that proves the
 * path-keyed cache regenerates; the sweep's own reclamation stays covered by
 * `workers/cache-gc.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { ObjectId } from 'mongodb';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { maple } from 'maple';
import { solidJpeg } from '../test-support/synth-image.ts';
import {
  createLiveTestDatabase,
  insertAsset,
  insertFolder,
  insertLocation,
  run,
} from '../db/sqlite/test-sqlite.test-helpers.ts';
import { insertStageState } from '../db/sqlite/repos/assets.test-helpers.ts';
import { loadAssetLocationView } from '../db/sqlite/repos/assets.locations.repo.ts';
import { claimStageBatch } from '../db/sqlite/repos/stage-claim.ts';
import { setLibraryRootsForTests } from '../indexer/libraries.cache.ts';
import { assetAbsPath } from '../indexer/images.repo.ts';
import { generateThumb } from '../indexer/thumbnailer.ts';
import { resolveThumbPathForAsset } from '../fs/xmp.ts';
import { relocateAsset } from './relocate-asset.ts';
import { restoreAssetById, trashAssetById } from './asset-trash.ts';

/** What the dirty stage fixture stamps, so "unchanged" is checkable. */
const PROCESSED_AT = '2026-01-01T00:00:00.000Z';

/** The genuinely expensive per-image stages (describe = VLM caption/OCR,
 * face-detect/face-embed = ML inference, geocode = reverse-geocode lookup).
 * The ticket's subtle criterion is the CONTRAST between these and the cheap
 * raster caches: a move must bump thumb/preview so they regenerate, and must
 * NOT force these to redo multi-second inference work that a mere path change
 * can't have invalidated. */
const EXPENSIVE_STAGES = ['describe', 'face-detect', 'face-embed', 'geocode'] as const;

/** Every other stage an asset carries, so the fixture is a whole asset rather
 * than the handful of rows a given assertion reads. */
const OTHER_STAGES = ['meili', 'sidecar-metadata-index', 'cf-thumb-sync', 'transcribe'] as const;

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'cache-invalidation-move-'));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
  setLibraryRootsForTests(null);
});

/** A tiny real JPEG — routes `generateThumb` through the imgdecode bitmap
 * branch, which needs no libraw_ffi build, so this suite runs anywhere `bun
 * test` runs (unlike the RAW-fixture-gated tests elsewhere). */
async function writeJpeg(absPath: string): Promise<void> {
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  await fs.writeFile(absPath, await solidJpeg(400, 300, [20, 120, 200]));
}

/** Every per-image stage this asset carries, pre-relocate, all dirty
 * (non-zero versions, a processed_at, an attempt) so a test can tell "reset"
 * apart from "already zero". */
function seedDirtyStages(db: Database, assetId: string): void {
  const dirty = { version: 3, attempts: 2, processedAt: PROCESSED_AT };
  insertStageState(db, assetId, 'exif', { ...dirty, version: 1 });
  for (const name of ['thumb', 'preview', ...EXPENSIVE_STAGES, ...OTHER_STAGES]) {
    insertStageState(db, assetId, name, dirty);
  }
}

/** One asset located at `relPath`/`filename` under the temp `root`, with a
 * real `folders` row for the library — `trashAssetById`/`restoreAssetById`
 * resolve the library root through it, the relocate path through the
 * in-memory roots cache. */
function seedAsset(
  db: Database,
  relPath: string,
  filename: string,
): { id: ObjectId; libs: ReadonlyMap<string, string> } {
  const libraryId = insertFolder(db, { path: root, slug: 'cache-invalidation-move' });
  const id = insertAsset(db);
  insertLocation(db, { assetId: id, libraryId, path: relPath, filename });
  seedDirtyStages(db, id);
  const libs = new Map([[libraryId, root]]);
  setLibraryRootsForTests(libs);
  return { id: new ObjectId(id), libs };
}

interface StageRow {
  version: number;
  attempts: number;
  processed_at: string | null;
}

function stage(db: Database, id: ObjectId, name: string): StageRow {
  return db
    .query(
      `SELECT version, attempts, processed_at FROM stage_state
        WHERE asset_id = ? AND stage = ?`,
    )
    .get(id.toHexString(), name) as StageRow;
}

function locationPath(db: Database, id: ObjectId): string {
  return (
    db
      .query(`SELECT path FROM asset_locations WHERE asset_id = ? ORDER BY ordinal`)
      .get(id.toHexString()) as { path: string }
  ).path;
}

/** The two paths the thumb stage's handler resolves before it renders: the
 * source file, and the path-keyed cache slot that source maps to. */
async function thumbPaths(
  id: ObjectId,
  libs: ReadonlyMap<string, string>,
): Promise<{ absPath: string; thumbPath: string }> {
  const view = await loadAssetLocationView(id);
  expect(view).not.toBeNull();
  const absPath = assetAbsPath(view as never, libs);
  const thumbPath = resolveThumbPathForAsset(view as never, libs);
  expect(absPath).not.toBeNull();
  expect(thumbPath).not.toBeNull();
  return { absPath: absPath as string, thumbPath: thumbPath as string };
}

/** Render the thumbnail the way the stage's handler does — the same pair of
 * resolved paths, the same renderer. */
async function renderThumb(id: ObjectId, libs: ReadonlyMap<string, string>): Promise<string> {
  const { absPath, thumbPath } = await thumbPaths(id, libs);
  await generateThumb(absPath, thumbPath);
  return thumbPath;
}

/** Every expensive stage is still exactly where the fixture left it. */
function expectExpensiveStagesUntouched(db: Database, id: ObjectId): void {
  for (const name of EXPENSIVE_STAGES) {
    const row = stage(db, id, name);
    expect(row.version).toBe(3);
    expect(row.processed_at).toBe(PROCESSED_AT);
  }
}

describe('cache invalidation on move (#2659)', () => {
  test('criterion 3 — a move resets ONLY the cheap raster-cache stages (thumb/preview); the expensive VLM/ML stages (describe/face-detect/face-embed/geocode) are left alone', async () => {
    using live = await createLiveTestDatabase();
    await writeJpeg(path.join(root, 'a', 'IMG_1.jpg'));
    const { id } = seedAsset(live.db, 'a', 'IMG_1.jpg');
    // Sanity: every stage really did start dirty, or "left alone" below would
    // trivially pass by never having anything to disturb.
    expectExpensiveStagesUntouched(live.db, id);

    const result = await relocateAsset({
      id,
      mode: 'move',
      collision: 'auto-suffix',
      destinationPath: 'b',
    });
    expect(result.kind).toBe('relocated');

    // The cheap tier — path-keyed raster caches — is bumped back to
    // unprocessed so the workers regenerate at the new path.
    expect(stage(live.db, id, 'thumb').version).toBe(0);
    expect(stage(live.db, id, 'preview').version).toBe(0);
    // The expensive tier is untouched: the pixels didn't change, so a VLM
    // caption, a face embedding and a reverse-geocode lookup computed before
    // the move are still valid after it. Re-running them on every
    // rename/move in a library would turn an O(1) filesystem op into an
    // O(inference) one — exactly the "expensive full re-decode" the ticket's
    // third criterion rules out.
    expectExpensiveStagesUntouched(live.db, id);
  });

  test('criterion 1 — the new path serves a correct thumbnail after re-rendering only that one asset, no full rescan', async () => {
    using live = await createLiveTestDatabase();
    await writeJpeg(path.join(root, 'a', 'IMG_1.jpg'));
    const { id, libs } = seedAsset(live.db, 'a', 'IMG_1.jpg');

    // Populate the OLD location's thumb, as a real cold-open would have.
    const oldThumbPath = await renderThumb(id, libs);
    expect((await fs.stat(oldThumbPath)).size).toBeGreaterThan(0);

    const relocateResult = await relocateAsset({
      id,
      mode: 'move',
      collision: 'auto-suffix',
      destinationPath: 'b',
    });
    expect(relocateResult.kind).toBe('relocated');

    // Re-render ONLY this one asset — the same unit of work the version-reset
    // arms in production, never a folder-wide discover/rescan. That alone
    // must be sufficient to produce a correct thumbnail at the new path.
    const { thumbPath: newThumbPath } = await thumbPaths(id, libs);
    expect(newThumbPath).not.toBe(oldThumbPath);
    await renderThumb(id, libs);
    expect((await fs.stat(newThumbPath)).size).toBeGreaterThan(0);
    // The regenerated thumb decodes as a real image (not a truncated/corrupt
    // write) — `finalizeAvifRender`'s validation gate already enforces this
    // at write time, this re-confirms it end to end.
    const meta = await maple(newThumbPath).metadata();
    expect(meta.width).toBeGreaterThan(0);
    expect(meta.height).toBeGreaterThan(0);
  });

  test('criterion 2 — the old thumbnail is not served for the new path, and is left behind as an orphan rather than relocated', async () => {
    using live = await createLiveTestDatabase();
    await writeJpeg(path.join(root, 'a', 'IMG_1.jpg'));
    const { id, libs } = seedAsset(live.db, 'a', 'IMG_1.jpg');

    const oldThumbPath = await renderThumb(id, libs);
    await fs.stat(oldThumbPath); // exists

    await relocateAsset({ id, mode: 'move', collision: 'auto-suffix', destinationPath: 'b' });

    // Not served: a reader resolving the NEW path's thumb never lands on the
    // OLD file — the two are different filesystem paths by construction
    // (path-keyed hash), never the same cache slot repointed.
    const { thumbPath: newThumbPath } = await thumbPaths(id, libs);
    expect(newThumbPath).not.toBe(oldThumbPath);
    await expect(fs.stat(newThumbPath)).rejects.toThrow(); // nothing was moved here
    await renderThumb(id, libs);
    expect((await fs.stat(newThumbPath)).size).toBeGreaterThan(0);

    // The move itself neither relocates nor deletes the orphaned old file —
    // a synchronous per-file delete isn't part of this API's design (see
    // relocate-asset.ts's cache-stage doc comment). Reclaiming it is
    // `cache-gc`'s sweep, which stays covered by `workers/cache-gc.test.ts`.
    expect((await fs.stat(oldThumbPath)).size).toBeGreaterThan(0);
  });

  test('a move relocates byte-identical content, so the eventual re-render re-extracts the SAME bytes rather than reimporting changed ones', async () => {
    using live = await createLiveTestDatabase();
    const oldAbsPath = path.join(root, 'a', 'IMG_1.jpg');
    await writeJpeg(oldAbsPath);
    const beforeBytes = await fs.readFile(oldAbsPath);
    const { id } = seedAsset(live.db, 'a', 'IMG_1.jpg');

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
    // source — that's expected and is in fact what makes `primary_mtime` a
    // correct component of the Apple preview-cache key (docs/caching.md §3):
    // a relocate always changes it, so a stale-adjustment entry can never be
    // served under a reused key. What's load-bearing for "cheap
    // regeneration" is that the CONTENT crossing to the new path is
    // byte-for-byte the original — `relocateFile`'s own `filesIdentical`
    // verify already enforces this before it ever publishes the copy; this
    // assertion re-confirms it from the caller's side.
    expect(Buffer.compare(afterBytes, beforeBytes)).toBe(0);
  });

  // #2847: trash and restore are relocates too (the bytes move into and back
  // out of `.maple/trash/`), so they must carry the same cheap-tier /
  // expensive-tier contract as `relocateAsset` — previously only `meili` was
  // re-armed, and a restored asset's thumb/preview bookkeeping kept claiming
  // "done" for a path the file had left.
  test('trash (#2847) resets ONLY thumb/preview in the same transaction that stamps deleted_at; the expensive stages are left alone', async () => {
    using live = await createLiveTestDatabase();
    await writeJpeg(path.join(root, 'a', 'IMG_1.jpg'));
    const { id } = seedAsset(live.db, 'a', 'IMG_1.jpg');

    const trashed = await trashAssetById(id);
    expect(trashed.kind).toBe('ok');

    expect(locationPath(live.db, id)).toBe('.maple/trash/a');
    expect(stage(live.db, id, 'thumb').version).toBe(0);
    expect(stage(live.db, id, 'preview').version).toBe(0);
    expect(stage(live.db, id, 'thumb').attempts).toBe(0);
    expectExpensiveStagesUntouched(live.db, id);
  });

  test('restore (#2847) resets thumb/preview so the stage re-claims the asset and regenerates the thumb that was reclaimed while it sat in Trash', async () => {
    using live = await createLiveTestDatabase();
    await writeJpeg(path.join(root, 'a', 'IMG_1.jpg'));
    const { id, libs } = seedAsset(live.db, 'a', 'IMG_1.jpg');

    // Live thumb at the original path, as a cold-open would have produced.
    const liveThumbPath = await renderThumb(id, libs);
    await fs.stat(liveThumbPath);

    expect((await trashAssetById(id)).kind).toBe('ok');
    // While trashed, the original-path thumb is an orphan (the row now points
    // into `.maple/trash/`) and cache-gc reclaims it — the state a restore
    // lands in. Removed directly here rather than by running the sweep, which
    // has its own suite.
    await fs.rm(liveThumbPath);
    // Simulate the thumb/preview workers having caught up on the trashed row,
    // so the restore-side reset below is distinguishable from the trash-side
    // one.
    run(
      live.db,
      `UPDATE stage_state SET version = 3 WHERE asset_id = ? AND stage IN ('thumb', 'preview')`,
      id.toHexString(),
    );

    const restored = await restoreAssetById(id);
    expect(restored.kind).toBe('ok');

    expect(locationPath(live.db, id)).toBe('a');
    expect(stage(live.db, id, 'thumb').version).toBe(0);
    expect(stage(live.db, id, 'preview').version).toBe(0);
    expectExpensiveStagesUntouched(live.db, id);

    // The restored row is claimable by the thumb stage again — this is what
    // lets the background worker (not a user-triggered cold open) bring the
    // thumb back, and what keeps the Workers-page completeness counters
    // honest.
    const outcome = await claimStageBatch({
      stage: 'thumb',
      targetVersion: 3,
      dependsOn: [],
      limit: 10,
      maxAttempts: 5,
    });
    expect(outcome.claimed.map((row) => row.asset_id)).toContain(id.toHexString());

    // And re-rendering that one asset regenerates at the restored path.
    const { thumbPath } = await thumbPaths(id, libs);
    expect(thumbPath).toBe(liveThumbPath);
    await renderThumb(id, libs);
    expect((await fs.stat(thumbPath)).size).toBeGreaterThan(0);
  });
});
