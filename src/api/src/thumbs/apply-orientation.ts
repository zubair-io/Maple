/**
 * In-place JPEG orientation normalization. Reads the EXIF orientation tag;
 * if missing or `1`, returns without touching the file. Otherwise re-encodes
 * via sharp's `.rotate()` — which physically rotates the pixels and strips
 * the orientation tag — then atomically replaces the file.
 *
 * Used after the libraw FFI extracts an embedded preview JPEG: the FFI
 * preserves the source's orientation tag rather than baking the rotation
 * into pixels, so without this step a portrait shot ends up sideways on
 * disk while the bitmap path (which routes through sharp's `.rotate()` at
 * decode time) renders upright. This helper closes that gap so both paths
 * produce byte-equivalent thumbs in `.maple/thumbs/`.
 */

import { rename, writeFile } from "node:fs/promises";
import sharp from "sharp";

export async function applyExifOrientationInPlace(
  jpegPath: string,
): Promise<void> {
  const meta = await sharp(jpegPath).metadata();
  if (!meta.orientation || meta.orientation === 1) return;

  const buf = await sharp(jpegPath)
    .rotate()
    .jpeg({ quality: 82, mozjpeg: true })
    .toBuffer();
  const tmp = `${jpegPath}.${process.pid}.rot.tmp`;
  await writeFile(tmp, buf);
  await rename(tmp, jpegPath);
}
