/**
 * OCR stage. Wraps `ocr-engine.ts` (Tesseract.js).
 *
 * Reads the cached thumbnail, runs OCR, and returns a patch containing
 * `ocr_text`, `ocr_words`, and `ocr_meta`. The patch is merged into the
 * image doc by the runtime — the old worker's aggregation-pipeline
 * `search_blob` recompute is now handled by the downstream `meili` stage
 * (which fans in all enrichment outputs and owns the Meilisearch write).
 *
 * Confidence gate: Tesseract happily hallucinates text on textureless
 * photos, which then poisons full-text search. We persist `ocr_text` only
 * when the engine's mean confidence clears `MAPLE_OCR_MIN_CONFIDENCE`
 * (default 60). Low-confidence runs still write `ocr_words` and
 * `mean_confidence` to `ocr_meta` so the threshold can be re-tuned without
 * re-running the engine.
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

/** Default mean-confidence floor for persisting `ocr_text`. Tesseract
 * scores 0–100; ~60 is the empirically-stable cutoff between "noisy real
 * text" and "garbage on a textureless photo". Operators can override at
 * the env level when triaging. */
const DEFAULT_MIN_CONFIDENCE = 60;

/** Default per-word confidence floor for persisting an entry in
 * `ocr_words`. Drops the long tail of single-character noise tokens a
 * blank photo can produce while still keeping the band of confidences
 * near the page-level gate so the threshold can be re-tuned later. Set
 * to 0 to disable. */
const DEFAULT_WORD_CONFIDENCE_FLOOR = 20;

function minConfidence(): number {
  return parsePositiveNumber(
    process.env.MAPLE_OCR_MIN_CONFIDENCE,
    DEFAULT_MIN_CONFIDENCE,
  );
}

function wordConfidenceFloor(): number {
  return parsePositiveNumber(
    process.env.MAPLE_OCR_WORD_CONFIDENCE_FLOOR,
    DEFAULT_WORD_CONFIDENCE_FLOOR,
  );
}

function parsePositiveNumber(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : fallback;
}

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
  const threshold = minConfidence();
  const wordFloor = wordConfidenceFloor();
  // Gate `ocr_text` (the field the search blob consumes) on mean
  // confidence. Words are persisted so the threshold can be re-tuned
  // later without re-OCRing, but filtered against `wordFloor` first so
  // a hallucination-heavy photo doesn't bloat the doc with hundreds of
  // zero-confidence noise tokens.
  const passesGate =
    out.mean_confidence !== null && out.mean_confidence >= threshold;
  const filteredWords = out.words.filter((w) => w.confidence >= wordFloor);
  return {
    patch: {
      ocr_text: passesGate ? out.text : "",
      ocr_words: filteredWords,
      ocr_meta: {
        engine: out.engine,
        engine_version: out.engine_version,
        generated_at: new Date().toISOString(),
        mean_confidence: out.mean_confidence,
      },
    },
  };
}

export default defineStage({
  name: "ocr",
  // v2: per-word confidence + mean-confidence gate on `ocr_text` — bump
  // so docs OCR'd before the gate landed re-run and have their garbage
  // text replaced with "" (and `ocr_words` populated for re-tuning).
  targetVersion: 2,
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
