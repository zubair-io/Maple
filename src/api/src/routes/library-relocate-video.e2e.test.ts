/**
 * End-to-end video-relocation tests for POST /api/library/relocate (and
 * relocate-count) — #1678.
 *
 * Split out of `library-relocate.e2e.test.ts` (file-size budget) — same harness
 * (a temp library on disk plus a real asset in an in-memory SQLite database,
 * driven through the mounted route handler), scoped to the M5 full-name video
 * sidecar convention (`clip.mov` → `clip.mov.xmp`, NOT the image stem-swap
 * `clip.xmp`). Asserts the video + its full-name sidecar both relocate
 * crash-safely, and that a video's relocation never touches a same-stem photo's
 * own sidecar (the Live Photo pairing invariant `xmpSidecarPath` exists to
 * protect).
 *
 * Nothing skips (#3787).
 */

import { describe, it, expect, afterEach } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createLiveTestDatabase } from '../db/sqlite/test-sqlite.test-helpers.ts';
import { conflictCopyPath } from '../fs/xmp-conflict.ts';
import {
  SLUG,
  clearLibraryCache,
  locationOf,
  postCount,
  postRelocate,
  seedRelocatableAsset,
  usPlaceText,
} from './library-relocate.test-helpers.ts';

interface RelocateResult {
  ok: boolean;
  outcome?: string;
  renamed?: boolean;
}

async function resultsOf(res: Response): Promise<RelocateResult[]> {
  return ((await res.json()) as { results: RelocateResult[] }).results;
}

