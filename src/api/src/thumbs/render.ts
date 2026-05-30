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
 * I/O). On the main HTTP thread that freezes `/api/health` and every other
 * request for the whole decode. So the HEIC branch is routed through a Worker
 * pool (`heic-pool.ts`); the non-HEIC branch stays inline because sharp's
 * resize/encode already runs off-thread on the libvips threadpool.
 */

import { readFile, rename, writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import heicConvert from 'heic-convert';
import { decodeHeicThumbOffThread } from './heic-pool.ts';

/** Extensions this module knows how to decode. Lowercase, no leading dot.
 * Mirrors the gate in `routes/fs-thumbs.ts` and the indexer's non-RAW
 * branch. */
export const SHARP_EXTENSIONS = new Set<string>([
  'jpg',
  'jpeg',
  'png',
  'webp',
  'gif',
  'tif',
  'tiff',
  'heic',
  'heif',
  'avif',
]);

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
 * via sharp (quality 82, mozjpeg) and write atomically. Both the off-thread
 * worker (`heic.worker.ts`) and the in-process fallback in `heic-pool.ts`
 * call THIS function, so the two execution paths can never drift — moving the
 * decode off-thread is a timing change only, never a byte change.
 *
 * The large input buffer and intermediate JPEG stay local to whichever thread
 * runs this; only the small `{ ok }` result crosses `postMessage`.
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
 * HEIC/HEIF decode is dispatched to the Worker pool so the synchronous WASM
 * decode never blocks the HTTP event loop; all other formats are decoded
 * inline by sharp (already off-thread on the libvips threadpool). Both paths
 * write byte-identical output.
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
    // Off-thread: the libheif/WASM decode would otherwise freeze the loop
    // for ~500–2000 ms. The pool keeps the input buffer + intermediate JPEG
    // inside the worker; only `{ ok, error? }` crosses postMessage.
    const result = await decodeHeicThumbOffThread(srcPath, thumbPath, sizePx);
    if (!result.ok) {
      throw new Error(result.error ?? 'heic decode failed');
    }
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
