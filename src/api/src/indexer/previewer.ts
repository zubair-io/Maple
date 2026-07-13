/**
 * 1280-px preview generation for the VLM describe / OCR pipeline.
 *
 * Sibling of `thumbnailer.ts`. The 512-px thumb is too small for reliable
 * caption / OCR on a 24-MP photo, so the describe stage consumes a
 * separate, larger artefact written here.
 *
 * Cache layout (see `fs/xmp.ts:cachePathFor`):
 *   <folder>/.maple/previews/<basename_no_ext>_1280.jpg
 *
 * For RAW files: extracts the embedded preview JPEG via the existing FFI
 * worker pool at maxPx=1280. If the embedded preview is smaller than
 * 1280 the FFI hands back whatever the camera embedded — acceptable for
 * the VLM, which gracefully handles smaller inputs.
 *
 * For non-RAW files: same sharp + heic-convert pipeline as the thumb path.
 * PSD/PSB/HDR route through the same `ag-psd`/`hdr` decode + sharp resize
 * chain as `thumbnailer.ts` (see `thumbs/psd-hdr-decode.ts`).
 *
 * If libraw_ffi is unavailable (Linux without the .so), RAW previews are
 * logged as deferred and skipped — the rest of the pipeline still
 * advances; the describe stage will see no preview on disk and short-
 * circuit cleanly via its ENOENT path.
 */

import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { cachePathFor } from '../fs/xmp.ts';
import { ffiPool } from '../ffi/ffi-pool.ts';
import { SHARP_EXTENSIONS, PSD_HDR_EXTENSIONS } from '../fs/browse.ts';
import { isNoPreviewFilename } from './media-types.ts';
import { renderImageThumbToFileViaPool } from '../thumbs/imgdecode-pool.ts';
import { child as childLogger } from '../log.ts';

const log = childLogger('previewer');

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

/** Long-edge target in pixels. Picked to balance VLM accuracy against
 * decode + inference cost — qwen2.5-vl handles up to 4 MP natively but
 * 1280 is the empirical sweet spot for caption quality on 24-MP source
 * photos at the cost of ~10 s/image on phoebe. */
export const PREVIEW_LONG_EDGE_PX = 1280;

/** Size key embedded in the cache filename. Stable so the GC sweep and
 * cache-invalidation paths can address the file deterministically. */
export const PREVIEW_SIZE_KEY = '1280';

let _rendered = 0;
let _cached = 0;
let _failed = 0;

/**
 * Generate (or refresh) the 1280-px preview JPEG for an asset.
 *
 * `previewPathOverride` lets the caller supply a content-addressed cache path
 * (e.g. `<lib>/<fileinfo[0].path>/.maple/previews/<maple_id>_1280.jpg`)
 * instead of the legacy basename-keyed `cachePathFor(absPath, "previews",
 * "1280")`. When undefined the legacy path is used, preserving behaviour for
 * callers that haven't been swept to the new resolver yet.
 */
export async function generatePreview(
  absPath: string,
  previewPathOverride?: string,
): Promise<void> {
  const ext = path.extname(absPath).toLowerCase();
  const extNoDot = ext.startsWith('.') ? ext.slice(1) : ext;
  const previewPath = previewPathOverride ?? cachePathFor(absPath, 'previews', PREVIEW_SIZE_KEY);

  try {
    await fs.mkdir(path.dirname(previewPath), { recursive: true });
  } catch (e) {
    _failed++;
    log.warn({ previewPath, err: e instanceof Error ? e.message : e }, 'mkdir failed');
    logTotals();
    return;
  }

  // Stale-check: if the cached preview's mtime is >= the source's, reuse it.
  // Matches the thumb-stage convention so a rerun is cheap.
  try {
    const [previewStat, srcStat] = await Promise.all([fs.stat(previewPath), fs.stat(absPath)]);
    if (previewStat.size > 0 && previewStat.mtimeMs >= srcStat.mtimeMs) {
      _cached++;
      logTotals();
      return;
    }
  } catch {
    // missing or source vanished — proceed (downstream stages will skip if needed)
  }

  // Video containers, metadata-only stub images (eip/braw/afphoto/ai), and
  // audio have no still frame — the `copyImageAsPreview` fall-through below
  // would otherwise copy the raw source bytes to a `.jpg`-named preview,
  // which the describe stage would then ship to the vision model as if it
  // were a real image. Bail before the copy; the describe/preview stage
  // handlers carry the same guard as defense in depth.
  if (isNoPreviewFilename(absPath)) {
    _failed++;
    log.warn({ absPath }, 'skipped: no still frame to preview');
    logTotals();
    return;
  }

  let ok = false;
  if (RAW_EXTS.has(ext)) {
    ok = await renderRawPreviewToFile(absPath, previewPath);
  } else if (SHARP_EXTENSIONS.has(extNoDot) || PSD_HDR_EXTENSIONS.has(extNoDot)) {
    ok = await renderBitmapPreviewToFile(absPath, previewPath, extNoDot);
  } else {
    // Unknown format — copy as-is so the describe stage has something to
    // open. Same last-resort behaviour as the thumb path.
    ok = await copyImageAsPreview(absPath, previewPath);
  }

  if (ok) {
    _rendered++;
  } else {
    _failed++;
    log.warn({ absPath }, 'failed');
  }
  logTotals();
}

