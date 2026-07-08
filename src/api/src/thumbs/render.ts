/**
 * Bitmap-format thumbnail rendering — shared by `/api/fs/thumb` (live) and
 * the indexer's thumb stage. Decodes JPEG/PNG/WEBP/TIFF/AVIF/HEIC/HEIF and
 * writes a resized JPEG to `thumbPath` atomically (`.tmp` + rename).
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
 * via sharp at `quality` (mozjpeg) and write atomically.
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
  quality = 82,
): Promise<void> {
  const inputBuffer = await readFile(srcPath);
  // heic-convert → JPEG quality 0.9; subsequent sharp resize re-encodes at
  // the caller-specified quality so the intermediate doesn't bloat the cache.
  const jpegBuffer = (await heicConvert({
    buffer: inputBuffer,
    format: 'JPEG',
    quality: 0.9,
  })) as Buffer;
  const buf = await sharp(jpegBuffer, SHARP_INPUT_OPTS)
    .rotate() // honour EXIF orientation so portraits don't render sideways
    .resize(sizePx, sizePx, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality, mozjpeg: true })
    .toBuffer();
  const tmp = `${thumbPath}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  await writeFile(tmp, buf);
  await rename(tmp, thumbPath);
}

/**
 * PSD/PSB/HDR chain: decode to a flattened RGBA8 raster via `ag-psd` / `hdr`
 * (see `psd-hdr-decode.ts`), then hand that raster to sharp's `raw` input
 * mode for the exact same resize + mozjpeg-encode path every other bitmap
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
  quality = 82,
): Promise<void> {
  const inputBuffer = await readFile(srcPath);
  const raster =
    ext === 'hdr'
      ? await decodeHdrIsolated(new Uint8Array(inputBuffer))
      : decodePsdComposite(new Uint8Array(inputBuffer));

  const buf = await sharp(raster.data, {
    raw: { width: raster.width, height: raster.height, channels: 4 },
  })
    .resize(sizePx, sizePx, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality, mozjpeg: true })
    .toBuffer();
  const tmp = `${thumbPath}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  await writeFile(tmp, buf);
  await rename(tmp, thumbPath);
}

/**
 * Render `srcPath` to `thumbPath` as a JPEG with the long edge ≤ `sizePx`.
 * Atomic: writes to `<thumbPath>.<pid>.tmp` first, then renames so a crash
 * mid-write never leaves a half-written cache file. Caller is responsible
 * for ensuring the parent directory exists.
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
  quality = 82,
): Promise<boolean> {
  if (ext === 'heic' || ext === 'heif') {
    // Call the canonical HEIC chain directly. When render.ts is loaded inside
    // `imgdecode.child.ts` this is already an isolated process — no event-loop
    // blocking concern. The old Worker-thread indirection via heic-pool is gone.
    await renderHeicThumbToFile(srcPath, thumbPath, sizePx, quality);
    return true;
  }

  if (ext === 'psd' || ext === 'psb' || ext === 'hdr') {
    await renderPsdOrHdrThumbToFile(srcPath, thumbPath, sizePx, ext, quality);
    return true;
  }

  const tmp = `${thumbPath}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  const buf = await sharp(srcPath, SHARP_INPUT_OPTS)
    .rotate() // honour EXIF orientation so portraits don't render sideways
    .resize(sizePx, sizePx, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality, mozjpeg: true })
    .toBuffer();
  await writeFile(tmp, buf);
  await rename(tmp, thumbPath);
  return true;
}
