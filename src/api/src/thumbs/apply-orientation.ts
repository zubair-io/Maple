/**
 * In-place AVIF orientation normalization. Reads the orientation tag Maple's
 * metadata probe reports for `thumbPath`; if missing or `1`, returns without
 * touching the file. Otherwise re-encodes via Maple's `.rotate()` — which
 * physically rotates the pixels and strips the orientation tag — then
 * atomically replaces the file.
 *
 * Defense-in-depth helper. The raw-ffi thumbnail path bakes the orientation
 * into pixels and emits a bare AVIF with no EXIF, so this call is normally
 * a no-op on FFI output; the bitmap path routes through Maple's `.rotate()`
 * at decode time, also bakes orientation, and likewise carries no tag. If
 * a future code path lands a thumb in `.maple/thumbs/` that still carries
 * an orientation tag, this catches it before it's served to the client.
 *
 * Maple's AVIF probe now reads the real container transform (#3507) and
 * reports `orientation: undefined` whenever the file carries no EXIF
 * Orientation item — which is every AVIF this pipeline writes, since it
 * bakes rotation into pixels and never writes that item. The "missing or 1"
 * no-op branch above is still guaranteed to fire for every real call site
 * today (they only ever pass a `.maple/thumbs/*.avif` path); this stays
 * defence-in-depth for a future code path that lands a thumb still carrying
 * a real tag.
 */

import { maple } from 'maple';
import { THUMB_AVIF_QUALITY, THUMB_AVIF_EFFORT } from './render.ts';

/** In-place AVIF orientation normalisation (no-op when the tag is absent or 1). */
export async function applyExifOrientationInPlace(thumbPath: string): Promise<void> {
  await maple(thumbPath)
    .toFormat('avif', { quality: THUMB_AVIF_QUALITY, effort: THUMB_AVIF_EFFORT })
    .normalizeOrientationInPlace();
}
