/**
 * Bitmap-format thumbnail rendering — shared by `/api/fs/thumb` (live), the
 * indexer's thumb stage, and (via `imgdecode-pool.ts`'s `format: 'jpeg'`
 * option) the 1280px VLM describe/OCR preview tier. Decodes
 * JPEG/PNG/WEBP/TIFF/AVIF/HEIC/HEIF and writes a resized AVIF or JPEG to
 * `thumbPath` atomically (`.tmp` + rename) — see `ThumbOutputFormat`.
 *
 * RAW formats are NOT handled here — those go through the libraw FFI worker
 * pool. Maple's bindings decode HEIC/HEIF itself, but the SIMD-only bitmap
 * decoder doesn't (no libheif linked in), so HEIC files take a detour
 * through `heic-convert` first.
 *
 * HEIC/HEIF decode is the expensive case: `heic-convert` is libheif compiled
 * to Emscripten WASM and runs SYNCHRONOUSLY on the calling thread for
 * ~500–2000 ms per file (the `await` is misleading — it's CPU-bound WASM, not
 * I/O). This module is loaded exclusively inside `ffi/raw_ffi.child.ts`, an
 * isolated child process, so the WASM decode and any native decoder crash
 * are contained to the child — the parent HTTP server is unaffected.
 */

import { readFile, rename, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { maple } from 'maple';
import heicConvert from 'heic-convert';
import { decodePsdComposite } from './psd-hdr-decode.ts';
import { decodeHdrIsolated } from './hdr-decode-isolated.ts';

// The SHARP_EXTENSIONS allowlist lives in `indexer/media-types.ts` (a leaf
// module with no renderer deps) so routes like `/api/fs/raw` can import the
// gate without pulling in `maple` / `heic-convert`. (#782, #1988)

/** Default AVIF quality for the `thumbs` cache tier — on AVIF's own [1,100]
 * scale, NOT JPEG's; a JPEG-82-equivalent AVIF quality is meaningfully
 * lower. 55 is a starting point favoring smaller files/faster decode over
 * encode cost (thumbs are decoded on every grid scroll, encoded once at
 * index time) — tune visually against real thumbnails if this drifts.
 * Shared with `apply-orientation.ts`, `indexer/thumbnailer.ts`, and
 * `routes/fs-thumbs.ts` so the default lives in exactly one place. */
export const THUMB_AVIF_QUALITY = 55;

/** Long-edge render target for the `thumbs` cache tier, in pixels.
 *
 * A FIXED tier, not a per-request knob (#2220). `resolveThumbPath` has no size
 * component — there is one thumb file per source image — and its freshness
 * check is mtime-only, so a request for any other size would simply be served
 * whatever was written first. `/api/fs/thumb` used to accept a `size` query
 * param that did exactly that (silently returned the 512 px file), so the
 * param was removed rather than left to mislead callers; the display tier is
 * `PREVIEW_LONG_EDGE_PX` on `/api/fs/preview`.
 *
 * Shared with `indexer/thumbnailer.ts` and `routes/fs-thumbs.ts` so the tier
 * lives in exactly one place. */
export const THUMB_LONG_EDGE_PX = 512;

/** Maple's AVIF `effort`, on sharp's own 0–9 scale (higher = slower/smaller)
 * — see `avifEffortWire` in `maple` for how that maps onto the underlying
 * encoder's speed knob. 4 favors encode throughput for the indexer backlog —
 * effort has no effect on decode cost. */
export const THUMB_AVIF_EFFORT = 4;

/** Output codec for `renderImageThumbToFile` and its two format-specific
 * helpers. `'avif'` is the 256px grid-thumbnail tier (default); `'jpeg'` is
 * the 1280px VLM describe/OCR preview tier (`indexer/previewer.ts`), which
 * must keep emitting real JPEG since every describe provider hardcodes
 * `image/jpeg` as the media type it sends upstream. */
export type ThumbOutputFormat = 'avif' | 'jpeg';

/** Encode a Maple builder to `format`, matching the pre-migration
 * quality/encoder choice for the JPEG output format. */
function encodeToBuffer(
  builder: ReturnType<typeof maple>,
  quality: number,
  format: ThumbOutputFormat,
): Promise<Buffer> {
  return format === 'jpeg'
    ? builder.toFormat('jpeg', { quality }).toBuffer()
    : builder.toFormat('avif', { quality, effort: THUMB_AVIF_EFFORT }).toBuffer();
}

/** `fit: 'inside', withoutEnlargement: true` — this pipeline's resize
 * contract everywhere below: bound the long edge to `sizePx`, never upscale
 * a source that's already smaller. */
const inside = (sizePx: number) => ({
  width: sizePx,
  height: sizePx,
  fit: 'inside' as const,
  withoutEnlargement: true,
});

/** Atomic write shared by every branch below: write to a pid+random-suffixed
 * `.tmp` sibling of `thumbPath`, then rename — so a crash mid-write never
 * leaves a half-written cache file. */
async function writeAtomic(thumbPath: string, buf: Buffer): Promise<void> {
  const tmp = `${thumbPath}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  await writeFile(tmp, buf);
  await rename(tmp, thumbPath);
}

/**
 * Unlike the retired sharp path (`failOn: 'none', unlimited: true`), Maple
 * has no single "decode leniency" switch — behaviour differs by format.
 * JPEG (zune-jpeg, non-strict parsing) and AVIF (rav1d) decode
 * truncated/malformed input leniently and carry no allocation cap. TIFF/PNG/
 * WebP still go through the `image` crate with its default `Limits` (a
 * 512 MiB single-allocation cap) and no truncation leniency — a truncated or
 * pathologically large file in one of those formats still errors out here
 * exactly as it did under sharp's stricter defaults. See #3516 (filed to
 * bring the `image`-crate path's leniency/limits in line with JPEG/AVIF).
 */

/**
 * The canonical HEIC/HEIF chain: read the source, decode it to an
 * intermediate JPEG via `heic-convert` (quality 0.9), then resize + re-encode
 * via Maple to AVIF at `quality` and write atomically.
 *
 * Called by `renderImageThumbToFile` for the HEIC/HEIF branch. Lives inside the
 * `ffi/raw_ffi.child.ts` isolated process so the large input and intermediate
 * JPEG buffers never leave the child.
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
  // the thumb's output quality); the subsequent Maple resize re-encodes at
  // the caller-specified quality so the intermediate doesn't bloat the cache.
  const jpegBuffer = (await heicConvert({
    buffer: inputBuffer,
    format: 'JPEG',
    quality: 0.9,
  })) as Buffer;
  const builder = maple(jpegBuffer)
    .rotate() // honour EXIF orientation so portraits don't render sideways
    .resize(inside(sizePx));
  const buf = await encodeToBuffer(builder, quality, format);
  await writeAtomic(thumbPath, buf);
}

/**
 * PSD/PSB/HDR chain: decode to a flattened RGBA8 raster via `ag-psd` / `hdr`
 * (see `psd-hdr-decode.ts`), then hand that raster to Maple's raw-pixel input
 * mode for the exact same resize + AVIF-encode path every other bitmap
 * format uses below. These formats carry no EXIF orientation metadata (and
 * Maple's raw-pixel input path has no metadata to interpret), so we
 * intentionally do not call `.rotate()` here.
 *
 * Called by `renderImageThumbToFile` for the PSD/PSB/HDR branch. Lives inside
 * the `ffi/raw_ffi.child.ts` isolated process so a malformed file can only
 * crash this child. Not exported — unlike `renderHeicThumbToFile` (which a
 * dedicated fixture-gated test in `render.test.ts` calls directly), this
 * path's decode logic is already unit-tested in isolation in
 * `psd-hdr-decode.test.ts`, so only the dispatch through
 * `renderImageThumbToFile` needs covering here.
 *
 * HDR specifically decodes via `decodeHdrIsolated` — a fresh CHILD-OF-THIS-
 * CHILD process per call, not the in-process `decodeHdrToneMapped` — because
 * the `hdr` package cannot safely decode more than one real file per process
 * (see `psd-hdr-decode.ts`'s module doc). This `raw_ffi` child already
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

  const builder = maple({
    data: raster.data,
    width: raster.width,
    height: raster.height,
    channels: 4,
  }).resize(inside(sizePx));
  const buf = await encodeToBuffer(builder, quality, format);
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
 * This function is the canonical render body called inside `ffi/raw_ffi.child.ts`
 * (the isolated child process). All formats — including HEIC — are handled here
 * directly; there is no Worker-thread indirection. The child-process isolation
 * keeps a native-decoder crash from touching the parent HTTP server.
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
    // `ffi/raw_ffi.child.ts` this is already an isolated process — no event-loop
    // blocking concern. The old Worker-thread indirection via heic-pool is gone.
    await renderHeicThumbToFile(srcPath, thumbPath, sizePx, quality, format);
    return true;
  }

  if (ext === 'psd' || ext === 'psb' || ext === 'hdr') {
    await renderPsdOrHdrThumbToFile(srcPath, thumbPath, sizePx, ext, quality, format);
    return true;
  }

  const builder = maple(srcPath)
    // Honour EXIF orientation so portraits don't render sideways. A no-op for
    // an AVIF source today: Maple's AVIF metadata probe hardcodes
    // `orientation: 1` (no irot/imir/EXIF handling yet), so `.rotate()` has
    // nothing to act on until that lands (#3507).
    .rotate()
    .resize(inside(sizePx));
  const buf = await encodeToBuffer(builder, quality, format);
  await writeAtomic(thumbPath, buf);
  return true;
}
