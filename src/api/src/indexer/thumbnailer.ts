/**
 * Thumbnail generation for the indexer thumb stage.
 *
 * For RAW files: delegates to `maple_render_thumbnail_avif_to_file` via
 * raw-ffi — extracts the embedded preview JPEG, downsamples, and writes an
 * AVIF directly to `<dir>/.maple/thumbs/<sha256_prefix16>.avif`. No buffer
 * crosses the `bun:ffi` boundary (Bun 1.3.x's `toBuffer`-backed Buffers
 * double-free during JSC GC and segfault the process — the older
 * `renderToRgb` pathway hit this every time the indexer touched its first RAW).
 *
 * For non-RAW files (JPEG / PNG / WEBP / TIFF / AVIF / HEIC): decodes via
 * sharp (and heic-convert for HEIC/HEIF) and writes a properly resized
 * 512px AVIF to the thumb path. Earlier versions copied the source file
 * straight through — that worked for JPGs (just oversized) but produced
 * un-renderable HEIC bytes with a `.jpg` extension.
 *
 * For PSD / PSB (Photoshop) and Radiance HDR: first-pass decoded to a
 * flattened RGBA8 raster via `ag-psd` / `hdr` (see
 * `thumbs/psd-hdr-decode.ts`), then resized + AVIF-encoded through the same
 * sharp path as the bitmap formats above.
 *
 * If libraw_ffi is unavailable (Linux without the .so), RAW thumbs are
 * logged as deferred and skipped gracefully — the rest of the pipeline
 * still advances.
 */

import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { resolveThumbPath } from '../fs/xmp.ts';
import { ffiPool } from '../ffi/ffi-pool.ts';
import { SHARP_EXTENSIONS, PSD_HDR_EXTENSIONS } from '../fs/browse.ts';
import { isUndecodableFilename, isVideoFilename } from './media-types.ts';
import { renderImageThumbToFileViaPool } from '../thumbs/imgdecode-pool.ts';
import { extractVideoPosterJpeg } from '../thumbs/video-poster.ts';
import { THUMB_AVIF_QUALITY } from '../thumbs/render.ts';
import { finalizeAvifRender } from '../thumbs/validate-avif.ts';
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
 * Generate (or refresh) the on-disk thumbnail AVIF for an asset.
 *
 * `thumbPathOverride` lets the caller supply a content-addressed cache path
 * (e.g. `<lib>/<fileinfo[0].path>/.maple/thumbs/<maple_id>.avif`) instead of
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

  // Metadata-only stub images (eip/braw/afphoto/ai) and audio have no still
  // frame — and the `copyImageAsThumb` fall-through below would copy the raw
  // source bytes to `<id>.avif`, which the thumb route would then serve as 200
  // image/avif garbage. Bail before the copy. Stage/route callers already skip
  // these; this is defense in depth so no future caller can land non-image
  // bytes in the thumb cache. Video is NOT bailed on here any more — it has a
  // real decode branch below (#1649).
  if (isUndecodableFilename(absPath)) {
    _failed++;
    log.warn({ absPath }, 'skipped: no still frame to thumbnail');
    logTotals();
    return;
  }

  // Encode to a private temp path first, not `thumbPath` directly — a
  // completed-but-corrupt encode (codec edge case, resize bug, or — for the
  // copy fallback below — bytes that were never AVIF at all) would otherwise
  // still land at the cache path looking like a good entry. `finalizeAvifRender`
  // decodes this temp file and only renames it to `thumbPath` if it passes;
  // on any failure the temp file is removed, never `thumbPath`.
  const tmpPath = `${thumbPath}.tmp.${process.pid}.${randomBytes(8).toString('hex')}`;

  const renderOk = await renderByFormat(absPath, ext, extNoDot, tmpPath);

  const ok = await finalizeAvifRender(renderOk, tmpPath, thumbPath, THUMB_LONG_EDGE_PX, log, {
    assetPath: absPath,
    tier: 'thumb',
  });

  if (ok) {
    _rendered++;
  } else {
    _failed++;
    log.warn({ absPath }, 'failed');
  }
  logTotals();
}

/**
 * Dispatch to the decode branch that can read `absPath`, writing an AVIF to
 * the caller's private temp path. Returns false if that branch couldn't
 * produce anything.
 *
 * Split out of `generateThumb` so that function stays focused on the
 * cache/publish lifecycle (freshness check, temp path, validate-then-publish,
 * counters) while format dispatch lives in one place. Adding the video branch
 * pushed the combined function past the complexity gate.
 */
