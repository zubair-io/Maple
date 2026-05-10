/**
 * OCR stage. Wraps `ocr-engine.ts` (Tesseract.js).
 *
 * Reads the cached thumbnail, runs OCR, and returns a patch containing
 * `ocr_text` and `ocr_meta`. The patch is merged into the image doc by the
 * runtime — the old worker's aggregation-pipeline `search_blob` recompute is
 * now handled by the downstream `meili` stage (which fans in all enrichment
 * outputs and owns the Meilisearch write).
 *
 * `pausedOnFirstBoot: true` — OCR was opt-in in the previous worker design.
 * Operators must explicitly unpause from /settings/workers.
 *
 * Error semantics:
 *   - ENOENT on the thumbnail is non-retryable: the thumb file is gone and
 *     retrying will not fix it. Returns `{ skip: "image-missing" }` so the
 *     runtime marks the stage done without consuming attempts.
 *   - All other errors (engine failures, corrupt input) are retried up to
 *     maxAttempts by the runtime's default error-handling path. Consider
 *     returning `{ skip: ... }` for known non-retryable conditions.
 *
 * The OcrEngine dependency is resolved from the module-level singleton
 * (`ocrEngine()`) — not injected via ctx — so the handler is type-compatible
 * with `defineStage`'s `(image, ctx: StageContext) => ...` contract.
 */

import { readFile } from "node:fs/promises";
import type { ImageDoc, StageContext, StageResult } from "../runtime/define-stage.ts";
import { defineStage } from "../runtime/define-stage.ts";
import { cachePathFor } from "../../fs/xmp.ts";
import { ocrEngine } from "../../enrichment/ocr-engine.ts";

export async function ocrHandler(
  image: ImageDoc,
  _ctx: StageContext,
): Promise<StageResult> {
  const engine = ocrEngine();
  const thumbPath = cachePathFor(image.abs_path as string, "thumbs");
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await readFile(thumbPath));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { skip: "image-missing" };
    }
    throw err;
  }
  const out = await engine.recognizeText(bytes);
  return {
    patch: {
      ocr_text: out.text,
      ocr_meta: {
        engine: out.engine,
        engine_version: out.engine_version,
        generated_at: new Date().toISOString(),
      },
    },
  };
}

export default defineStage({
  name: "ocr",
  targetVersion: 1,
  dependsOn: ["thumb"],
  defaults: {
    concurrency: 1,
    pollIntervalMs: 1000,
    batchSize: 5,
    maxAttempts: 5,
    paused: false,
    last_seen_target_version: 0,
    pausedOnFirstBoot: true,
  },
  handler: ocrHandler,
});
