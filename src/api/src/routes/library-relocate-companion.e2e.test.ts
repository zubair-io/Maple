/**
 * End-to-end tests for POST /api/library/relocate covering the two behaviors
 * `moveBackupAsset` had that the generic `relocateAsset` primitive didn't,
 * before #2667 generalized the Apple-rendered companion onto it and kept the
 * dedupe short-circuit as a caller-side pre-check (`library/relocate-geo.ts`):
 *
 *   1. The `apple_rendered_path` companion travels alongside the primary +
 *      sidecar, base-swap renamed the same way, and the stored path is
 *      repointed to its new location.
 *   2. A byte-identical, companion-free destination collapses to a dedupe
 *      (repoint + delete source, no copy) — the pre-existing destination
 *      survives with its OWN bytes untouched, and the response still reports
 *      `outcome: 'moved'` (the route's public JSON contract, which
 *      `moveBackupAsset` also reported for a dedupe).
 *
 * Split out of `library-relocate.e2e.test.ts` to keep that file under its
 * file-size budget headroom, the same reason `library-relocate-video.e2e.test.ts`
 * is its own file. Nothing skips (#3787).
 */

import { describe, it, expect, afterEach } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createLiveTestDatabase } from '../db/sqlite/test-sqlite.test-helpers.ts';
import {
  SLUG,
  appleRenderedPathOf,
  clearLibraryCache,
  locationOf,
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

describe('library-relocate end-to-end — companion + dedupe (#2667)', () => {
  let dir: string | null = null;

  afterEach(async () => {
    if (dir) await fs.rm(dir, { recursive: true, force: true });
    dir = null;
    clearLibraryCache();
  });

  it('carries the apple_rendered_path companion alongside the primary + sidecar and repoints it', async () => {
    using live = await createLiveTestDatabase();
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'relocate-companion-'));

    const oldRel = '2024/Loose';
    await fs.mkdir(path.join(dir, ...oldRel.split('/')), { recursive: true });
    await fs.writeFile(path.join(dir, oldRel, 'IMG_5.dng'), 'pixels');
    await fs.writeFile(path.join(dir, oldRel, 'IMG_5.xmp'), 'edits');
    await fs.writeFile(path.join(dir, oldRel, 'IMG_5.jpg'), 'apple-rendered-bytes');

    const asset = seedRelocatableAsset(live.db, {
      root: dir,
      relPath: oldRel,
      filename: 'IMG_5.dng',
      mapleId: 'relocate-companion-id',
      metadataOverride: usPlaceText(),
      appleRenderedPath: `${oldRel}/IMG_5.jpg`,
    });

    const res = await postRelocate([`${SLUG}:${oldRel}/IMG_5.dng`]);
    expect(res.status).toBe(200);
    const results = await resultsOf(res);
    expect(results[0]!.ok).toBe(true);
    expect(results[0]!.outcome).toBe('moved');

    const newRel = '2024/California/Berkeley';
    expect(await fs.readFile(path.join(dir, newRel, 'IMG_5.dng'), 'utf8')).toBe('pixels');
    expect(await fs.readFile(path.join(dir, newRel, 'IMG_5.xmp'), 'utf8')).toBe('edits');
    expect(await fs.readFile(path.join(dir, newRel, 'IMG_5.jpg'), 'utf8')).toBe(
      'apple-rendered-bytes',
    );
    // Sources gone.
    await expect(fs.stat(path.join(dir, oldRel, 'IMG_5.dng'))).rejects.toThrow();
    await expect(fs.stat(path.join(dir, oldRel, 'IMG_5.jpg'))).rejects.toThrow();

    expect(locationOf(live.db, asset.assetId)).toMatchObject({ path: newRel });
    expect(appleRenderedPathOf(live.db, asset.assetId)).toBe(`${newRel}/IMG_5.jpg`);
  });

  it('a byte-identical, companion-free destination dedupes: repoint + delete source, occupant survives', async () => {
    using live = await createLiveTestDatabase();
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'relocate-dedupe-'));

    const oldRel = '2024/Loose';
    const newRel = '2024/California/Berkeley';
    await fs.mkdir(path.join(dir, ...oldRel.split('/')), { recursive: true });
    await fs.mkdir(path.join(dir, ...newRel.split('/')), { recursive: true });
    // Source and the pre-existing occupant are BYTE-IDENTICAL, and the source
    // has no sidecar/companion — the dedupe condition.
    await fs.writeFile(path.join(dir, oldRel, 'IMG_6.dng'), 'identical-pixels');
    await fs.writeFile(path.join(dir, newRel, 'IMG_6.dng'), 'identical-pixels');

    const asset = seedRelocatableAsset(live.db, {
      root: dir,
      relPath: oldRel,
      filename: 'IMG_6.dng',
      mapleId: 'relocate-dedupe-id',
      metadataOverride: usPlaceText(),
    });

    const res = await postRelocate([`${SLUG}:${oldRel}/IMG_6.dng`]);
    expect(res.status).toBe(200);
    const results = await resultsOf(res);
    expect(results[0]!.ok).toBe(true);
    expect(results[0]!.outcome).toBe('moved');
    // No auto-suffix — the destination filename is unchanged, it's a dedupe.
    expect(results[0]!.renamed).toBe(false);

    // Occupant survives, filename NOT suffixed (no second copy created).
    expect(await fs.readFile(path.join(dir, newRel, 'IMG_6.dng'), 'utf8')).toBe('identical-pixels');
    await expect(fs.stat(path.join(dir, newRel, 'IMG_6.1.dng'))).rejects.toThrow();
    // Source gone.
    await expect(fs.stat(path.join(dir, oldRel, 'IMG_6.dng'))).rejects.toThrow();

    expect(locationOf(live.db, asset.assetId)).toMatchObject({
      path: newRel,
      filename: 'IMG_6.dng',
    });
  });

  it('a byte-identical destination but a source carrying a sidecar never dedupes — it renames', async () => {
    using live = await createLiveTestDatabase();
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'relocate-nodedupe-'));

    const oldRel = '2024/Loose';
    const newRel = '2024/California/Berkeley';
    await fs.mkdir(path.join(dir, ...oldRel.split('/')), { recursive: true });
    await fs.mkdir(path.join(dir, ...newRel.split('/')), { recursive: true });
    await fs.writeFile(path.join(dir, oldRel, 'IMG_7.dng'), 'identical-pixels');
    await fs.writeFile(path.join(dir, oldRel, 'IMG_7.xmp'), 'edits-must-not-be-dropped');
    await fs.writeFile(path.join(dir, newRel, 'IMG_7.dng'), 'identical-pixels');

    seedRelocatableAsset(live.db, {
      root: dir,
      relPath: oldRel,
      filename: 'IMG_7.dng',
      mapleId: 'relocate-nodedupe-id',
      metadataOverride: usPlaceText(),
    });

    const res = await postRelocate([`${SLUG}:${oldRel}/IMG_7.dng`]);
    expect(res.status).toBe(200);
    const results = await resultsOf(res);
    expect(results[0]!.ok).toBe(true);
    expect(results[0]!.outcome).toBe('moved');
    // Edits-safety: never dedupe a source carrying a sidecar — auto-suffix instead.
    expect(results[0]!.renamed).toBe(true);
    expect(await fs.readFile(path.join(dir, newRel, 'IMG_7.1.dng'), 'utf8')).toBe(
      'identical-pixels',
    );
    expect(await fs.readFile(path.join(dir, newRel, 'IMG_7.1.xmp'), 'utf8')).toBe(
      'edits-must-not-be-dropped',
    );
    // Pre-existing occupant untouched.
    expect(await fs.readFile(path.join(dir, newRel, 'IMG_7.dng'), 'utf8')).toBe('identical-pixels');
  });
});
