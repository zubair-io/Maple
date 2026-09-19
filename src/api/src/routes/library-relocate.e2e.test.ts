/**
 * End-to-end tests for POST /api/library/relocate (and relocate-count) — #1671.
 *
 * These exercise the REAL move machinery: a temp library on disk plus a real
 * asset in an in-memory SQLite database, driven through the mounted route
 * handler. They assert the crash-safe outcome — the photo file AND its `.xmp`
 * sidecar both land in `<libraryRoot>/<year>/<state>/<city>/`, the source paths
 * are gone, and the location row is repointed — plus the collision auto-rename
 * (file + sidecar get a `.N` suffix; the pre-existing occupant is untouched) and
 * the already-in-place no-op.
 *
 * Video relocation with its full-name `.mov.xmp` sidecar is covered in
 * `library-relocate-video.e2e.test.ts` (#1678), and the Apple-rendered
 * companion plus the byte-identical dedupe in
 * `library-relocate-companion.e2e.test.ts` (#2667) — both split for the
 * file-size budget. Pure wiring and validation is `library-relocate.test.ts`.
 *
 * Nothing skips: the database is created per test, so there is no external
 * service that could be unreachable (#3787).
 */

import { describe, it, expect, afterEach } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createLiveTestDatabase } from '../db/sqlite/test-sqlite.test-helpers.ts';
import {
  SIDECAR_METADATA_INDEX_STAGE_NAME,
  SIDECAR_METADATA_INDEX_VERSION,
} from '../workers/stages/sidecar-metadata-index.ts';
import {
  SLUG,
  clearLibraryCache,
  locationOf,
  metadataOverrideOf,
  postCount,
  postRelocate,
  seedRelocatableAsset,
  stageVersionOf,
  usPlaceText,
} from './library-relocate.test-helpers.ts';

interface RelocateResult {
  ok: boolean;
  outcome?: string;
  renamed?: boolean;
  error?: string;
}

async function resultsOf(res: Response): Promise<RelocateResult[]> {
  return ((await res.json()) as { results: RelocateResult[] }).results;
}

