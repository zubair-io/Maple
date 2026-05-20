/**
 * Preview stage — generates the 1280-px JPEG used by the describe stage
 * (and any future VLM stages that need more pixels than the 512-px thumb).
 *
 * Delegates to `generatePreview` in `src/api/src/indexer/previewer.ts`.
 * The preview path is derived by `resolvePreviewPath` (a thin wrapper around
 * `cachePathFor(path, "previews", "1280")`) so any consumer can address
 * the file deterministically.
 *
 * dependsOn: ["thumb"]
 *   — chained on thumb so the FFI worker pool is already warm when this
 *     fires, and so a RAW with no embedded preview produces both artefacts
 *     (or neither) without an interleaving race.
 *
 * Not `pausedOnFirstBoot` — this is purely local file IO, free, and downstream
 * stages need it.
 */
import { generatePreview, resolvePreviewPath } from "../../indexer/previewer.ts";
import { defineStage, runStage, type RunStageHandle } from "../run-stage.ts";

const previewStage = defineStage({
  name: "preview",
  targetVersion: 1,
  dependsOn: ["thumb"],
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
    const absPath = image.abs_path as string;
    await generatePreview(absPath);
    return {
      patch: {
        preview_path: resolvePreviewPath(absPath),
      },
    };
  },
});

export default previewStage;

export async function startPreviewStage(): Promise<RunStageHandle> {
  return runStage(previewStage);
}
