/**
 * Cross-platform round-trip validation (#1997, epic #1993 stage 5, item 2a):
 * a preview the SERVER produces (via the `preview` worker stage) must be a
 * genuine, complete AVIF with correct dimensions, baked (no) orientation tag,
 * and the declared untagged-sRGB colourspace — i.e. it must pass the exact
 * same #2014 `validateAvifOutput` gate a client-shaped upload has to pass in
 * `routes/preview.ts` (see `preview-put-then-serve-roundtrip.test.ts`). Both
 * producers publish through the same contract; this file pins the
 * SERVER-as-producer half of it end to end (decode, not just spot-checked
 * metadata fields — `workers/stages/preview.test.ts` already spot-checks
 * width/height/orientation per case, this file additionally runs the FULL
 * validator, including the pixel-decode integrity check, against real stage
 * output).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { ObjectId } from 'mongodb';
import sharp from 'sharp';

import previewStage from '../src/workers/stages/preview.ts';
import { cachePathForAsset } from '../src/fs/xmp.ts';
import { PREVIEW_CACHE_SUFFIX, PREVIEW_LONG_EDGE_PX } from '../src/indexer/previewer.ts';
import { validateAvifOutput } from '../src/thumbs/validate-avif.ts';
import { setLibraryRootsForTests, invalidateLibraryRoots } from '../src/indexer/libraries.cache.ts';

function makeDoc(filename: string, libraryId: ObjectId) {
  return {
    fileinfo: [{ path: '', filename, library_id: libraryId, deleted_at: null }],
    maple_id: 'c'.repeat(32),
  };
}

describe('preview stage output passes the full #2014 validator (#1997)', () => {
  let dir = '';
  let libraryId: ObjectId;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'preview-server-write-contract-'));
    libraryId = new ObjectId();
    setLibraryRootsForTests(new Map([[libraryId.toHexString(), dir]]));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    setLibraryRootsForTests(null);
    invalidateLibraryRoots();
  });

  async function renderAndValidate(
    filename: string,
    createOpts: sharp.Create,
    withMetadata?: Parameters<sharp.Sharp['withMetadata']>[0],
  ) {
    const file = path.join(dir, filename);
    let pipeline = sharp({ create: createOpts }).jpeg();
    if (withMetadata) pipeline = pipeline.withMetadata(withMetadata);
    await writeFile(file, await pipeline.toBuffer());

    const doc = makeDoc(filename, libraryId);
    const result = await previewStage.handler(doc as never, {} as never);
    expect(result).toEqual({ wrote: true });

    const previewPath = cachePathForAsset(
      doc as never,
      new Map([[libraryId.toHexString(), dir]]),
      'previews',
      PREVIEW_CACHE_SUFFIX,
    );
    expect(previewPath).not.toBeNull();

    return validateAvifOutput(previewPath as string, PREVIEW_LONG_EDGE_PX);
  }

  it('a wide JPEG source produces a preview that passes the full decode-validate gate', async () => {
    const result = await renderAndValidate('wide-contract.jpg', {
      width: 2400,
      height: 1400,
      channels: 3,
      background: { r: 90, g: 140, b: 200 },
    });
    expect(result).toEqual({ ok: true });
  });

  it('a rotated (EXIF orientation 6) JPEG source produces a preview with baked pixels and no leftover orientation tag', async () => {
    const result = await renderAndValidate(
      'rotated-contract.jpg',
      { width: 1800, height: 900, channels: 3, background: { r: 200, g: 60, b: 60 } },
      { orientation: 6 },
    );
    // validateAvifOutput's orientation check (point 3 in its doc) fails the
    // whole result if a tag other than 1/undefined survived — asserting
    // ok:true here is a strictly stronger claim than the existing stage
    // test's standalone `meta.orientation` spot-check.
    expect(result).toEqual({ ok: true });
  });

  it('a small (sub-1280) JPEG source is not upscaled and still passes validation', async () => {
    const result = await renderAndValidate('small-contract.jpg', {
      width: 500,
      height: 350,
      channels: 3,
      background: { r: 10, g: 200, b: 40 },
    });
    expect(result).toEqual({ ok: true });
  });
});
