/**
 * Preview-stage tests for the video poster-frame branch (#1649).
 *
 * Split out of `preview.test.ts` rather than appended to it: that file was
 * already at 562 lines against a 400-line soft / 600-line hard budget, and the
 * video cases would have pushed it past the hard limit. The split is along a
 * real seam — these are the only cases that care about host video-decode
 * capability — so each file stays readable on its own.
 *
 * Both branches of that capability are covered, because both are load-bearing:
 * with ffmpeg the stage must publish a validated AVIF, and without it the
 * stage must skip BEFORE `generatePreview` so nothing half-written lands in
 * the cache. `ffmpegBinary` is pinned in each test rather than read from the
 * host, so these assert the same thing on a dev Mac with Homebrew ffmpeg and
 * on a bare CI container.
 */

import { describe, expect, it, beforeAll, afterAll, spyOn } from 'bun:test';
import { mkdtemp, rm, writeFile, stat, readdir } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import sharp from 'sharp';
import { ObjectId } from 'mongodb';
import previewStage from './preview.ts';
import { PREVIEW_LONG_EDGE_PX, PREVIEW_CACHE_SUFFIX } from '../../indexer/previewer.ts';
import { cachePathForAsset } from '../../fs/xmp.ts';
import * as imgdecodePoolModule from '../../thumbs/imgdecode-pool.ts';
import * as videoPosterModule from '../../thumbs/video-poster.ts';

let dir: string;
let libraryId: ObjectId;
let renderStubSpy: ReturnType<typeof spyOn> | null = null;

/**
 * Replace ONLY the imgdecode subprocess boundary, transcoding in-process via
 * sharp instead — same treatment as `preview.test.ts`, for the same reason:
 * spawning real decode children from several test files destabilises the
 * shared pool singleton under CI's constrained resources. Everything else,
 * including `finalizeAvifRender`'s real decode-gate, stays production code, so
 * the artefacts asserted below are decode-verified rather than asserted-by-mock.
 *
 * Installed in `beforeAll`, not at module scope: a top-level install would
 * patch the shared namespace merely because this file was COLLECTED, which is
 * the order-dependent-leak class documented at length in `preview.test.ts`.
 */
