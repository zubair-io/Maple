/**
 * In-place AVIF orientation normalization. Reads the EXIF orientation tag;
 * if missing or `1`, returns without touching the file. Otherwise re-encodes
 * via sharp's `.rotate()` — which physically rotates the pixels and strips
 * the orientation tag — then atomically replaces the file.
 *
 * Defense-in-depth helper. The raw-ffi thumbnail path bakes the orientation
 * into pixels and emits a bare AVIF with no EXIF, so this call is normally
 * a no-op on FFI output; the bitmap path routes through sharp's `.rotate()`
 * at decode time, also bakes orientation, and likewise carries no tag. If
 * a future code path lands a thumb in `.maple/thumbs/` that still carries
 * an orientation tag, this catches it before it's served to the client.
 */

import { rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { THUMB_AVIF_QUALITY, THUMB_AVIF_EFFORT } from './render.ts';

export async function applyExifOrientationInPlace(thumbPath: string): Promise<void> {
  const meta = await sharp(thumbPath).metadata();
  if (!meta.orientation || meta.orientation === 1) return;

  const buf = await sharp(thumbPath)
    .rotate()
    .avif({ quality: THUMB_AVIF_QUALITY, effort: THUMB_AVIF_EFFORT })
    .toBuffer();
  const tmp = `${thumbPath}.${process.pid}.${randomUUID()}.rot.tmp`;
  try {
    await writeFile(tmp, buf);
    await rename(tmp, thumbPath);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}
