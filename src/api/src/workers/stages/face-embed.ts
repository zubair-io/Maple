/**
 * Face-embedding stage — the second half of the split-out face pipeline.
 *
 * Depends on `["face-detect"]`. For every face the detector found, runs the
 * ArcFace R100 recognizer using the STORED bbox + landmarks (it does NOT
 * re-detect) and writes back `embedding` + `embedding_version` on that face,
 * keyed by array index (`faces.<i>.embedding`). Per-index `$set` patches
 * leave `bbox` / `landmarks` / `confidence` / `person_id` / `hidden`
 * untouched, so the operator's manual `person_id` assignments survive a
 * re-embed.
 *
 * A model swap is now just "bump this stage's targetVersion": the worker
 * re-embeds every face through the normal version-gated loop, detection
 * output is preserved, and /settings/workers shows progress for free. This
 * replaces the bespoke `POST /api/admin/re-embed-faces` admin endpoint +
 * `reEmbedFaces` job that held an HTTP connection open for minutes.
 *
 * Concurrency 1 (ONNX session is single-threaded). `pausedOnFirstBoot:
 * true` to match `face-detect` — the recognizer ONNX model downloads on
 * first enable.
 *
 * Skip / throw semantics mirror the detector stage: a missing or
 * undecodable thumbnail skips (non-retryable); transient errors throw so
 * the runtime's retry/backoff path handles them.
 *
 * The FaceDetector dependency is resolved from the module-level singleton
 * (`defaultFaceDetector()`) so the handler is type-compatible with
 * `defineStage`'s contract.
 */

import type { ImageDoc, StageContext, StageResult } from '../run-stage.ts';
import { defineStage, runStage, type RunStageHandle } from '../run-stage.ts';
import {
  defaultFaceDetector,
  ThumbDecodeError,
  type DetectedFace,
} from '../../enrichment/face-detector.ts';
import { CURRENT_EMBEDDING_VERSION } from '../../enrichment/face-models.ts';
import type { AssetFaceDoc } from '../../db/schema.ts';
import {
  loadThumbBytes,
  THUMB_MISSING_REASON,
  THUMB_UNDECODABLE_REASON,
} from './face-stage-shared.ts';

export { THUMB_MISSING_REASON, THUMB_UNDECODABLE_REASON };

/** The version `face-embed` starts at. Bump this on a model swap to
 * re-embed every face through the normal worker loop. Exported so the
 * in-flight migration that seeds existing assets references the exact
 * number rather than hard-coding it. */
export const FACE_EMBED_TARGET_VERSION = 1;

export async function faceEmbedHandler(image: ImageDoc, _ctx: StageContext): Promise<StageResult> {
  const detector = defaultFaceDetector();
  const faces = image.faces ?? [];
  // No faces detected on this asset — nothing to embed. (face-detect having
  // run is guaranteed by the `dependsOn: ['face-detect']` gate.)
  if (faces.length === 0) return { wrote: true };

  const loaded = await loadThumbBytes(image);
  if ('skip' in loaded) return loaded;

  const patch: Record<string, unknown> = {};
  for (let i = 0; i < faces.length; i++) {
    const face = faces[i]!;
    try {
      const embedding = await detector.embedFace(loaded.bytes, toDetection(face));
      patch[`faces.${i}.embedding`] = Array.from(embedding);
      patch[`faces.${i}.embedding_version`] = CURRENT_EMBEDDING_VERSION;
    } catch (err) {
      if (err instanceof ThumbDecodeError) {
        return { skip: `${THUMB_UNDECODABLE_REASON}: ${err.message}` };
      }
      throw err;
    }
  }
  return { patch };
}

/** Build the `DetectedFace`-shaped input `embedFace` expects from a stored
 * face doc. `landmarks` is forwarded when present so the recognizer aligns
 * the crop the same way `face-detect` saw it; legacy faces (from the old
 * single `face` stage) lack landmarks and fall back to the bbox-derived
 * synthetic template inside `embedFace`. */
function toDetection(face: AssetFaceDoc): DetectedFace {
  return {
    bbox: face.bbox,
    confidence: face.confidence,
    landmarks: face.landmarks ?? [],
  };
}

const faceEmbedStage = defineStage({
  name: 'face-embed',
  targetVersion: FACE_EMBED_TARGET_VERSION,
  dependsOn: ['face-detect'],
  defaults: {
    concurrency: 1,
    pollIntervalMs: 1000,
    batchSize: 5,
    maxAttempts: 5,
    paused: false,
    last_seen_target_version: 0,
    pausedOnFirstBoot: true,
  },
  handler: faceEmbedHandler,
});

export default faceEmbedStage;

export async function startFaceEmbedStage(): Promise<RunStageHandle> {
  return runStage(faceEmbedStage);
}
