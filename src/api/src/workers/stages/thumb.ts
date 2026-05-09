/**
 * Thumb stage — generates the 512px JPEG thumbnail for an image.
 *
 * Delegates to `generateThumb` in `src/api/src/indexer/thumbnailer.ts`, which
 * is orientation-aware after Plan 0 (applyExifOrientationInPlace is wired into
 * the RAW path). The thumb path is derived by `resolveThumbPath` — the same
 * function the live /api/fs/thumb route uses so both paths write to the same
 * on-disk location.
 *
 * dependsOn: ["hash", "exif"]
 *   — thumb needs EXIF orientation to produce an upright image; hash must
 *     have run first so abs_path is confirmed reachable and sha1_head is set.
 */
import { generateThumb } from "../../indexer/thumbnailer.ts";
import { resolveThumbPath } from "../../fs/xmp.ts";
import { defineStage } from "../runtime/define-stage.ts";

export default defineStage({
  name: "thumb",
  targetVersion: 1,
  dependsOn: ["hash", "exif"],
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
    // generateThumb handles all format paths (RAW via FFI, bitmap via sharp,
    // unknown format via copy). It is a no-op when the thumb is already
    // up-to-date (mtime check inside).
    await generateThumb(absPath);
    return {
      patch: {
        thumb_path: resolveThumbPath(absPath),
      },
    };
  },
});
