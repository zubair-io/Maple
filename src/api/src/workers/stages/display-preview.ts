/**
 * display-preview stage — renders the DEVELOPED 1280px preview for an EDITED
 * asset (#1950), the self-hosted half of the fast-preview design's §3
 * "developed display preview" tier.
 *
 * Unlike the `preview` stage (which extracts the camera's *embedded* preview
 * and applies no adjustments), this runs the full raw-core develop with the
 * asset's XMP sidecar applied — via the new `maple_render_develop_jpeg_to_file`
 * FFI — so an edited asset's preview reflects its edits. Output stays JPEG
 * (unlike the unedited tier's AVIF — cross-platform sharing + format for this
 * developed/edited tier is deferred to its own follow-on epic):
 *   `<lib>/<fileinfo[0].path>/.maple/previews/<fileinfo[0].filename>.dev_<sidecar_ver>.jpg`
 * Path-keyed off `fileinfo[0]`, not `maple_id` (see `cachePathForAsset`'s doc).
 * The `sidecar_ver` in the filename is the doc's monotonic edit counter, so a
 * new edit renders a new file and orphans the old; the preview routes serve
 * the same `dev_<sidecar_ver>` name.
 *
 * Only edited assets (`has_xmp`) do any work — an unedited library skips every
 * asset terminally (skip advances the stage version, so it never re-claims),
 * incurring no develop cost. The XMP write route re-arms this stage
 * (`stages.display-preview.version = 0`) on each edit via `recordSidecarEdit`.
 *
 * dependsOn: ["exif"] — needs a located, oriented asset; matches `thumb`.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { assetAbsPath, assetPrimaryFileInfo } from '../../indexer/images.repo.ts';
import { cachePathForAsset, xmpSidecarPath } from '../../fs/xmp.ts';
import { isNoPreviewFilename } from '../../indexer/media-types.ts';
import { loadLibraryRoots } from '../../indexer/libraries.cache.ts';
import { ffiPool } from '../../ffi/ffi-pool.ts';
import {
  defineStage,
  runStage,
  type ImageDoc,
  type RunStageHandle,
  type StageResult,
} from '../run-stage.ts';

/** Long-edge target for the developed preview. Matches the embedded `preview`
 * stage's 1280 px (`previewer.PREVIEW_LONG_EDGE_PX`); defined locally rather
 * than imported to avoid a manifest → stage → previewer → browse → manifest
 * import cycle (the embedded stages tolerate that cycle; a new stage shouldn't
 * add another instance of it). */
const DISPLAY_PREVIEW_LONG_EDGE_PX = 1280;

/** Full size+extension suffix for a developed preview cache file, for
 * `cachePathForAsset`'s previews branch: `dev_<sidecar_ver>.jpg`. */
export function developedPreviewSizeKey(sidecarVer: number | undefined): string {
  return `dev_${sidecarVer ?? 0}.jpg`;
}

const displayPreviewStage = defineStage({
  name: 'display-preview',
  // v2 — path-keyed migration: previews moved off `maple_id`-keying onto
  // `fileinfo[0].filename` (format unchanged, still JPEG). Bump so every
  // edited asset re-renders at the new path.
  targetVersion: 2,
  dependsOn: ['exif'],
  // Reads the original RAW — an ENOENT means it vanished; the runner tags
  // `missing_since` for the missing-reaper.
  tagsMissingOnEnoent: true,
  // A non-ENOENT failure that survives retries means the develop can't
  // complete for this asset — park it so the pipeline stops retrying.
  tagsDamagedOnDeadLetter: true,
  defaults: {
    concurrency: 1,
    maxAttempts: 5,
    paused: false,
    // Runs by default: it only develops EDITED assets (has_xmp), so an
    // unedited library incurs no work, and the FFI dylib is a hard indexer
    // dependency already required by `thumb`/`preview`.
    pausedOnFirstBoot: false,
    last_seen_target_version: 0,
  },
  handler: async (image): Promise<StageResult> => {
    const doc = image as unknown as ImageDoc;
    const primary = assetPrimaryFileInfo(doc);
    if (primary && isNoPreviewFilename(primary.filename)) {
      return { skip: 'stub-file' };
    }

    // Only edited assets get a developed preview. Unedited → the embedded
    // 1280 preview (from the `preview` stage) is correct, so skip terminally.
    if (!image.has_xmp) {
      return { skip: 'unedited' };
    }

    const libs = await loadLibraryRoots();
    const absPath = assetAbsPath(image as never, libs);
    const devPath = cachePathForAsset(
      image as never,
      libs,
      'previews',
      developedPreviewSizeKey(image.sidecar_ver),
    );
    if (!absPath || !devPath) {
      return { skip: 'no-resolvable-location' };
    }

    // The sidecar path is the `.xmp` sibling of the original. `has_xmp` should
    // guarantee it exists, but tolerate a race (deleted between flag and run)
    // by developing neutral rather than failing.
    const sidecar = xmpSidecarPath(absPath);
    const xmpPath = (await fileExists(sidecar)) ? sidecar : null;

    await fs.mkdir(path.dirname(devPath), { recursive: true });

    // `renderDevelopJpegToFile` REJECTS on any render failure (an ENOENT on
    // the original is tagged `missing_since` by the runner via
    // `tagsMissingOnEnoent`; anything else propagates to the retry /
    // dead-letter path via `tagsDamagedOnDeadLetter`), so a plain await is
    // enough — there is no soft-false to inspect.
    await ffiPool().renderDevelopJpegToFile(
      absPath,
      xmpPath,
      devPath,
      DISPLAY_PREVIEW_LONG_EDGE_PX,
      85,
    );
    return { wrote: true };
  },
});

/** True iff `p` exists. Only ENOENT counts as "absent"; a permission/IO error
 * (EACCES/EPERM/EMFILE/…) is surfaced so the stage retries rather than
 * silently developing neutral over an edited asset's real sidecar. */
async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw e;
  }
}

export default displayPreviewStage;

export async function startDisplayPreviewStage(): Promise<RunStageHandle> {
  return runStage(displayPreviewStage);
}
