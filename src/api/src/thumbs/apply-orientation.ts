/**
 * In-place AVIF orientation normalization. Reads the EXIF orientation tag;
 * if missing or `1`, returns without touching the file. Otherwise re-encodes
 * via Maple's `.rotate()` — which physically rotates the pixels and strips
 * the orientation tag — then atomically replaces the file.
 *
 * Defense-in-depth helper. The raw-ffi thumbnail path bakes the orientation
 * into pixels and emits a bare AVIF with no EXIF, so this call is normally
 * a no-op on FFI output; the bitmap path routes through Maple's `.rotate()`
 * at decode time, also bakes orientation, and likewise carries no tag. If
 * a future code path lands a thumb in `.maple/thumbs/` that still carries
 * an orientation tag, this catches it before it's served to the client.
 */

import { maple } from 'maple';
import { THUMB_AVIF_QUALITY, THUMB_AVIF_EFFORT } from './render.ts';

/** In-place AVIF orientation normalisation (no-op when the tag is absent or 1). */
export async function applyExifOrientationInPlace(thumbPath: string): Promise<void> {
  await maple(thumbPath)
    .toFormat('avif', { quality: THUMB_AVIF_QUALITY, effort: THUMB_AVIF_EFFORT })
    .normalizeOrientationInPlace();
}
