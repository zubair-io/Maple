/**
 * Thumbnail generation for the indexer thumb stage.
 *
 * For RAW files: delegates to `maple_render_thumbnail_jpeg_to_file` via
 * raw-ffi — extracts the embedded preview JPEG and writes it directly to
 * `<dir>/.maple/thumbs/<sha256_prefix16>.jpg`. No buffer crosses the
 * `bun:ffi` boundary (Bun 1.3.x's `toBuffer`-backed Buffers double-free
 * during JSC GC and segfault the process — the older `renderToRgb`
 * pathway hit this every time the indexer touched its first RAW).
 *
 * For non-RAW files (JPEG / PNG / WEBP / TIFF / AVIF / HEIC): decodes via
 * sharp (and heic-convert for HEIC/HEIF) and writes a properly resized
 * 512px JPEG to the thumb path. Earlier versions copied the source file
 * straight through — that worked for JPGs (just oversized) but produced
 * un-renderable HEIC bytes with a `.jpg` extension.
 *
 * If libraw_ffi is unavailable (Linux without the .so), RAW thumbs are
 * logged as deferred and skipped gracefully — the rest of the pipeline
 * still advances.
 */

import * as path from "node:path";
import * as fs from "node:fs/promises";
import { resolveThumbPath, ensureMapleDir } from "../fs/xmp.ts";
import { ffiPool } from "../ffi/ffi-pool.ts";
import { renderImageThumbToFile, SHARP_EXTENSIONS } from "../thumbs/render.ts";

const RAW_EXTS = new Set([
  ".dng",
  ".cr2",
  ".cr3",
  ".nef",
  ".arw",
  ".raf",
  ".orf",
  ".rw2",
  ".pef",
  ".srw",
  ".x3f",
  ".3fr",
  ".mef",
  ".erf",
  ".mrw",
]);

const THUMB_LONG_EDGE_PX = 512;

export async function generateThumb(absPath: string): Promise<void> {
  const ext = path.extname(absPath).toLowerCase();
  const extNoDot = ext.startsWith(".") ? ext.slice(1) : ext;
  const thumbPath = resolveThumbPath(absPath);
  await ensureMapleDir(path.dirname(absPath));

  // Apple, Web, and the lazy fs-thumbs route all write to the same path —
  // don't clobber a thumb that already covers the source's mtime.
  try {
    const [thumbStat, srcStat] = await Promise.all([
      fs.stat(thumbPath),
      fs.stat(absPath),
    ]);
    if (thumbStat.size > 0 && thumbStat.mtimeMs >= srcStat.mtimeMs) return;
  } catch {
    // Thumb missing (or source vanished — that will fail downstream anyway).
  }

  let ok = false;
  if (RAW_EXTS.has(ext)) {
    ok = await renderRawThumbToFile(absPath, thumbPath);
  } else if (SHARP_EXTENSIONS.has(extNoDot)) {
    ok = await renderBitmapThumbToFile(absPath, thumbPath, extNoDot);
  } else {
    // Unknown format — fall back to copy so something is at the path
    // (matches the prior behaviour for, e.g., a future format we haven't
    // taught sharp about yet).
    ok = await copyImageAsThumb(absPath, thumbPath);
  }

  if (!ok) {
    console.warn(
      `[thumbnailer] skipped ${path.basename(absPath)}: could not generate thumb`,
    );
  }
}

/** RAW thumb via the off-thread FFI worker pool. Returns true on success.
 * The worker holds the synchronous bun:ffi call so the main HTTP thread
 * stays responsive during indexer bursts. */
async function renderRawThumbToFile(
  rawPath: string,
  thumbPath: string,
): Promise<boolean> {
  const pool = ffiPool();
  if (!pool.available()) {
    console.warn(
      "[thumbnailer] raw-ffi not available — RAW thumb generation deferred. " +
        "Build libraw_ffi.dylib with scripts/build-raw-ffi.sh.",
    );
    return false;
  }
  try {
    return await pool.renderThumbnailJpegToFile(
      rawPath,
      thumbPath,
      THUMB_LONG_EDGE_PX,
      82,
    );
  } catch (e) {
    console.warn(
      "[thumbnailer] FFI call threw for",
      rawPath,
      e instanceof Error ? e.message : e,
    );
    return false;
  }
}

/**
 * Bitmap formats (JPEG / PNG / WEBP / TIFF / AVIF / HEIC / HEIF): decode
 * + resize via the shared sharp + heic-convert pipeline. Same code path
 * the live `/api/fs/thumb` route uses on a cache miss, so the on-disk
 * thumb is identical regardless of which subsystem produced it first.
 */
async function renderBitmapThumbToFile(
  srcPath: string,
  thumbPath: string,
  ext: string,
): Promise<boolean> {
  try {
    return await renderImageThumbToFile(
      srcPath,
      thumbPath,
      THUMB_LONG_EDGE_PX,
      ext,
    );
  } catch (e) {
    console.warn(
      "[thumbnailer] sharp render failed for",
      srcPath,
      e instanceof Error ? e.message : e,
    );
    return false;
  }
}

/**
 * Last-resort copy for formats sharp doesn't know about. Keeps the prior
 * fallback so a future format addition doesn't silently drop on the floor
 * before we explicitly handle it.
 */
async function copyImageAsThumb(
  srcPath: string,
  thumbPath: string,
): Promise<boolean> {
  try {
    await fs.copyFile(srcPath, thumbPath);
    return true;
  } catch (e) {
    console.warn(
      "[thumbnailer] copy failed for",
      srcPath,
      e instanceof Error ? e.message : e,
    );
    return false;
  }
}
