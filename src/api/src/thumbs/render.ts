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
import sharp from 'sharp';
import heicConvert from 'heic-convert';

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
 * via sharp (quality 82, mozjpeg) and write atomically.
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
): Promise<void> {
  const inputBuffer = await readFile(srcPath);
  // heic-convert → JPEG quality 0.9; subsequent sharp resize re-encodes
  // at quality 82 so the intermediate doesn't bloat the cache.
  const jpegBuffer = (await heicConvert({
    buffer: inputBuffer,
    format: 'JPEG',
    quality: 0.9,
  })) as Buffer;
  const buf = await sharp(jpegBuffer, SHARP_INPUT_OPTS)
    .rotate() // honour EXIF orientation so portraits don't render sideways
    .resize(sizePx, sizePx, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 82, mozjpeg: true })
    .toBuffer();
  const tmp = `${thumbPath}.${process.pid}.tmp`;
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
): Promise<boolean> {
  if (ext === 'heic' || ext === 'heif') {
    // Call the canonical HEIC chain directly. When render.ts is loaded inside
    // `imgdecode.child.ts` this is already an isolated process — no event-loop
    // blocking concern. The old Worker-thread indirection via heic-pool is gone.
    await renderHeicThumbToFile(srcPath, thumbPath, sizePx);
    return true;
  }

  const tmp = `${thumbPath}.${process.pid}.tmp`;
  const buf = await sharp(srcPath, SHARP_INPUT_OPTS)
    .rotate() // honour EXIF orientation so portraits don't render sideways
    .resize(sizePx, sizePx, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 82, mozjpeg: true })
    .toBuffer();
  await writeFile(tmp, buf);
  await rename(tmp, thumbPath);
  return true;
}
