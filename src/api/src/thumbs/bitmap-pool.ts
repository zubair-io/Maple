/**
 * Bitmap thumbnail/validation dispatch onto the FFI child pool. Replaces the
 * retired `imgdecode-pool.ts` (#3499): the same child that owns the
 * Maple bindings for RAW now renders JPEG/PNG/WebP/TIFF/AVIF/HEIC/PSD/HDR too,
 * so there is one isolated native process family. Cache derivatives are
 * always AVIF; only paths and render settings cross IPC.
 */
import { ffiPool } from '../ffi/ffi-pool.ts';
import { throwIfPermanentSourceFailure } from './source-failure.ts';

/** Throw when a bitmap render failed because the decoder rejected the source. */
export async function throwIfSourceRejected(
  result: { ok: boolean; error?: string },
  srcPath: string,
): Promise<void> {
  if (!result.ok && result.error !== undefined) {
    await throwIfPermanentSourceFailure(result.error, srcPath);
  }
}

export function renderImageThumbToFileViaPool(
  srcPath: string,
  outPath: string,
  maxPx: number,
  quality: number,
  ext: string,
  applyCrop = false,
): Promise<{ ok: boolean; error?: string }> {
  return ffiPool().renderBitmapThumbToFile(srcPath, outPath, maxPx, quality, ext, applyCrop);
}

export function validateAvifViaPool(
  filePath: string,
  expectedLongEdgePx: number,
): Promise<{ ok: boolean; reason?: string }> {
  return ffiPool().validateAvif(filePath, expectedLongEdgePx);
}
