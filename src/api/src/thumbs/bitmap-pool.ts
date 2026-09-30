/**
 * Bitmap thumbnail/validation dispatch onto the FFI child pool. Replaces the
 * retired `imgdecode-pool.ts` (#3499): the same child that owns the
 * Maple bindings for RAW now renders JPEG/PNG/WebP/TIFF/AVIF/HEIC/PSD/HDR too,
 * so there is one isolated native process family. Cache derivatives are
 * always AVIF; only paths and render settings cross IPC.
 */
import { ffiPool } from '../ffi/ffi-pool.ts';

export function renderImageThumbToFileViaPool(
  srcPath: string,
  outPath: string,
  maxPx: number,
  quality: number,
  ext: string,
): Promise<{ ok: boolean; error?: string }> {
  return ffiPool().renderBitmapThumbToFile(srcPath, outPath, maxPx, quality, ext);
}

export function validateAvifViaPool(
  filePath: string,
  expectedLongEdgePx: number,
): Promise<{ ok: boolean; reason?: string }> {
  return ffiPool().validateAvif(filePath, expectedLongEdgePx);
}
