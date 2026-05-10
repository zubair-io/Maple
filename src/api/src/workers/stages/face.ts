/**
 * Face-detection stage. Wraps the pure `face-detector.ts` ONNX module.
 *
 * Depends on `["thumb"]`. Concurrency 1 (ONNX session is single-threaded).
 * The handler reads the thumbnail from the cache path, runs RetinaFace +
 * MobileFaceNet, and returns the detected faces as a patch.
 *
 * `pausedOnFirstBoot: true` — the face stage downloads ONNX models on first
 * enable. Operators must explicitly unpause it from /settings/workers after
 * confirming their model directory / download URL. Default off matches the
 * previous `face_worker_enabled` default.
 *
 * When the thumbnail is missing (e.g. the thumb stage hasn't run yet, or the
 * file was deleted) the handler returns `{ skip: "thumb-missing" }` rather
 * than throwing. The runtime treats skip as success (bumps version, no retry)
 * so the stage does not consume retries on a non-retryable condition.
 *
 * The FaceDetector dependency is resolved from the module-level singleton
 * (`defaultFaceDetector()`) — not injected via ctx — so the handler is
 * type-compatible with `defineStage`'s `(image, ctx: StageContext) => ...`
 * contract.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { ImageDoc, StageContext, StageResult } from "../runtime/define-stage.ts";
import { defineStage } from "../runtime/define-stage.ts";
import { cachePathFor } from "../../fs/xmp.ts";
import {
  defaultFaceDetector,
  type DetectedFace,
} from "../../enrichment/face-detector.ts";
import type { AssetFaceDoc } from "../../db/schema.ts";

export const THUMB_MISSING_REASON = "thumb-missing";

export async function faceHandler(
  image: ImageDoc,
  _ctx: StageContext,
): Promise<StageResult> {
  const detector = defaultFaceDetector();
  const thumbPath = cachePathFor(image.abs_path as string, "thumbs");
  if (!existsSync(thumbPath)) {
    return { skip: `${THUMB_MISSING_REASON}: ${thumbPath}` };
  }
  const bytes = new Uint8Array(await readFile(thumbPath));
  const detections = await detector.detectFaces(bytes);
  if (detections.length === 0) {
    return { patch: { faces: [] } };
  }
  const faces: AssetFaceDoc[] = [];
  for (const det of detections) {
    const embedding = await detector.embedFace(bytes, det);
    faces.push(detectionToDoc(det, embedding));
  }
  return { patch: { faces } };
}

function detectionToDoc(det: DetectedFace, embedding: Float32Array): AssetFaceDoc {
  return {
    bbox: det.bbox,
    confidence: det.confidence,
    person_id: null,
    embedding: Array.from(embedding),
  };
}

export default defineStage({
  name: "face",
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
  handler: faceHandler,
});
