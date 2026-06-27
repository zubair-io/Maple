/**
 * Face-detection stage — the first half of the split-out face pipeline.
 *
 * Runs the SCRFD-10G detector against the cached thumbnail and writes one
 * face doc per detection: `{ bbox, landmarks, confidence, person_id: null,
 * hidden: false }`. It does NOT compute embeddings — that's the separate
 * `face-embed` stage, which depends on this one.
 *
 * Persisting `landmarks` is load-bearing: it lets `face-embed` reproduce
 * the exact aligned crop the detector produced, so a re-embed (triggered by
 * bumping `face-embed`'s targetVersion) never has to re-detect. Re-detecting
 * would shift bboxes and break the operator's manual `person_id`
 * assignments, which key off detection geometry (the faces-array index).
 *
 * Depends on `["thumb"]`. Concurrency 1 (ONNX session is single-threaded).
 *
 * `pausedOnFirstBoot: true` — detection downloads the SCRFD ONNX model on
 * first enable. Operators must explicitly unpause it from /settings/workers
 * after confirming their model directory / download URL.
 *
 * When the thumbnail is missing or undecodable the handler returns
 * `{ skip }` rather than throwing. The runtime treats skip as success
 * (bumps version, no retry) so the stage does not consume retries on a
 * non-retryable condition.
 *
 * The FaceDetector dependency is resolved from the module-level singleton
 * (`defaultFaceDetector()`) — not injected via ctx — so the handler is
 * type-compatible with `defineStage`'s `(image, ctx: StageContext) => ...`
 * contract.
 */

import type { ImageDoc, StageContext, StageResult } from '../run-stage.ts';
import { defineStage, runStage, type RunStageHandle } from '../run-stage.ts';
import {
  defaultFaceDetector,
  ThumbDecodeError,
  type DetectedFace,
} from '../../enrichment/face-detector.ts';
import type { AssetFaceDoc } from '../../db/schema.ts';
import {
  loadThumbBytes,
  THUMB_MISSING_REASON,
  THUMB_UNDECODABLE_REASON,
} from './face-stage-shared.ts';
import {
  loadEnrichmentConfig,
  resolveEnrichmentConfig,
} from '../../enrichment/enrichment-config.repo.ts';

export { THUMB_MISSING_REASON, THUMB_UNDECODABLE_REASON };

/** Reprocess target for `face-detect`. Bumping this re-queues every asset
 * whose stored detections are below it (the version-gated worker loop).
 *
 * v1 → v2: re-detect the back-catalog. Legacy faces from the old single
 * `face` stage carry SCRFD-500m boxes and NO landmarks (the legacy stage
 * never persisted them); re-running SCRFD-10G writes better boxes + the
 * 5-point landmarks `face-embed` needs for proper alignment. NOTE: this
 * rewrites the faces array, so `person_id` assignments reset to null —
 * a re-cluster is required afterward. Assets below this version (including
 * any legacy `face`-stage asset that lacks `face-detect` entirely)
 * reprocess through the normal loop. */
export const FACE_DETECT_TARGET_VERSION = 2;

export async function faceDetectHandler(image: ImageDoc, _ctx: StageContext): Promise<StageResult> {
  const detector = defaultFaceDetector();
  const loaded = await loadThumbBytes(image);
  if ('skip' in loaded) return loaded;

  let detections: DetectedFace[];
  try {
    detections = await detector.detectFaces(loaded.bytes);
  } catch (err) {
    if (err instanceof ThumbDecodeError) {
      return { skip: `${THUMB_UNDECODABLE_REASON}: ${err.message}` };
    }
    throw err;
  }

  // Read the size threshold at run time so an operator change (via
  // /settings/workers) takes effect on the next asset without a restart.
  const dbConfig = await loadEnrichmentConfig();
  const { face_min_detection_size: minSize } = resolveEnrichmentConfig(dbConfig);
  const filtered =
    minSize > 0 ? detections.filter((d) => Math.min(d.bbox.w, d.bbox.h) >= minSize) : detections;

  return { patch: { faces: filtered.map(detectionToDoc) } };
}

/** Detection → face doc. No embedding here — `face-embed` fills that in.
 * `landmarks` is persisted so the embed stage can align the crop without
 * re-detecting. `hidden: false` is written explicitly so the operator's
 * hide toggle has a definite starting state. */
function detectionToDoc(det: DetectedFace): AssetFaceDoc {
  return {
    bbox: det.bbox,
    landmarks: det.landmarks,
    confidence: det.confidence,
    person_id: null,
    hidden: false,
  };
}

const faceDetectStage = defineStage({
  name: 'face-detect',
  targetVersion: FACE_DETECT_TARGET_VERSION,
  // Require thumb at v2, not just >= 1. `thumb` is at targetVersion 2 (the
  // orientation fix); detecting against a stale v1 thumbnail would produce
  // boxes/landmarks on a mis-oriented image and never self-correct after
  // the thumb regenerates. Pinning the minVersion makes re-detect wait for
  // the corrected thumbnail.
  dependsOn: [{ name: 'thumb', minVersion: 2 }],
  defaults: {
    concurrency: 1,
    maxAttempts: 5,
    paused: false,
    last_seen_target_version: 0,
    pausedOnFirstBoot: true,
  },
  handler: faceDetectHandler,
});

export default faceDetectStage;

export async function startFaceDetectStage(): Promise<RunStageHandle> {
  return runStage(faceDetectStage);
}