describe('library-relocate end-to-end', () => {
  let dir: string | null = null;

  afterEach(async () => {
    if (dir) await fs.rm(dir, { recursive: true, force: true });
    dir = null;
    clearLibraryCache();
  });

  it('relocates a photo + its .xmp sidecar into year/state/city, repoints the row, removes the source', async () => {
    using live = await createLiveTestDatabase();
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'relocate-photo-'));

    const oldRel = '2024/Loose';
    await fs.mkdir(path.join(dir, ...oldRel.split('/')), { recursive: true });
    await fs.writeFile(path.join(dir, oldRel, 'IMG_1.dng'), 'pixels');
    await fs.writeFile(path.join(dir, oldRel, 'IMG_1.xmp'), 'edits');

    const asset = seedRelocatableAsset(live.db, {
      root: dir,
      relPath: oldRel,
      filename: 'IMG_1.dng',
      mapleId: 'relocate-photo-id',
      metadataOverride: usPlaceText(),
    });

    const res = await postRelocate([`${SLUG}:${oldRel}/IMG_1.dng`]);
    expect(res.status).toBe(200);
    const results = await resultsOf(res);
    expect(results).toHaveLength(1);
    expect(results[0]!.ok).toBe(true);
    expect(results[0]!.outcome).toBe('moved');
    expect(results[0]!.renamed).toBe(false);

    const newRel = '2024/California/Berkeley';
    // File + sidecar both landed at the new dir with identical bytes.
    expect(await fs.readFile(path.join(dir, newRel, 'IMG_1.dng'), 'utf8')).toBe('pixels');
    expect(await fs.readFile(path.join(dir, newRel, 'IMG_1.xmp'), 'utf8')).toBe('edits');
    // Sources gone.
    await expect(fs.stat(path.join(dir, oldRel, 'IMG_1.dng'))).rejects.toThrow();
    await expect(fs.stat(path.join(dir, oldRel, 'IMG_1.xmp'))).rejects.toThrow();

    // The location row is repointed, and the caches keyed on the old path are
    // re-armed in the same transaction that repointed it.
    expect(locationOf(live.db, asset.assetId)).toMatchObject({
      path: newRel,
      filename: 'IMG_1.dng',
    });
    expect(stageVersionOf(live.db, asset.assetId, 'thumb')).toBe(0);
    expect(stageVersionOf(live.db, asset.assetId, 'preview')).toBe(0);
    expect(stageVersionOf(live.db, asset.assetId, 'meili')).toBe(0);
  });

  it('relocates a photo flagged missing_since, and clears the flag', async () => {
    using live = await createLiveTestDatabase();
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'relocate-missing-'));

    const oldRel = '2024/Loose';
    await fs.mkdir(path.join(dir, ...oldRel.split('/')), { recursive: true });
    await fs.writeFile(path.join(dir, oldRel, 'IMG_missing.dng'), 'missing_bytes');
    await fs.writeFile(path.join(dir, oldRel, 'IMG_missing.xmp'), 'edits');

    const asset = seedRelocatableAsset(live.db, {
      root: dir,
      relPath: oldRel,
      filename: 'IMG_missing.dng',
      mapleId: 'relocate-missing-id',
      metadataOverride: usPlaceText(),
      missingSince: '2026-06-30T00:00:00.000Z',
    });

    // 1. relocate-count still counts it: a missing-tagged file the client has
    //    resolved on disk is a relocation candidate like any other.
    const countRes = await postCount([`${SLUG}:${oldRel}/IMG_missing.dng`]);
    expect(countRes.status).toBe(200);
    expect(((await countRes.json()) as { count: number }).count).toBe(1);

    // 2. Perform the relocate.
    const res = await postRelocate([`${SLUG}:${oldRel}/IMG_missing.dng`]);
    expect(res.status).toBe(200);
    const results = await resultsOf(res);
    expect(results).toHaveLength(1);
    expect(results[0]!.ok).toBe(true);
    expect(results[0]!.outcome).toBe('moved');

    const newRel = '2024/California/Berkeley';
    expect(await fs.readFile(path.join(dir, newRel, 'IMG_missing.dng'), 'utf8')).toBe(
      'missing_bytes',
    );
    expect(await fs.readFile(path.join(dir, newRel, 'IMG_missing.xmp'), 'utf8')).toBe('edits');

    // Repointed, and the missing tag is gone — the file is demonstrably there.
    expect(locationOf(live.db, asset.assetId)).toMatchObject({
      path: newRel,
      filename: 'IMG_missing.dng',
      missing_since: null,
    });
  });

  it('auto-renames file + sidecar on collision (.N suffix), leaving the occupant untouched', async () => {
    using live = await createLiveTestDatabase();
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'relocate-collision-'));

    const oldRel = '2024/Loose';
    const newRel = '2024/California/Berkeley';
    await fs.mkdir(path.join(dir, ...oldRel.split('/')), { recursive: true });
    await fs.mkdir(path.join(dir, ...newRel.split('/')), { recursive: true });
    // Source (distinct bytes from the occupant, so it can't dedupe).
    await fs.writeFile(path.join(dir, oldRel, 'IMG_2.dng'), 'source-pixels');
    await fs.writeFile(path.join(dir, oldRel, 'IMG_2.xmp'), 'source-edits');
    // Pre-existing occupant at the target with the SAME name, different bytes.
    // Untracked on purpose: a file on disk the catalogue knows nothing about.
    await fs.writeFile(path.join(dir, newRel, 'IMG_2.dng'), 'occupant-pixels');
    await fs.writeFile(path.join(dir, newRel, 'IMG_2.xmp'), 'occupant-edits');

    const asset = seedRelocatableAsset(live.db, {
      root: dir,
      relPath: oldRel,
      filename: 'IMG_2.dng',
      mapleId: 'relocate-collision-id',
      metadataOverride: usPlaceText(),
    });

    const res = await postRelocate([`${SLUG}:${oldRel}/IMG_2.dng`]);
    expect(res.status).toBe(200);
    const results = await resultsOf(res);
    expect(results[0]!.ok).toBe(true);
    expect(results[0]!.outcome).toBe('moved');
    expect(results[0]!.renamed).toBe(true);

    // Occupant untouched.
    expect(await fs.readFile(path.join(dir, newRel, 'IMG_2.dng'), 'utf8')).toBe('occupant-pixels');
    expect(await fs.readFile(path.join(dir, newRel, 'IMG_2.xmp'), 'utf8')).toBe('occupant-edits');
    // Moved copy landed at the suffixed sibling (.1) — file AND sidecar.
    expect(await fs.readFile(path.join(dir, newRel, 'IMG_2.1.dng'), 'utf8')).toBe('source-pixels');
    expect(await fs.readFile(path.join(dir, newRel, 'IMG_2.1.xmp'), 'utf8')).toBe('source-edits');
    // Source gone.
    await expect(fs.stat(path.join(dir, oldRel, 'IMG_2.dng'))).rejects.toThrow();

    expect(locationOf(live.db, asset.assetId)).toMatchObject({
      path: newRel,
      filename: 'IMG_2.1.dng',
    });
  });

  it('already in the right folder → count 0, relocate is a no-op', async () => {
    using live = await createLiveTestDatabase();
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'relocate-inplace-'));

    // The asset already lives at its canonical geo dir.
    const rel = '2024/California/Berkeley';
    await fs.mkdir(path.join(dir, ...rel.split('/')), { recursive: true });
    await fs.writeFile(path.join(dir, rel, 'IMG_3.dng'), 'pixels');
    await fs.writeFile(path.join(dir, rel, 'IMG_3.xmp'), 'edits');

    seedRelocatableAsset(live.db, {
      root: dir,
      relPath: rel,
      filename: 'IMG_3.dng',
      mapleId: 'relocate-inplace-id',
      metadataOverride: usPlaceText(),
    });

    const res = await postCount([`${SLUG}:${rel}/IMG_3.dng`]);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { count: number }).count).toBe(0);
  });

  it('relocates to year/Screenshot when metadata_override.is_screenshot is true', async () => {
    using live = await createLiveTestDatabase();
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'relocate-override-screenshot-'));

    const oldRel = '2024/Loose';
    await fs.mkdir(path.join(dir, ...oldRel.split('/')), { recursive: true });
    await fs.writeFile(path.join(dir, oldRel, 'IMG_scr.dng'), 'pixels');
    await fs.writeFile(path.join(dir, oldRel, 'IMG_scr.xmp'), 'edits');

    const asset = seedRelocatableAsset(live.db, {
      root: dir,
      relPath: oldRel,
      filename: 'IMG_scr.dng',
      mapleId: 'relocate-override-screenshot-id',
      metadataOverride: {
        place_text: {
          city: 'Berkeley',
          state: 'California',
          country: 'United States',
          country_code: 'US',
        },
        is_screenshot: true,
      },
    });

    const countRes = await postCount([`${SLUG}:${oldRel}/IMG_scr.dng`]);
    expect(countRes.status).toBe(200);
    expect(((await countRes.json()) as { count: number }).count).toBe(1);

    const res = await postRelocate([`${SLUG}:${oldRel}/IMG_scr.dng`]);
    expect(res.status).toBe(200);
    expect((await resultsOf(res))[0]!.ok).toBe(true);

    const newRel = '2024/Screenshot';
    expect(await fs.readFile(path.join(dir, newRel, 'IMG_scr.dng'), 'utf8')).toBe('pixels');
    expect(await fs.readFile(path.join(dir, newRel, 'IMG_scr.xmp'), 'utf8')).toBe('edits');
    expect(locationOf(live.db, asset.assetId)).toMatchObject({ path: newRel });
  });

  it('reconciles the override from the sidecar on the fly when the stage is dirty', async () => {
    using live = await createLiveTestDatabase();
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'relocate-reconcile-'));

    const oldRel = '2024/Loose';
    await fs.mkdir(path.join(dir, ...oldRel.split('/')), { recursive: true });
    await fs.writeFile(path.join(dir, oldRel, 'IMG_4.dng'), 'pixels');
    await fs.writeFile(
      path.join(dir, oldRel, 'IMG_4.xmp'),
      `<?xml version="1.0" encoding="UTF-8"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
   xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/"
   xmlns:Iptc4xmpCore="http://iptc.org/std/Iptc4xmpCore/1.0/xmlns/"
   photoshop:City="Berkeley"
   photoshop:State="California"
   photoshop:Country="United States"
   Iptc4xmpCore:CountryCode="US">
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>`,
    );

    // No override at all and the stage below target — the state an asset is in
    // immediately after the batch metadata editor wrote its sidecar.
    const asset = seedRelocatableAsset(live.db, {
      root: dir,
      relPath: oldRel,
      filename: 'IMG_4.dng',
      mapleId: 'relocate-reconcile-id',
      metadataOverride: null,
      sidecarStageVersion: 0,
    });

    // relocate-count has to notice the stage is behind, run the handler, store
    // what it produced, and only then decide — otherwise it would compare the
    // asset's current folder against a place it does not know about yet.
    const res = await postCount([`${SLUG}:${oldRel}/IMG_4.dng`]);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { count: number }).count).toBe(1);

    const override = metadataOverrideOf(live.db, asset.assetId);
    expect((override?.['place_text'] as { city?: string; state?: string })?.city).toBe('Berkeley');
    expect((override?.['place_text'] as { city?: string; state?: string })?.state).toBe(
      'California',
    );
    expect(stageVersionOf(live.db, asset.assetId, SIDECAR_METADATA_INDEX_STAGE_NAME)).toBe(
      SIDECAR_METADATA_INDEX_VERSION,
    );
  });
});
