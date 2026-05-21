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

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { ImageDoc, StageContext, StageResult } from '../run-stage.ts';
import { defineStage, runStage, type RunStageHandle } from '../run-stage.ts';
import { cachePathFor, resolveThumbPathForAsset } from '../../fs/xmp.ts';
import { loadLibraryRoots } from '../../indexer/libraries.cache.ts';
import {
  defaultFaceDetector,
  ThumbDecodeError,
  type DetectedFace,
} from '../../enrichment/face-detector.ts';
import type { AssetFaceDoc } from '../../db/schema.ts';

export const THUMB_MISSING_REASON = 'thumb-missing';
/** Cached thumbnail exists on disk but `sharp`/libvips can't decode it
 * (e.g. "VipsJpeg: Invalid SOS parameters"). Non-retryable — the thumb
 * regen would produce the same bytes. Skip-passes so the stage version
 * advances and we stop hammering bad inputs. */
export const THUMB_UNDECODABLE_REASON = 'thumb-undecodable';

export async function faceHandler(image: ImageDoc, _ctx: StageContext): Promise<StageResult> {
  const detector = defaultFaceDetector();
  // Prefer the content-addressed thumb path when the row has maple_id +
  // fileinfo[0]; fall back to the legacy basename-keyed cache path for
  // unmigrated rows. A DB hiccup loading library roots falls through to
  // the legacy path with an empty map.
  let libs: ReadonlyMap<string, string>;
  try {
    libs = await loadLibraryRoots();
  } catch {
    libs = new Map();
  }
  const thumbPath =
    resolveThumbPathForAsset(image as never, libs) ??
    cachePathFor(image.abs_path as string, 'thumbs');
  if (!existsSync(thumbPath)) {
    return { skip: `${THUMB_MISSING_REASON}: ${thumbPath}` };
  }
  const bytes = new Uint8Array(await readFile(thumbPath));
  let detections: DetectedFace[];
  try {
    detections = await detector.detectFaces(bytes);
  } catch (err) {
    if (err instanceof ThumbDecodeError) {
      return { skip: `${THUMB_UNDECODABLE_REASON}: ${err.message}` };
    }
    throw err;
  }
  if (detections.length === 0) {
    return { patch: { faces: [] } };
  }
  const faces: AssetFaceDoc[] = [];
  for (const det of detections) {
    try {
      const embedding = await detector.embedFace(bytes, det);
      faces.push(detectionToDoc(det, embedding));
    } catch (err) {
      if (err instanceof ThumbDecodeError) {
        return { skip: `${THUMB_UNDECODABLE_REASON}: ${err.message}` };
      }
      throw err;
    }
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

const faceStage = defineStage({
  name: 'face',
  targetVersion: 1,
  dependsOn: ['thumb'],
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

export default faceStage;

export async function startFaceStage(): Promise<RunStageHandle> {
  return runStage(faceStage);
}
