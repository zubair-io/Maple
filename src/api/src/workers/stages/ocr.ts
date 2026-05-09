/**
 * OCR stage. Wraps `ocr-engine.ts` (Tesseract.js).
 *
 * Reads the cached thumbnail, runs OCR, and returns a patch containing
 * `ocr_text` and `ocr_meta`. The patch is merged into the image doc by the
 * runtime — the old worker's aggregation-pipeline `search_blob` recompute is
 * now handled by the downstream `meili` stage (which fans in all enrichment
 * outputs and owns the Meilisearch write).
 *
 * ENOENT on the thumbnail propagates as-is; the runtime classifies it as
 * retryable (filesystem transient) per the existing `isRetryable` semantics in
 * `ocr-worker.ts`. Engine throws propagate as non-retryable (bad-input die path).
 */

import { readFile } from "node:fs/promises";
import type { ImageDoc, StageContext, StageResult } from "../runtime/define-stage.ts";
import { defineStage } from "../runtime/define-stage.ts";
import { cachePathFor } from "../../fs/xmp.ts";
import { ocrEngine, type OcrEngine } from "../../enrichment/ocr-engine.ts";

export async function ocrHandler(
  image: ImageDoc,
  ctx: StageContext & { engine?: OcrEngine },
): Promise<StageResult> {
  const engine = ctx.engine ?? ocrEngine();
  const thumbPath = cachePathFor(image.abs_path as string, "thumbs");
  const bytes = new Uint8Array(await readFile(thumbPath));
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
    pausedOnFirstBoot: false,
  },
  handler: ocrHandler,
});
