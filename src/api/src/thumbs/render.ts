/**
 * Bitmap-format thumbnail rendering — shared by `/api/fs/thumb` (live) and
 * the indexer's thumb stage. Decodes JPEG/PNG/WEBP/TIFF/AVIF/HEIC/HEIF and
 * writes a resized JPEG to `thumbPath` atomically (`.tmp` + rename).
 *
 * RAW formats are NOT handled here — those go through the libraw FFI worker
 * pool. Sharp's prebuilt libvips on Linux ships without libheif (libheif →
 * x265 GPL), so HEIC files take a detour through `heic-convert` first.
 */

import { readFile, rename, writeFile } from "node:fs/promises";
import sharp from "sharp";
import heicConvert from "heic-convert";

/** Extensions this module knows how to decode. Lowercase, no leading dot.
 * Mirrors the gate in `routes/fs-thumbs.ts` and the indexer's non-RAW
 * branch. */
export const SHARP_EXTENSIONS = new Set<string>([
  "jpg",
  "jpeg",
  "png",
  "webp",
  "gif",
  "tif",
  "tiff",
  "heic",
  "heif",
  "avif",
]);

/**
 * Render `srcPath` to `thumbPath` as a JPEG with the long edge ≤ `sizePx`.
 * Atomic: writes to `<thumbPath>.<pid>.tmp` first, then renames so a crash
 * mid-write never leaves a half-written cache file. Caller is responsible
 * for ensuring the parent directory exists.
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
  const tmp = `${thumbPath}.${process.pid}.tmp`;
  let pipeline: sharp.Sharp;
  if (ext === "heic" || ext === "heif") {
    const inputBuffer = await readFile(srcPath);
    // heic-convert → JPEG quality 0.9; subsequent sharp resize re-encodes
    // at quality 82 so the intermediate doesn't bloat the cache.
    const jpegBuffer = (await heicConvert({
      buffer: inputBuffer,
      format: "JPEG",
      quality: 0.9,
    })) as Buffer;
    pipeline = sharp(jpegBuffer, { failOn: "none" });
  } else {
    pipeline = sharp(srcPath, { failOn: "none" });
  }
  const buf = await pipeline
    .rotate() // honour EXIF orientation so portraits don't render sideways
    .resize(sizePx, sizePx, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 82, mozjpeg: true })
    .toBuffer();
  await writeFile(tmp, buf);
  await rename(tmp, thumbPath);
  return true;
}