beforeAll(async () => {
  renderStubSpy = spyOn(imgdecodePoolModule, 'renderImageThumbToFileViaPool').mockImplementation(
    async (srcPath: string, outPath: string, maxPx: number, quality: number) => {
      try {
        const out = await sharp(srcPath, { failOn: 'none', unlimited: true })
          .rotate()
          .resize(maxPx, maxPx, { fit: 'inside', withoutEnlargement: true })
          .avif({ quality })
          .toBuffer();
        await writeFile(outPath, out);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  dir = await mkdtemp(path.join(os.tmpdir(), 'preview-stage-video-'));
  libraryId = new ObjectId();
  const { setLibraryRootsForTests } = await import('../../indexer/libraries.cache.ts');
  setLibraryRootsForTests(new Map([[libraryId.toHexString(), dir]]));
});

afterAll(async () => {
  renderStubSpy?.mockRestore();
  renderStubSpy = null;
  await rm(dir, { recursive: true, force: true });
  const { setLibraryRootsForTests } = await import('../../indexer/libraries.cache.ts');
  setLibraryRootsForTests(null);
});

/** Minimal asset doc. The preview handler reads only `fileinfo` (to resolve the
 * source + cache paths) — the `stages` map it never touches, so this omits the
 * decorative skeleton `preview.test.ts` carries. */
function makeDoc(absPath: string, mapleId: string) {
  return {
    _id: new ObjectId(),
    fileinfo: [
      {
        path: '',
        filename: path.basename(absPath),
        library_id: libraryId,
        deleted_at: null,
      },
    ],
    sha1_head: 'c'.repeat(40),
    maple_id: mapleId,
    exif: null,
    stages: {},
  };
}

function previewPathFor(doc: ReturnType<typeof makeDoc>): string {
  const p = cachePathForAsset(
    doc as never,
    new Map([[libraryId.toHexString(), dir]]),
    'previews',
    PREVIEW_CACHE_SUFFIX,
  );
  if (!p) throw new Error('test setup: cachePathForAsset returned null');
  return p;
}

describe('preview handler — video, no host ffmpeg', () => {
  it("returns { skip: 'no-video-decoder' } and writes no preview", async () => {
    // The skip must land BEFORE `generatePreview`: a failed render there still
    // returns `{ wrote: true }`, marking the stage done having published
    // nothing. Downstream, describe's `preview-missing` branch is what should
    // fire — never a half-written artefact shipped to the vision model.
    const ffmpegSpy = spyOn(videoPosterModule, 'ffmpegBinary').mockResolvedValue(null);
    try {
      const file = path.join(dir, 'IMG_3087.MOV');
      await writeFile(file, Buffer.from('not really a video, just bytes'));
      const doc = makeDoc(file, 'f'.repeat(32));

      const result = await previewStage.handler(doc as never, {} as never);
      expect((result as { skip: string }).skip).toBe('no-video-decoder');

      await expect(stat(previewPathFor(doc))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      ffmpegSpy.mockRestore();
    }
  });
});

describe('preview handler — video, ffmpeg available', () => {
  it('publishes a decodable AVIF preview at the 1280-px long edge', async () => {
    const ffmpegSpy = spyOn(videoPosterModule, 'ffmpegBinary').mockResolvedValue('/usr/bin/ffmpeg');
    // Stand in for the ffmpeg subprocess by writing a real JPEG at the poster
    // path the previewer asked for. 1920x1080 — a realistic frame size, and
    // crucially LARGER than PREVIEW_LONG_EDGE_PX so the resize actually
    // engages; the pipeline only ever downscales, so a small source would pass
    // through untouched and the dimension assertion would test nothing.
    const extractSpy = spyOn(videoPosterModule, 'extractVideoPosterJpeg').mockImplementation(
      async (_video: string, out: string) => {
        await sharp({
          create: { width: 1920, height: 1080, channels: 3, background: '#3060a0' },
        })
          .jpeg()
          .toFile(out);
        return true;
      },
    );
    try {
      const file = path.join(dir, 'clip-ok.mov');
      await writeFile(file, Buffer.from('container bytes'));
      const doc = makeDoc(file, 'a'.repeat(32));

      const result = await previewStage.handler(doc as never, {} as never);
      expect('wrote' in result).toBe(true);

      const previewPath = previewPathFor(doc);
      const meta = await sharp(previewPath).metadata();
      expect(meta.format).toBe('heif');
      expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBe(PREVIEW_LONG_EDGE_PX);
      // Aspect ratio preserved from the source frame, not squashed to square.
      expect(meta.width).toBe(1280);
      expect(meta.height).toBe(720);
    } finally {
      extractSpy.mockRestore();
      ffmpegSpy.mockRestore();
    }
  });

  it('leaves no intermediate poster JPEG or temp file beside the artefact', async () => {
    // The poster JPEG is a two-hop implementation detail. Leaking it into
    // `.maple/previews/` would grow the cache without bound and expose a
    // non-AVIF file to cache-gc and the preview route.
    const ffmpegSpy = spyOn(videoPosterModule, 'ffmpegBinary').mockResolvedValue('/usr/bin/ffmpeg');
    const extractSpy = spyOn(videoPosterModule, 'extractVideoPosterJpeg').mockImplementation(
      async (_video: string, out: string) => {
        await sharp({
          create: { width: 1920, height: 1080, channels: 3, background: '#207040' },
        })
          .jpeg()
          .toFile(out);
        return true;
      },
    );
    try {
      const file = path.join(dir, 'clip-clean.mov');
      await writeFile(file, Buffer.from('container bytes'));
      const doc = makeDoc(file, 'b'.repeat(32));

      await previewStage.handler(doc as never, {} as never);

      const entries = await readdir(path.dirname(previewPathFor(doc)));
      expect(entries.filter((f) => f.includes('.poster.') || f.includes('.tmp.'))).toEqual([]);
    } finally {
      extractSpy.mockRestore();
      ffmpegSpy.mockRestore();
    }
  });

  it('skips and publishes nothing when extraction fails on a corrupt container', async () => {
    // ffmpeg present but the file is undecodable. `generatePreview`'s video
    // branch returns false, `finalizeAvifRender` publishes nothing, and no
    // zero-byte artefact may be left behind for the route to serve.
    const ffmpegSpy = spyOn(videoPosterModule, 'ffmpegBinary').mockResolvedValue('/usr/bin/ffmpeg');
    const extractSpy = spyOn(videoPosterModule, 'extractVideoPosterJpeg').mockResolvedValue(false);
    try {
      const file = path.join(dir, 'corrupt.mov');
      await writeFile(file, Buffer.from('truncated container'));
      const doc = makeDoc(file, 'c'.repeat(32));

      await previewStage.handler(doc as never, {} as never);

      await expect(stat(previewPathFor(doc))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      extractSpy.mockRestore();
      ffmpegSpy.mockRestore();
    }
  });
});
