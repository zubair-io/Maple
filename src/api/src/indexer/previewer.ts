/**
 * 1280-px preview generation — the single canonical preview tier (the image
 * the Preview screen swaps in over the thumbnail while the full RAW loads)
 * AND the source artefact for the VLM describe / OCR pipeline.
 *
 * Sibling of `thumbnailer.ts`. The 512-px thumb is too small for reliable
 * caption / OCR on a 24-MP photo, so the describe stage consumes a
 * separate, larger artefact written here.
 *
 * Cache layout (see `fs/xmp.ts:cachePathFor` / `cachePathForAsset`):
 *   <folder>/.maple/previews/<original filename>.avif
 * ONE file per asset — no size token, no version token. It is a pure cache:
 * overwritten in place, never an original, always re-derivable (unedited =
 * the camera's embedded JPEG in the RAW; edited = re-render from RAW+XMP).
 * The 1280-px long edge is an internal render target, deliberately NOT in the
 * filename. Path-keyed (not `maple_id`-keyed, unlike thumbs) — see
 * `cachePathForAsset`'s doc for why. AVIF, not JPEG: every describe provider
 * hardcodes
 * `image/jpeg` as the media type it sends upstream (#1978), so `describe.ts`
 * decodes this file and re-encodes to JPEG in memory immediately before each
 * provider call rather than this tier persisting a second JPEG artefact.
 *
 * For RAW files: extracts the embedded preview via the existing FFI worker
 * pool at maxPx=1280, AVIF-encoded (the same generalized encode path the
 * 256px grid-thumbnail tier uses, just called with a larger `maxPx`). If the
 * embedded preview is smaller than 1280 the FFI hands back whatever the
 * camera embedded — acceptable for the VLM, which gracefully handles
 * smaller inputs.
 *
 * For non-RAW files: same sharp + heic-convert pipeline as the thumb path,
 * AVIF-encoded. PSD/PSB/HDR route through the same `ag-psd`/`hdr` decode +
 * sharp resize chain as `thumbnailer.ts` (see `thumbs/psd-hdr-decode.ts`).
 *
 * If libraw_ffi is unavailable (Linux without the .so), RAW previews are
 * logged as deferred and skipped — the rest of the pipeline still
 * advances; the describe stage will see no preview on disk and short-
 * circuit cleanly via its ENOENT path.
 */

import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { cachePathFor } from '../fs/xmp.ts';
import { ffiPool } from '../ffi/ffi-pool.ts';
import { SHARP_EXTENSIONS, PSD_HDR_EXTENSIONS } from '../fs/browse.ts';
import { isNoPreviewFilename } from './media-types.ts';
import { renderImageThumbToFileViaPool } from '../thumbs/imgdecode-pool.ts';
import { finalizeAvifRender } from '../thumbs/validate-avif.ts';
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

/** Extension suffix for `cachePathFor`/`cachePathForAsset`'s previews branch.
 * The preview is a single, unversioned AVIF per asset — no size token, no
 * version token — so the suffix is just the bare `avif` extension. Every
 * caller resolving this artefact's path uses this constant rather than
 * hard-coding `'avif'` itself. */
export const PREVIEW_CACHE_SUFFIX = 'avif';

let _rendered = 0;
let _cached = 0;
let _failed = 0;

/**
 * Generate (or refresh) the 1280-px unedited preview (AVIF) for an asset.
 *
 * `previewPathOverride` lets the caller supply a path-keyed cache path (e.g.
 * `<lib>/<fileinfo[0].path>/.maple/previews/<filename>.avif`, via
 * `cachePathForAsset`) instead of the legacy basename-keyed
 * `cachePathFor(absPath, "previews", PREVIEW_CACHE_SUFFIX)`. The legacy path
 * is only reachable when no asset row exists yet to resolve fileinfo from
 * (DB down, or a file `/api/fs/preview` is asked to preview before the
 * indexer has ever seen it) — see `routes/fs-previews.ts`'s `legacy()`.
 */
