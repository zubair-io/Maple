/**
 * Bitmap thumbnail/validation dispatch onto the FFI child pool. Replaces the
 * retired `imgdecode-pool.ts` (#3499): the same child that owns the
 * Maple bindings for RAW now renders JPEG/PNG/WebP/TIFF/AVIF/HEIC/PSD/HDR too,
 * so there is one isolated native process family. Cache derivatives are
 * always AVIF; only paths and render settings cross IPC.
 */
import { ffiPool } from '../ffi/ffi-pool.ts';

/** The decoder refused the source bytes themselves (raw-core's `Error::Decode`,
 * whose message reads "rawler failed to decode …"). A property of the asset,
 * like `AuthoredSidecarRenderError`; a crashed child or a full disk is not. */
export class SourceDecodeError extends Error {
  override readonly name = 'SourceDecodeError';
  constructor(srcPath: string, reason: string) {
    super(`Cannot decode ${srcPath}: ${reason}`);
  }
}

/** raw-core's decode-stage `Error::Decode` reasons. Later stages (resize,
 * encode) reuse the same variant for internal faults, so the reason is
 * matched too rather than the variant's prefix alone. */
const SOURCE_REJECTED =
  /rawler failed to decode [^:]*: (jpeg |failed to decode raster pixels|cannot identify raster image format|bitmap dimensions )/;

/** Throw when a bitmap render failed because the decoder rejected the source. */
export function throwIfSourceRejected(
  result: { ok: boolean; error?: string },
  srcPath: string,
): void {
  if (!result.ok && result.error !== undefined && SOURCE_REJECTED.test(result.error)) {
    throw new SourceDecodeError(srcPath, result.error);
  }
}

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
