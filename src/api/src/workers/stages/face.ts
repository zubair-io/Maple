/**
 * Face-detection stage. Wraps the pure `face-detector.ts` ONNX module.
 *
 * Depends on `["thumb"]`. Concurrency 1 (ONNX session is single-threaded).
 * The handler reads the thumbnail from the cache path, runs RetinaFace +
 * MobileFaceNet, and returns the detected faces as a patch.
 *
 * `THUMB_MISSING_REASON` is exported so tests can match the error tag without
 * coupling to the message format.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { ImageDoc, StageContext, StageResult } from "../runtime/define-stage.ts";
import { defineStage } from "../runtime/define-stage.ts";
import { cachePathFor } from "../../fs/xmp.ts";
import {
  defaultFaceDetector,
  type DetectedFace,
  type FaceDetector,
} from "../../enrichment/face-detector.ts";
import type { AssetFaceDoc } from "../../db/schema.ts";

export const THUMB_MISSING_REASON = "thumb-missing";

export async function faceHandler(
  image: ImageDoc,
  ctx: StageContext & { detector?: FaceDetector },
): Promise<StageResult> {
  const detector = ctx.detector ?? defaultFaceDetector();
  const thumbPath = cachePathFor(image.abs_path as string, "thumbs");
  if (!existsSync(thumbPath)) {
    throw new Error(`${THUMB_MISSING_REASON}: ${thumbPath}`);
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
    pausedOnFirstBoot: false,
  },
  handler: faceHandler,
});