export async function generatePreview(
  absPath: string,
  previewPathOverride?: string,
): Promise<void> {
  const ext = path.extname(absPath).toLowerCase();
  const extNoDot = ext.startsWith('.') ? ext.slice(1) : ext;
  const previewPath =
    previewPathOverride ?? cachePathFor(absPath, 'previews', PREVIEW_CACHE_SUFFIX);

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
  if (await isPreviewCacheFresh(previewPath, absPath)) {
    _cached++;
    logTotals();
    return;
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

  // Encode to a private temp path first, not `previewPath` directly — a
  // completed-but-corrupt encode (codec edge case, resize bug) would
  // otherwise still get atomically written+renamed by the encoder itself,
  // landing at the cache path looking like a good entry. `finalizeAvifRender`
  // below decodes this temp file and only renames it to `previewPath` if it
  // passes; on any failure the temp file is removed, never `previewPath`.
  const tmpPath = `${previewPath}.tmp.${process.pid}.${randomBytes(8).toString('hex')}`;

  let renderOk: boolean;
  if (RAW_EXTS.has(ext)) {
    renderOk = await renderRawPreviewToFile(absPath, tmpPath);
  } else if (SHARP_EXTENSIONS.has(extNoDot) || PSD_HDR_EXTENSIONS.has(extNoDot)) {
    renderOk = await renderBitmapPreviewToFile(absPath, tmpPath, extNoDot);
  } else {
    // Unknown format — no decode path can produce a genuine AVIF from these
    // bytes, so there is nothing to write. A raw byte copy under a
    // `.avif`-labeled path would lie about the file's actual format —
    // the describe stage would then ship non-image bytes to the vision
    // model as if they were a real image, and the on-demand preview route
    // would serve them with `Content-Type: image/avif`. Skip; the describe
    // and preview-route handlers carry the same guard as defense in depth.
    _failed++;
    log.warn({ absPath }, 'skipped: unrecognized format, no preview generated');
    logTotals();
    return;
  }

  const ok = await finalizeAvifRender(renderOk, tmpPath, previewPath, PREVIEW_LONG_EDGE_PX, log, {
    assetPath: absPath,
    tier: 'preview',
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
 * Resolve where this asset's 1280-px preview lives on disk. Pure path
 * math — does not stat or guarantee the file exists.
 *
 * @deprecated Legacy absPath-keyed resolver. Callers should prefer
 * `cachePathForAsset(asset, libraries, 'previews', PREVIEW_CACHE_SUFFIX)` from
 * `fs/xmp.ts`, which composes the path from `(library_root, fileinfo[0].path,
 * fileinfo[0].filename)`. This one remains only for the no-asset-row
 * fallback case (see `generatePreview`'s doc).
 */
export function resolvePreviewPath(absPath: string): string {
  return cachePathFor(absPath, 'previews', PREVIEW_CACHE_SUFFIX);
}

/**
 * True when the cached preview at `previewPath` is fresh relative to its
 * source (`absPath`): the file exists, is non-empty, and is at least as new
 * as the source. This is the exact rule `generatePreview` uses internally to
 * short-circuit a rerun — exported so a caller can decide WHETHER to invoke
 * `generatePreview` at all before doing so, e.g. to gate an on-demand
 * concurrency limiter (`preview-ondemand-limiter.ts`) only around genuine
 * cache misses rather than every request (a warm read is two `stat` calls;
 * routing it through the limiter would make it queue behind unrelated
 * cold-cache regeneration work during a migration burst). One definition,
 * so the two call sites can never drift apart.
 */
export async function isPreviewCacheFresh(previewPath: string, absPath: string): Promise<boolean> {
  try {
    const [previewStat, srcStat] = await Promise.all([fs.stat(previewPath), fs.stat(absPath)]);
    return previewStat.size > 0 && previewStat.mtimeMs >= srcStat.mtimeMs;
  } catch {
    // missing preview, or source vanished — not fresh (and generatePreview
    // will no-op cleanly downstream if the source really is gone).
    return false;
  }
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

/** `outPath` is the caller's private temp path, not the final cache path —
 * `generatePreview` validates and renames into place. See its doc comment. */
async function renderRawPreviewToFile(rawPath: string, outPath: string): Promise<boolean> {
  const pool = ffiPool();
  if (!pool.available()) {
    log.warn(
      'raw-ffi not available — RAW preview generation deferred. Build the native/libraw_ffi.* (dylib on macOS, .so on Linux) with src/api/scripts/build-raw-ffi.sh.',
    );
    return false;
  }
  try {
    // quality 70 — this tier is both the client-facing "swap in over the
    // thumbnail" preview and (after describe.ts's in-memory JPEG re-encode)
    // the VLM's input, so it needs materially more fidelity than the 256px
    // grid-thumbnail tier's quality-55 AVIF, but AVIF's efficiency means it
    // doesn't need JPEG-equivalent-looking quality numbers to get there.
    return await pool.renderThumbnailAvifToFile(rawPath, outPath, PREVIEW_LONG_EDGE_PX, 70);
  } catch (e) {
    return logRenderFailure({ rawPath }, e, 'FFI call threw');
  }
  // Note: FFI path bakes orientation into pixels and emits a bare AVIF with
  // no EXIF. Bitmap paths (via imgdecode child) call sharp's .rotate() at
  // decode time. No inline orientation post-process needed — keeping sharp
  // out of worker-main's address space for isolation.
}

/** `outPath` is the caller's private temp path — see `renderRawPreviewToFile`. */
async function renderBitmapPreviewToFile(
  srcPath: string,
  outPath: string,
  ext: string,
): Promise<boolean> {
  try {
    // AVIF, quality 70 — matches the RAW path's rationale above.
    const result = await renderImageThumbToFileViaPool(
      srcPath,
      outPath,
      PREVIEW_LONG_EDGE_PX,
      70,
      ext,
      'avif',
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
