/**
 * display-preview stage — renders the DEVELOPED 1280px preview for an EDITED
 * asset (#1950), the self-hosted half of the fast-preview design's §3
 * "developed display preview" tier.
 *
 * Unlike the `preview` stage (which extracts the camera's *embedded* JPEG and
 * applies no adjustments), this runs the full raw-core develop with the
 * asset's XMP sidecar applied — via the new `maple_render_develop_jpeg_to_file`
 * FFI — so an edited asset's preview reflects its edits. Output:
 *   `<lib>/<fileinfo[0].path>/.maple/previews/<maple_id>_dev_<sidecar_ver>.jpg`
 * The `sidecar_ver` in the filename is the doc's monotonic edit counter, so a
 * new edit renders a new file and orphans the old; the preview routes serve
 * the same `_dev_<sidecar_ver>` name.
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

/** Size-key stem for a developed preview cache file: `dev_<sidecar_ver>`. */
export function developedPreviewSizeKey(sidecarVer: number | undefined): string {
  return `dev_${sidecarVer ?? 0}`;
}

const displayPreviewStage = defineStage({
  name: 'display-preview',
  targetVersion: 1,
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

    const pool = ffiPool();
    // An ENOENT on the original is tagged `missing_since` by the runner
    // (`tagsMissingOnEnoent`); a soft render failure throws so the
    // retry/dead-letter path handles it (`tagsDamagedOnDeadLetter`).
    const ok = await pool.renderDevelopJpegToFile(
      absPath,
      xmpPath,
      devPath,
      DISPLAY_PREVIEW_LONG_EDGE_PX,
      85,
    );
    if (!ok) {
      throw new Error('display-preview: develop render failed');
    }
    return { wrote: true };
  },
});

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

export default displayPreviewStage;

export async function startDisplayPreviewStage(): Promise<RunStageHandle> {
  return runStage(displayPreviewStage);
}
