/**
 * Bitmap-format thumbnail rendering — shared by `/api/fs/thumb` (live), the
 * indexer's thumb stage, and (via `imgdecode-pool.ts`'s `format: 'jpeg'`
 * option) the 1280px VLM describe/OCR preview tier. Decodes
 * JPEG/PNG/WEBP/TIFF/AVIF/HEIC/HEIF and writes a resized AVIF or JPEG to
 * `thumbPath` atomically (`.tmp` + rename) — see `ThumbOutputFormat`.
 *
 * RAW formats are NOT handled here — those go through the libraw FFI worker
 * pool. Sharp's prebuilt libvips on Linux ships without libheif (libheif →
 * x265 GPL), so HEIC files take a detour through `heic-convert` first.
 *
 * HEIC/HEIF decode is the expensive case: `heic-convert` is libheif compiled
 * to Emscripten WASM and runs SYNCHRONOUSLY on the calling thread for
 * ~500–2000 ms per file (the `await` is misleading — it's CPU-bound WASM, not
 * I/O). This module is loaded exclusively inside `imgdecode.child.ts`, an
 * isolated child process, so the WASM decode and any libvips crash are contained
 * to the child — the parent HTTP server is unaffected.
 */

import { readFile, rename, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import sharp from 'sharp';
import heicConvert from 'heic-convert';
import { decodePsdComposite } from './psd-hdr-decode.ts';
import { decodeHdrIsolated } from './hdr-decode-isolated.ts';

// The SHARP_EXTENSIONS allowlist moved to `fs/browse.ts` (a light module with
// no renderer deps) so routes like `/api/fs/raw` can import the gate without
// pulling in `sharp` / `heic-convert`. Re-exported here so existing
// `thumbs/render.ts` importers keep working unchanged. (#782)
export { SHARP_EXTENSIONS } from '../fs/browse.ts';

/** Default AVIF quality for the `thumbs` cache tier — on AVIF's own [1,100]
 * scale, NOT JPEG's; a JPEG-82-equivalent AVIF quality is meaningfully
 * lower. 55 is a starting point favoring smaller files/faster decode over
 * encode cost (thumbs are decoded on every grid scroll, encoded once at
 * index time) — tune visually against real thumbnails if this drifts.
 * Shared with `apply-orientation.ts`, `indexer/thumbnailer.ts`, and
 * `routes/fs-thumbs.ts` so the default lives in exactly one place. */
export const THUMB_AVIF_QUALITY = 55;

/** Sharp's AVIF `effort` (0–9, higher = slower/smaller). 4 favors encode
 * throughput for the indexer backlog — effort has no effect on decode cost. */
export const THUMB_AVIF_EFFORT = 4;

/** Output codec for `renderImageThumbToFile` and its two format-specific
 * helpers. `'avif'` is the 256px grid-thumbnail tier (default); `'jpeg'` is
 * the 1280px VLM describe/OCR preview tier (`indexer/previewer.ts`), which
 * must keep emitting real JPEG since every describe provider hardcodes
 * `image/jpeg` as the media type it sends upstream. */
export type ThumbOutputFormat = 'avif' | 'jpeg';

/** sharp's mozjpeg encoder, matching the pre-AVIF-migration quality/encoder
 * choice for the JPEG output format. */
function encodeToBuffer(
  pipeline: sharp.Sharp,
  quality: number,
  format: ThumbOutputFormat,
): Promise<Buffer> {
  return format === 'jpeg'
    ? pipeline.jpeg({ quality, mozjpeg: true }).toBuffer()
    : pipeline.avif({ quality, effort: THUMB_AVIF_EFFORT }).toBuffer();
}

/** Atomic write shared by every branch below: write to a pid+random-suffixed
 * `.tmp` sibling of `thumbPath`, then rename — so a crash mid-write never
 * leaves a half-written cache file. */
async function writeAtomic(thumbPath: string, buf: Buffer): Promise<void> {
  const tmp = `${thumbPath}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  await writeFile(tmp, buf);
  await rename(tmp, thumbPath);
}

/**
 * Input options handed to every `sharp()` decode in this module.
 *
 * - `failOn: 'none'` — keep going through truncation / non-fatal warnings
 *   rather than throwing, so a slightly damaged frame still yields a thumb.
 * - `unlimited: true` — lift libvips' built-in denial-of-service caps. The
 *   one that bites in practice is the TIFF loader's 50 MiB cumulated-malloc
 *   ceiling (libtiff `TIFFOpenOptionsSetMaxCumulatedMemAlloc`): full-res
 *   single-strip exports from cameras and editors carry one image strip
 *   well over 50 MiB, so the loader aborts with "Cumulated memory
 *   allocation … beyond the 52428800 cumulated byte limit". The flag also
 *   drops the default ~0.5 GP pixel-count guard. These inputs are the
 *   operator's own trusted library files (not untrusted uploads), so the
 *   DoS guards cost us real decodes without buying protection here.
 */
const SHARP_INPUT_OPTS = { failOn: 'none', unlimited: true } as const;

/**
 * The canonical HEIC/HEIF chain: read the source, decode it to an
 * intermediate JPEG via `heic-convert` (quality 0.9), then resize + re-encode
 * via sharp to AVIF at `quality` and write atomically.
 *
 * Called by `renderImageThumbToFile` for the HEIC/HEIF branch. Lives inside the
 * `imgdecode.child.ts` isolated process so the large input and intermediate JPEG
 * buffers never leave the child.
 *
 * Throws on decode/encode/IO failure.
 */
export async function renderHeicThumbToFile(
  srcPath: string,
  thumbPath: string,
  sizePx: number,
  quality = THUMB_AVIF_QUALITY,
  format: ThumbOutputFormat = 'avif',
): Promise<void> {
  const inputBuffer = await readFile(srcPath);
  // heic-convert → JPEG quality 0.9 (its own intermediate-decode scale, not
  // the thumb's output quality); subsequent sharp resize re-encodes at the
  // caller-specified quality so the intermediate doesn't bloat the cache.
  const jpegBuffer = (await heicConvert({
    buffer: inputBuffer,
    format: 'JPEG',
    quality: 0.9,
  })) as Buffer;
  const pipeline = sharp(jpegBuffer, SHARP_INPUT_OPTS)
    .rotate() // honour EXIF orientation so portraits don't render sideways
    .resize(sizePx, sizePx, { fit: 'inside', withoutEnlargement: true });
  const buf = await encodeToBuffer(pipeline, quality, format);
  await writeAtomic(thumbPath, buf);
}

/**
 * PSD/PSB/HDR chain: decode to a flattened RGBA8 raster via `ag-psd` / `hdr`
 * (see `psd-hdr-decode.ts`), then hand that raster to sharp's `raw` input
 * mode for the exact same resize + AVIF-encode path every other bitmap
 * format uses below. These formats carry no EXIF orientation metadata (and
 * sharp's raw-input path has no metadata to interpret), so we intentionally
 * do not call `.rotate()` here.
 *
 * Called by `renderImageThumbToFile` for the PSD/PSB/HDR branch. Lives inside
 * the `imgdecode.child.ts` isolated process so a malformed file can only
 * crash this child. Not exported — unlike `renderHeicThumbToFile` (which a
 * dedicated fixture-gated test in `render.test.ts` calls directly), this
 * path's decode logic is already unit-tested in isolation in
 * `psd-hdr-decode.test.ts`, so only the dispatch through
 * `renderImageThumbToFile` needs covering here.
 *
 * HDR specifically decodes via `decodeHdrIsolated` — a fresh CHILD-OF-THIS-
 * CHILD process per call, not the in-process `decodeHdrToneMapped` — because
 * the `hdr` package cannot safely decode more than one real file per process
 * (see `psd-hdr-decode.ts`'s module doc). This `imgdecode` child already
 * outlives many requests across every other format, so calling that function
 * directly here would hang the second HDR file ever requested. PSD/PSB have
 * no such bug and decode in-process via `decodePsdComposite` same as before.
 *
 * Throws on decode/encode/IO failure.
 */
async function renderPsdOrHdrThumbToFile(
  srcPath: string,
  thumbPath: string,
  sizePx: number,
  ext: string,
  quality = THUMB_AVIF_QUALITY,
  format: ThumbOutputFormat = 'avif',
): Promise<void> {
  const inputBuffer = await readFile(srcPath);
  const raster =
    ext === 'hdr'
      ? await decodeHdrIsolated(new Uint8Array(inputBuffer))
      : decodePsdComposite(new Uint8Array(inputBuffer));

  const pipeline = sharp(raster.data, {
    raw: { width: raster.width, height: raster.height, channels: 4 },
  }).resize(sizePx, sizePx, { fit: 'inside', withoutEnlargement: true });
  const buf = await encodeToBuffer(pipeline, quality, format);
  await writeAtomic(thumbPath, buf);
}

/**
 * Render `srcPath` to `thumbPath` with the long edge ≤ `sizePx`, in `format`
 * (default AVIF — the 256px grid-thumbnail tier; the 1280px VLM
 * describe/OCR preview tier passes `'jpeg'`). Atomic: writes to
 * `<thumbPath>.<pid>.tmp` first, then renames so a crash mid-write never
 * leaves a half-written cache file. Caller is responsible for ensuring the
 * parent directory exists.
 *
 * This function is the canonical render body called inside `imgdecode.child.ts`
 * (the isolated child process). All formats — including HEIC — are handled here
 * directly; there is no Worker-thread indirection. The child-process isolation
 * keeps a libvips/libheif crash from touching the parent HTTP server.
 *
 * Returns true on success. Throws on decode/encode/IO failure — callers
 * decide whether to log + skip or surface as a 500.
 */
export async function renderImageThumbToFile(
  srcPath: string,
  thumbPath: string,
  sizePx: number,
  ext: string,
  quality = THUMB_AVIF_QUALITY,
  format: ThumbOutputFormat = 'avif',
): Promise<boolean> {
  if (ext === 'heic' || ext === 'heif') {
    // Call the canonical HEIC chain directly. When render.ts is loaded inside
    // `imgdecode.child.ts` this is already an isolated process — no event-loop
    // blocking concern. The old Worker-thread indirection via heic-pool is gone.
    await renderHeicThumbToFile(srcPath, thumbPath, sizePx, quality, format);
    return true;
  }

  if (ext === 'psd' || ext === 'psb' || ext === 'hdr') {
    await renderPsdOrHdrThumbToFile(srcPath, thumbPath, sizePx, ext, quality, format);
    return true;
  }

  const pipeline = sharp(srcPath, SHARP_INPUT_OPTS)
    .rotate() // honour EXIF orientation so portraits don't render sideways
    .resize(sizePx, sizePx, { fit: 'inside', withoutEnlargement: true });
  const buf = await encodeToBuffer(pipeline, quality, format);
  await writeAtomic(thumbPath, buf);
  return true;
}
