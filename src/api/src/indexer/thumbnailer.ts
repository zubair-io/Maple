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
 * For PSD / PSB (Photoshop) and Radiance HDR: first-pass decoded to a
 * flattened RGBA8 raster via `ag-psd` / `hdr` (see
 * `thumbs/psd-hdr-decode.ts`), then resized + JPEG-encoded through the same
 * sharp path as the bitmap formats above.
 *
 * If libraw_ffi is unavailable (Linux without the .so), RAW thumbs are
 * logged as deferred and skipped gracefully — the rest of the pipeline
 * still advances.
 */

import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { resolveThumbPath } from '../fs/xmp.ts';
import { ffiPool } from '../ffi/ffi-pool.ts';
import { SHARP_EXTENSIONS, PSD_HDR_EXTENSIONS } from '../fs/browse.ts';
import { isVideoFilename } from './media-types.ts';
import { renderImageThumbToFile } from '../thumbs/imgdecode-pool.ts';
import { child as childLogger } from '../log.ts';

const log = childLogger('thumbnailer');

const RAW_EXTS = new Set([
  '.dng',
  '.cr2',
  '.cr3',
  '.nef',
  '.arw',
  '.raf',
  '.orf',
  '.rw2',
  '.pef',
  '.srw',
  '.x3f',
  '.3fr',
  '.mef',
  '.erf',
  '.mrw',
  '.raw',
  '.fff',
]);

const THUMB_LONG_EDGE_PX = 512;

let _rendered = 0;
let _cached = 0;
let _failed = 0;

/**
 * Generate (or refresh) the on-disk thumbnail JPEG for an asset.
 *
 * `thumbPathOverride` lets the caller supply a content-addressed cache path
 * (e.g. `<lib>/<fileinfo[0].path>/.maple/thumbs/<maple_id>.jpg`) instead of
 * the legacy basename-keyed `resolveThumbPath(absPath)`. When undefined the
 * legacy path is used, preserving behaviour for callers that haven't been
 * swept to the new resolver yet.
 */
export async function generateThumb(absPath: string, thumbPathOverride?: string): Promise<void> {
  const ext = path.extname(absPath).toLowerCase();
  const extNoDot = ext.startsWith('.') ? ext.slice(1) : ext;
  const thumbPath = thumbPathOverride ?? resolveThumbPath(absPath);

  try {
    await fs.mkdir(path.dirname(thumbPath), { recursive: true });
  } catch (e) {
    _failed++;
    log.warn({ thumbPath, err: e instanceof Error ? e.message : e }, 'mkdir failed');
    logTotals();
    return;
  }

  // Apple, Web, and the lazy fs-thumbs route all write to the same path —
  // don't clobber a thumb that already covers the source's mtime.
  try {
    const [thumbStat, srcStat] = await Promise.all([fs.stat(thumbPath), fs.stat(absPath)]);
    if (thumbStat.size > 0 && thumbStat.mtimeMs >= srcStat.mtimeMs) {
      _cached++;
      logTotals();
      return;
    }
  } catch {
    // Thumb missing (or source vanished — that will fail downstream anyway).
  }

  // Video containers have no still frame — and the `copyImageAsThumb`
  // fall-through below would copy the raw .MOV/.MP4 bytes to `<id>.jpg`, which
  // the thumb route would then serve as 200 image/jpeg garbage. Bail before the
  // copy. Stage/route callers already skip videos; this is defense in depth so
  // no future caller can land video bytes in the thumb cache.
  if (isVideoFilename(absPath)) {
    _failed++;
    log.warn({ absPath }, 'skipped: video has no still frame to thumbnail');
    logTotals();
    return;
  }

  let ok = false;
  if (RAW_EXTS.has(ext)) {
    ok = await renderRawThumbToFile(absPath, thumbPath);
  } else if (SHARP_EXTENSIONS.has(extNoDot) || PSD_HDR_EXTENSIONS.has(extNoDot)) {
    ok = await renderBitmapThumbToFile(absPath, thumbPath, extNoDot);
  } else {
    // Unknown format — fall back to copy so something is at the path
    // (matches the prior behaviour for, e.g., a future format we haven't
    // taught sharp about yet).
    ok = await copyImageAsThumb(absPath, thumbPath);
  }

  if (ok) {
    _rendered++;
  } else {
    _failed++;
    log.warn({ absPath }, 'failed');
  }
  logTotals();
}

function logTotals(): void {
  const total = _rendered + _cached + _failed;
  if (total > 0 && total % 500 === 0) {
    log.info({ rendered: _rendered, cached: _cached, failed: _failed }, 'totals');
  }
}

/** RAW thumb via the off-thread FFI worker pool. Returns true on success.
 * The worker holds the synchronous bun:ffi call so the main HTTP thread
 * stays responsive during indexer bursts. */
async function renderRawThumbToFile(rawPath: string, thumbPath: string): Promise<boolean> {
  const pool = ffiPool();
  if (!pool.available()) {
    log.warn(
      'raw-ffi not available — RAW thumb generation deferred. Build libraw_ffi.dylib with scripts/build-raw-ffi.sh.',
    );
    return false;
  }
  try {
    return await pool.renderThumbnailJpegToFile(rawPath, thumbPath, THUMB_LONG_EDGE_PX, 82);
  } catch (e) {
    log.warn({ rawPath, err: e instanceof Error ? e.message : e }, 'FFI call threw');
    return false;
  }
  // Note: FFI path bakes orientation into pixels and emits a bare JPEG with
  // no EXIF. Bitmap paths (via imgdecode child) call sharp's .rotate() at
  // decode time. No inline orientation post-process needed — keeping sharp
  // out of worker-main's address space for isolation.
}

/**
 * Bitmap formats (JPEG / PNG / WEBP / TIFF / AVIF / HEIC / HEIF): decode
 * + resize via the imgdecode child pool (sharp + heic-convert in an isolated
 * process). Same output as the live `/api/fs/thumb` route on a cache miss.
 */
async function renderBitmapThumbToFile(
  srcPath: string,
  thumbPath: string,
  ext: string,
): Promise<boolean> {
  try {
    const result = await renderImageThumbToFile(srcPath, thumbPath, THUMB_LONG_EDGE_PX, 82, ext);
    if (!result.ok) {
      log.warn(
        { srcPath, err: result.error ?? 'imgdecode failed' },
        'imgdecode child returned error',
      );
      return false;
    }
    return true;
  } catch (e) {
    log.warn({ srcPath, err: e instanceof Error ? e.message : e }, 'imgdecode pool threw');
    return false;
  }
}

/**
 * Last-resort copy for formats sharp doesn't know about. Keeps the prior
 * fallback so a future format addition doesn't silently drop on the floor
 * before we explicitly handle it.
 */
async function copyImageAsThumb(srcPath: string, thumbPath: string): Promise<boolean> {
  try {
    await fs.copyFile(srcPath, thumbPath);
    return true;
  } catch (e) {
    log.warn({ srcPath, err: e instanceof Error ? e.message : e }, 'copy failed');
    return false;
  }
}