async function renderByFormat(
  absPath: string,
  ext: string,
  extNoDot: string,
  tmpPath: string,
): Promise<boolean> {
  if (RAW_EXTS.has(ext)) return renderRawThumbToFile(absPath, tmpPath);
  if (isVideoFilename(absPath)) return renderVideoThumbToFile(absPath, tmpPath);
  if (SHARP_EXTENSIONS.has(extNoDot) || PSD_HDR_EXTENSIONS.has(extNoDot)) {
    return renderBitmapThumbToFile(absPath, tmpPath, extNoDot);
  }
  // Unknown format — fall back to copy so something is at the path (matches
  // the prior behaviour for, e.g., a future format we haven't taught sharp
  // about yet). Routed through the same validate-then-publish gate as every
  // other branch: a copied source that isn't actually a valid AVIF (the common
  // case, since this is the last-resort branch) fails validation and is
  // discarded rather than silently served.
  return copyImageAsThumb(absPath, tmpPath);
}

function logTotals(): void {
  const total = _rendered + _cached + _failed;
  if (total > 0 && total % 500 === 0) {
    log.info({ rendered: _rendered, cached: _cached, failed: _failed }, 'totals');
  }
}

/** RAW thumb via the off-thread FFI worker pool. Returns true on success.
 * The worker holds the synchronous bun:ffi call so the main HTTP thread
 * stays responsive during indexer bursts. `outPath` is the caller's private
 * temp path, not the final cache path — `generateThumb` validates and
 * renames into place. See its doc comment. */
async function renderRawThumbToFile(rawPath: string, outPath: string): Promise<boolean> {
  const pool = ffiPool();
  if (!pool.available()) {
    log.warn(
      'raw-ffi not available — RAW thumb generation deferred. Build libraw_ffi.dylib with scripts/build-raw-ffi.sh.',
    );
    return false;
  }
  try {
    return await pool.renderThumbnailAvifToFile(
      rawPath,
      outPath,
      THUMB_LONG_EDGE_PX,
      THUMB_AVIF_QUALITY,
    );
  } catch (e) {
    log.warn({ rawPath, err: e instanceof Error ? e.message : e }, 'FFI call threw');
    return false;
  }
  // Note: FFI path bakes orientation into pixels and emits a bare AVIF with
  // no EXIF. Bitmap paths (via imgdecode child) call sharp's .rotate() at
  // decode time. No inline orientation post-process needed — keeping sharp
  // out of worker-main's address space for isolation.
}

/**
 * Video containers: pull a poster frame out with ffmpeg, then hand the
 * resulting JPEG to the SAME imgdecode child pool every bitmap goes through
 * (#1649). Two hops rather than asking ffmpeg for a resized AVIF directly,
 * because this way the thumb's resize maths, AVIF encoder settings, quality,
 * and orientation handling are literally the bitmap path — there is no second
 * encoder whose output could drift from it, and a host whose ffmpeg lacks
 * libaom still produces a perfectly good thumbnail.
 *
 * Returns false when the host has no runnable ffmpeg, which the caller treats
 * as any other failed render: nothing is published. Stage callers check the
 * capability up front and skip instead, so reaching this with no ffmpeg means
 * an on-demand route request — a 404, which is what it was before #1649.
 *
 * `outPath` is the caller's private temp path — see `renderRawThumbToFile`.
 */
async function renderVideoThumbToFile(videoPath: string, outPath: string): Promise<boolean> {
  // Sibling of the caller's temp path, so it inherits the same
  // already-created directory and the same pid+random uniqueness.
  const posterPath = `${outPath}.poster.jpg`;
  try {
    if (!(await extractVideoPosterJpeg(videoPath, posterPath))) return false;
    return await renderBitmapThumbToFile(posterPath, outPath, 'jpg');
  } finally {
    // The intermediate is never the published artefact — drop it on every
    // path, including the success one.
    try {
      await fs.unlink(posterPath);
    } catch {
      /* extraction failed before writing, or already gone */
    }
  }
}

/**
 * Bitmap formats (JPEG / PNG / WEBP / TIFF / AVIF / HEIC / HEIF): decode
 * + resize via the imgdecode child pool (sharp + heic-convert in an isolated
 * process). Same output as the live `/api/fs/thumb` route on a cache miss.
 * `outPath` is the caller's private temp path — see `renderRawThumbToFile`.
 */
async function renderBitmapThumbToFile(
  srcPath: string,
  outPath: string,
  ext: string,
): Promise<boolean> {
  try {
    const result = await renderImageThumbToFileViaPool(
      srcPath,
      outPath,
      THUMB_LONG_EDGE_PX,
      THUMB_AVIF_QUALITY,
      ext,
    );
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
 * before we explicitly handle it. `outPath` is the caller's private temp
 * path — see `renderRawThumbToFile`. The copied bytes still have to clear
 * `publishValidatedAvif`'s decode gate, so a source that isn't actually a
 * valid AVIF is caught there rather than served.
 */
async function copyImageAsThumb(srcPath: string, outPath: string): Promise<boolean> {
  try {
    await fs.copyFile(srcPath, outPath);
    return true;
  } catch (e) {
    log.warn({ srcPath, err: e instanceof Error ? e.message : e }, 'copy failed');
    return false;
  }
}