describe('library-relocate end-to-end — video sidecars (#1678)', () => {
  let dir: string | null = null;

  afterEach(async () => {
    if (dir) await fs.rm(dir, { recursive: true, force: true });
    dir = null;
    clearLibraryCache();
  });

  it('relocates a video + its full-name .mov.xmp sidecar, repoints the row, removes the source', async () => {
    using live = await createLiveTestDatabase();
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'relocate-video-'));

    const oldRel = '2024/Loose';
    await fs.mkdir(path.join(dir, ...oldRel.split('/')), { recursive: true });
    await fs.writeFile(path.join(dir, oldRel, 'CLIP.mov'), 'frames');
    // M5 full-name sidecar convention: `clip.mov.xmp`, NOT stem-swapped `clip.xmp`.
    await fs.writeFile(path.join(dir, oldRel, 'CLIP.mov.xmp'), 'video-edits');

    const asset = seedRelocatableAsset(live.db, {
      root: dir,
      relPath: oldRel,
      filename: 'CLIP.mov',
      mapleId: 'relocate-video-id',
      metadataOverride: usPlaceText(),
    });

    // relocate-count includes videos.
    const countRes = await postCount([`${SLUG}:${oldRel}/CLIP.mov`]);
    expect(countRes.status).toBe(200);
    expect(((await countRes.json()) as { count: number }).count).toBe(1);

    const res = await postRelocate([`${SLUG}:${oldRel}/CLIP.mov`]);
    expect(res.status).toBe(200);
    const results = await resultsOf(res);
    expect(results).toHaveLength(1);
    expect(results[0]!.ok).toBe(true);
    expect(results[0]!.outcome).toBe('moved');
    expect(results[0]!.renamed).toBe(false);

    const newRel = '2024/California/Berkeley';
    // File + full-name sidecar both landed at the new dir with identical bytes.
    expect(await fs.readFile(path.join(dir, newRel, 'CLIP.mov'), 'utf8')).toBe('frames');
    expect(await fs.readFile(path.join(dir, newRel, 'CLIP.mov.xmp'), 'utf8')).toBe('video-edits');
    // Sources gone — neither the clip nor its sidecar is stranded.
    await expect(fs.stat(path.join(dir, oldRel, 'CLIP.mov'))).rejects.toThrow();
    await expect(fs.stat(path.join(dir, oldRel, 'CLIP.mov.xmp'))).rejects.toThrow();

    expect(locationOf(live.db, asset.assetId)).toMatchObject({
      path: newRel,
      filename: 'CLIP.mov',
    });
  });

  it('relocating a video does not touch a same-stem photo sidecar (Live Photo pairing safety)', async () => {
    using live = await createLiveTestDatabase();
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'relocate-video-pair-'));

    const oldRel = '2024/Loose';
    await fs.mkdir(path.join(dir, ...oldRel.split('/')), { recursive: true });
    // Live Photo pairing: same stem, two independent assets, two independent
    // sidecars (`IMG_1.xmp` for the still, `IMG_1.MOV.xmp` for the motion clip).
    await fs.writeFile(path.join(dir, oldRel, 'IMG_1.HEIC'), 'still-pixels');
    await fs.writeFile(path.join(dir, oldRel, 'IMG_1.xmp'), 'still-edits');
    await fs.writeFile(path.join(dir, oldRel, 'IMG_1.MOV'), 'clip-frames');
    await fs.writeFile(path.join(dir, oldRel, 'IMG_1.MOV.xmp'), 'clip-edits');

    seedRelocatableAsset(live.db, {
      root: dir,
      relPath: oldRel,
      filename: 'IMG_1.MOV',
      mapleId: 'relocate-video-pair-id',
      metadataOverride: usPlaceText(),
    });

    const res = await postRelocate([`${SLUG}:${oldRel}/IMG_1.MOV`]);
    expect(res.status).toBe(200);
    const results = await resultsOf(res);
    expect(results[0]!.ok).toBe(true);
    expect(results[0]!.outcome).toBe('moved');

    const newRel = '2024/California/Berkeley';
    // The clip + its own full-name sidecar moved.
    expect(await fs.readFile(path.join(dir, newRel, 'IMG_1.MOV'), 'utf8')).toBe('clip-frames');
    expect(await fs.readFile(path.join(dir, newRel, 'IMG_1.MOV.xmp'), 'utf8')).toBe('clip-edits');
    // The still photo and ITS sidecar were never touched — still at the old dir.
    expect(await fs.readFile(path.join(dir, oldRel, 'IMG_1.HEIC'), 'utf8')).toBe('still-pixels');
    expect(await fs.readFile(path.join(dir, oldRel, 'IMG_1.xmp'), 'utf8')).toBe('still-edits');
  });

  it('round-trips a video conflict-copy sidecar through write → relocate (#2481)', async () => {
    using live = await createLiveTestDatabase();
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'relocate-video-conflict-'));

    const oldRel = '2024/Loose';
    await fs.mkdir(path.join(dir, ...oldRel.split('/')), { recursive: true });
    const movAbs = path.join(dir, oldRel, 'CLIP.MOV');
    await fs.writeFile(movAbs, 'frames');
    await fs.writeFile(path.join(dir, oldRel, 'CLIP.MOV.xmp'), 'canonical-edits');
    // Write via the real conflictCopyPath — proves the writer and the relocate
    // matcher (listPairedSidecars) agree on the video's full-name base.
    const conflictAbs = conflictCopyPath(movAbs, 'MacBook');
    await fs.writeFile(conflictAbs, 'conflict-edits');

    seedRelocatableAsset(live.db, {
      root: dir,
      relPath: oldRel,
      filename: 'CLIP.MOV',
      mapleId: 'relocate-video-conflict-id',
      metadataOverride: usPlaceText(),
    });

    const res = await postRelocate([`${SLUG}:${oldRel}/CLIP.MOV`]);
    expect(res.status).toBe(200);
    const results = await resultsOf(res);
    expect(results[0]!.ok).toBe(true);
    expect(results[0]!.outcome).toBe('moved');

    const newRel = '2024/California/Berkeley';
    const newConflictPath = path.join(dir, newRel, 'CLIP.MOV (conflict from MacBook).xmp');
    expect(await fs.readFile(newConflictPath, 'utf8')).toBe('conflict-edits');
    // Source conflict copy gone — not stranded in the old folder.
    await expect(fs.stat(conflictAbs)).rejects.toThrow();
  });
});