/**
 * Resolve where this asset's 1280-px preview lives on disk. Pure path
 * math — does not stat or guarantee the file exists.
 *
 * @deprecated Legacy absPath-keyed resolver. Callers must migrate to
 * `cachePathForAsset(asset, libraries, 'previews', '1280')` from `fs/xmp.ts`,
 * which composes the path from `(library_root, fileinfo[0].path, maple_id)`.
 * Scheduled for removal in plan-PR-6 of the content-addressing migration,
 * once the legacy basename-hash fallback retires.
 */
export function resolvePreviewPath(absPath: string): string {
  return cachePathFor(absPath, 'previews', PREVIEW_SIZE_KEY);
}

function logTotals(): void {
  const total = _rendered + _cached + _failed;
  if (total > 0 && total % 500 === 0) {
    log.info({ rendered: _rendered, cached: _cached, failed: _failed }, 'totals');
  }
}

/** Shared by every render-branch catch block below: log the failure with
 * context + a normalized error message, then return `false` so the caller
 * can `return logRenderFailure(...)` in one line. */
function logRenderFailure(context: Record<string, unknown>, err: unknown, label: string): false {
  log.warn({ ...context, err: err instanceof Error ? err.message : err }, label);
  return false;
}

async function renderRawPreviewToFile(rawPath: string, previewPath: string): Promise<boolean> {
  const pool = ffiPool();
  if (!pool.available()) {
    log.warn(
      'raw-ffi not available — RAW preview generation deferred. Build the native/libraw_ffi.* (dylib on macOS, .so on Linux) with src/api/scripts/build-raw-ffi.sh.',
    );
    return false;
  }
  try {
    // quality 85 (vs 55 for AVIF thumbs) — preview is consumed by a VLM, not
    // the browser cache, so extra fidelity outweighs the few-KB size delta.
    // JPEG (not the grid-thumbnail tier's AVIF): every describe provider
    // hardcodes `image/jpeg` as the media type it sends upstream (#1978).
    return await pool.renderThumbnailPreviewJpegToFile(
      rawPath,
      previewPath,
      PREVIEW_LONG_EDGE_PX,
      85,
    );
  } catch (e) {
    return logRenderFailure({ rawPath }, e, 'FFI call threw');
  }
  // Note: FFI path bakes orientation into pixels and emits a bare JPEG with
  // no EXIF. Bitmap paths (via imgdecode child) call sharp's .rotate() at
  // decode time. No inline orientation post-process needed — keeping sharp
  // out of worker-main's address space for isolation.
}

async function renderBitmapPreviewToFile(
  srcPath: string,
  previewPath: string,
  ext: string,
): Promise<boolean> {
  try {
    // JPEG (not the grid-thumbnail tier's AVIF): every describe provider
    // hardcodes `image/jpeg` as the media type it sends upstream (#1978).
    // quality 82 — the VLM consumes the preview at whatever quality the
    // source encodes; additional fidelity does not measurably affect
    // caption accuracy and is not worth the extra bytes.
    const result = await renderImageThumbToFileViaPool(
      srcPath,
      previewPath,
      PREVIEW_LONG_EDGE_PX,
      82,
      ext,
      'jpeg',
    );
    if (!result.ok) {
      return logRenderFailure(
        { srcPath },
        result.error ?? 'imgdecode failed',
        'imgdecode child returned error',
      );
    }
    return true;
  } catch (e) {
    return logRenderFailure({ srcPath }, e, 'imgdecode pool threw');
  }
}

async function copyImageAsPreview(srcPath: string, previewPath: string): Promise<boolean> {
  try {
    await fs.copyFile(srcPath, previewPath);
    return true;
  } catch (e) {
    return logRenderFailure({ srcPath }, e, 'copy fallback failed');
  }
}
