/**
 * Preview stage — generates the 1280-px JPEG used by the describe stage
 * (and any future VLM stages that need more pixels than the 512-px thumb).
 *
 * Delegates to `generatePreview` in `src/api/src/indexer/previewer.ts`.
 *
 * Cache-path resolution (post content-addressing migration PR 3):
 *   - if the image doc has both `maple_id` and `fileinfo[0]`, write to the
 *     content-addressed location: `<lib>/<fileinfo[0].path>/.maple/previews/
 *     <maple_id>_1280.jpg`;
 *   - otherwise fall back to the legacy basename-keyed location via
 *     `resolvePreviewPath(absPath)`. The cache-gc sweep retires legacy
 *     orphans on the next boot once the row is backfilled.
 *
 * dependsOn: ["thumb"]
 *   — chained on thumb so the FFI worker pool is already warm when this
 *     fires, and so a RAW with no embedded preview produces both artefacts
 *     (or neither) without an interleaving race.
 *
 * Not `pausedOnFirstBoot` — this is purely local file IO, free, and downstream
 * stages need it.
 */
import { generatePreview, resolvePreviewPath } from '../../indexer/previewer.ts';
import { cachePathForAsset } from '../../fs/xmp.ts';
import { assetAbsPath } from '../../indexer/images.repo.ts';
import { loadLibraryRoots } from '../../indexer/libraries.cache.ts';
import { PREVIEW_SIZE_KEY } from '../../indexer/previewer.ts';
import { defineStage, runStage, type RunStageHandle } from '../run-stage.ts';

const previewStage = defineStage({
  name: 'preview',
  targetVersion: 1,
  dependsOn: ['thumb'],
  defaults: {
    concurrency: 2,
    batchSize: 5,
    pollIntervalMs: 1000,
    maxAttempts: 5,
    paused: false,
    pausedOnFirstBoot: false,
    last_seen_target_version: 0,
  },
  handler: async (image) => {
    // loadLibraryRoots() reads the folders collection. A transient DB hiccup
    // (or a test environment without Mongo) must not break preview generation
    // — fall back to the legacy basename-keyed path and let cache-gc retire
    // any orphan on the next boot once the row is backfilled.
    let libs: ReadonlyMap<string, string>;
    try {
      libs = await loadLibraryRoots();
    } catch {
      libs = new Map();
    }
    const previewPath = cachePathForAsset(image as never, libs, 'previews', PREVIEW_SIZE_KEY);
    if (!previewPath) {
      const legacyAbs = image.abs_path as string;
      await generatePreview(legacyAbs);
      return { patch: { preview_path: resolvePreviewPath(legacyAbs) } };
    }
    const absPath = assetAbsPath(image as never, libs) ?? (image.abs_path as string);
    await generatePreview(absPath, previewPath);
    return { patch: { preview_path: previewPath } };
  },
});

export default previewStage;

export async function startPreviewStage(): Promise<RunStageHandle> {
  return runStage(previewStage);
}
