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
import { FACE_DETECT_TARGET_VERSION } from './face-detect.ts';
import { clusterCoordinator } from '../../people/cluster-coordinator.ts';

export { THUMB_MISSING_REASON, THUMB_UNDECODABLE_REASON };

/** Reprocess target for `face-embed`. The worker loop gates on each
 * asset's `stages.face-embed.version` vs this number (see run-stage.ts);
 * bumping it re-queues every asset whose stage version is below it and
 * re-embeds its faces in place (per-index `$set`, so `person_id` / bbox /
 * hidden are preserved).
 *
 * v1 → v2: re-embed the back-catalog into the antelopev2 R100 / Glint360K
 * space. Existing embeddings were produced by the old MobileFaceNet model
 * and are mathematically unrelated — they must be recomputed (there is no
 * cross-model vector migration). Assets carrying the lower version (legacy
 * faces, or anything below v2) go stale and reprocess through the normal
 * loop. */
export const FACE_EMBED_TARGET_VERSION = 2;

export async function faceEmbedHandler(image: ImageDoc, _ctx: StageContext): Promise<StageResult> {
  const detector = defaultFaceDetector();
  const faces = image.faces ?? [];
  // No faces detected on this asset — nothing to embed. (face-detect having
  // run is guaranteed by the `dependsOn: ['face-detect']` gate.) Report zero
  // faces so the auto-cluster cadence (which counts FACES, not assets) doesn't
  // advance on a faceless asset.
  if (faces.length === 0) {
    clusterCoordinator().recordFacesEmbedded(0);
    return { wrote: true };
  }

  const loaded = await loadThumbBytes(image);
  if ('skip' in loaded) return loaded;

  const patch: Record<string, unknown> = {};
  let embeddedCount = 0;
  for (let i = 0; i < faces.length; i++) {
    const face = faces[i]!;
    try {
      const embedding = await detector.embedFace(loaded.bytes, toDetection(face));
      patch[`faces.${i}.embedding`] = Array.from(embedding);
      patch[`faces.${i}.embedding_version`] = CURRENT_EMBEDDING_VERSION;
      embeddedCount++;
    } catch (err) {
      if (err instanceof ThumbDecodeError) {
        return { skip: `${THUMB_UNDECODABLE_REASON}: ${err.message}` };
      }
      throw err;
    }
  }
  // Report the real FACE count for this asset to the auto-cluster coordinator
  // (drives the "every N faces" cadence + the idle-edge "did any work?" gate).
  // The generic per-tick `onProgress` hook only sees the asset count, so the
  // accurate face count must come from here, where we know `image.faces`.
  clusterCoordinator().recordFacesEmbedded(embeddedCount);
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
  // Require face-detect at ITS target, not just >= 1. Both stages sit at
  // v2 for the R100 re-process; a plain `'face-detect'` dep would only
  // enforce >= 1, letting face-embed re-embed an asset off its STALE v1
  // boxes/landmarks before the v2 re-detect pass runs. Pinning to
  // FACE_DETECT_TARGET_VERSION keeps re-embed strictly after re-detect.
  dependsOn: [{ name: 'face-detect', minVersion: FACE_DETECT_TARGET_VERSION }],
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
  // Auto-clustering idle edge: after each poll tick, tell the coordinator
  // whether the queue drained. This loop-level hook is asset-agnostic (it only
  // knows the asset count, not the face count), so it carries ONLY the idle
  // signal — the "every N faces" cadence is driven by `recordFacesEmbedded`,
  // which the handler calls with the real per-asset face count. Together they
  // populate people during the embed run instead of only after a manual "Run
  // clustering" click. Other stages leave this unset.
  onProgress: (processedThisTick, idle) => {
    clusterCoordinator().notifyProgress(processedThisTick, idle);
  },
});

export default faceEmbedStage;

export async function startFaceEmbedStage(): Promise<RunStageHandle> {
  return runStage(faceEmbedStage);
}
