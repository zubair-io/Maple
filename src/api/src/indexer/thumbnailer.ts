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
 * For non-RAW files (JPEG / HEIC / etc): writes the source file straight
 * through to the thumb path. Browsers can decode-and-resize on the fly.
 * A future improvement could shell out to `sharp` for proper resizing,
 * but the v1 path here is "the thumbnail is a fully-decodable image at a
 * sensible size" — for JPEG, the file already IS that.
 *
 * If libraw_ffi is unavailable (Linux without the .so), RAW thumbs are
 * logged as deferred and skipped gracefully — the rest of the pipeline
 * still advances.
 */

import * as path from "node:path";
import * as fs from "node:fs/promises";
import { resolveThumbPath } from "../fs/xmp.ts";
import { ffiPool } from "../ffi/ffi-pool.ts";

const RAW_EXTS = new Set([
  ".dng", ".cr2", ".cr3", ".nef", ".arw", ".raf", ".orf", ".rw2",
  ".pef", ".srw", ".x3f", ".3fr", ".mef", ".erf", ".mrw",
]);

const THUMB_LONG_EDGE_PX = 512;

let _thumbsRendered = 0;
let _thumbsCached = 0;
let _thumbsFailed = 0;
let _thumbsCalled = 0;

export async function generateThumb(absPath: string): Promise<void> {
  _thumbsCalled++;
  if (_thumbsCalled <= 5 || _thumbsCalled % 50 === 0) {
    console.log(`[thumbnailer] call #${_thumbsCalled} absPath=${absPath}`);
  }

  const ext = path.extname(absPath).toLowerCase();
  const thumbPath = resolveThumbPath(absPath);
  const thumbDir = path.dirname(thumbPath);

  try {
    await fs.mkdir(thumbDir, { recursive: true });
  } catch (e) {
    _thumbsFailed++;
    console.warn(
      `[thumbnailer] mkdir failed dir=${thumbDir} err=${e instanceof Error ? e.message : e}`
    );
    return;
  }

  // Apple, Web, and the lazy fs-thumbs route all write to the same path —
  // don't clobber a thumb that already covers the source's mtime.
  try {
    const [thumbStat, srcStat] = await Promise.all([
      fs.stat(thumbPath),
      fs.stat(absPath),
    ]);
    if (thumbStat.size > 0 && thumbStat.mtimeMs >= srcStat.mtimeMs) {
      _thumbsCached++;
      logCounters();
      return;
    }
  } catch {
    // Thumb missing (or source vanished — that will fail downstream anyway).
  }

  const isRaw = RAW_EXTS.has(ext);
  if (_thumbsCalled <= 5) {
    console.log(`[thumbnailer] call #${_thumbsCalled} dispatch path=${isRaw ? "raw-ffi" : "copy"} thumbPath=${thumbPath}`);
  }

  const ok = isRaw
    ? await renderRawThumbToFile(absPath, thumbPath)
    : await copyImageAsThumb(absPath, thumbPath);

  if (ok) {
    _thumbsRendered++;
    console.log(`[thumbnailer] rendered ${thumbPath}`);
  } else {
    _thumbsFailed++;
    console.warn(`[thumbnailer] failed src=${absPath} thumb=${thumbPath} isRaw=${isRaw}`);
  }
  logCounters();
}

function logCounters(): void {
  const total = _thumbsRendered + _thumbsCached + _thumbsFailed;
  if (total > 0 && total % 50 === 0) {
    console.log(
      `[thumbnailer] totals — called=${_thumbsCalled} rendered=${_thumbsRendered} cached=${_thumbsCached} failed=${_thumbsFailed}`
    );
  }
}

/** RAW thumb via the off-thread FFI worker pool. Returns true on success.
 * The worker holds the synchronous bun:ffi call so the main HTTP thread
 * stays responsive during indexer bursts. */
async function renderRawThumbToFile(rawPath: string, thumbPath: string): Promise<boolean> {
  const pool = ffiPool();
  if (!pool.available()) {
    console.warn(
      "[thumbnailer] raw-ffi not available — RAW thumb generation deferred. " +
        "Build libraw_ffi.dylib with scripts/build-raw-ffi.sh."
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
      e instanceof Error ? e.message : e
    );
    return false;
  }
}

/**
 * For non-RAW formats, copy the source file as the thumb. Browsers will
 * downscale on the fly via `<img>` width — fine for the grid (the
 * justified-rows layout caps tile size), and avoids depending on a
 * native image resizer that's not in Bun's std lib today.
 *
 * TODO(thumb-resize): when we wire `sharp` or `@napi-rs/canvas`, replace
 * this with an actual long-edge=512 resize so the on-disk thumb stays
 * tiny.
 */
async function copyImageAsThumb(srcPath: string, thumbPath: string): Promise<boolean> {
  try {
    await fs.copyFile(srcPath, thumbPath);
    return true;
  } catch (e) {
    console.warn(
      "[thumbnailer] copy failed for",
      srcPath,
      e instanceof Error ? e.message : e
    );
    return false;
  }
}
