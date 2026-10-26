/**
 * Motion-photo stage (#5447) — finds the short clip an Android phone appends
 * to a JPEG or HEIC still and records its byte range on the asset.
 *
 * Reads metadata only (`indexer/motion-photo/`); the clip itself is never
 * copied anywhere — `GET /api/motion/:slug/*` serves it as a range of the
 * original. A still that is not a Motion Photo writes NULLs, so a re-run over
 * an edited original (migration 0037's trigger re-arms the stage on a size or
 * mtime change) retires a clip the file no longer carries.
 */
import * as path from 'node:path';
import { motionPhotoStatements } from '../../db/repos/assets.stage-patches.ts';
import { detectMotionPhoto } from '../../indexer/motion-photo/detect.ts';
import { assetAbsPath, assetPrimaryFileInfo } from '../../indexer/images.repo.ts';
import { loadLibraryRootsForAsset } from '../../indexer/libraries.cache.ts';
import { noResolvableLocation } from './no-resolvable-location.ts';
import {
  defineStage,
  runStage,
  type ImageDoc,
  type RunStageHandle,
  type StageContext,
  type StageResult,
} from '../run-stage.ts';

const MOTION_STILL_EXTENSIONS = new Set(['.jpg', '.jpeg', '.heic', '.heif']);

export async function motionPhotoHandler(image: ImageDoc, ctx: StageContext): Promise<StageResult> {
  const primary = assetPrimaryFileInfo(image as never);
  if (primary && !MOTION_STILL_EXTENSIONS.has(path.extname(primary.filename).toLowerCase())) {
    return { skip: 'not-a-jpeg-or-heic' };
  }
  const libs = await loadLibraryRootsForAsset(image as never);
  const absPath = assetAbsPath(image as never, libs);
  if (!absPath) return noResolvableLocation(image as never, libs);
  const id = image._id.toHexString();
  const detection = await detectMotionPhoto(absPath, ctx.signal);
  if ('still' in detection) {
    ctx.log.debug({ assetId: id, reason: detection.still }, 'not a motion photo');
    return { patch: motionPhotoStatements(id, null) };
  }
  return { patch: motionPhotoStatements(id, detection.motion) };
}

const motionPhotoStage = defineStage({
  name: 'motion-photo',
  targetVersion: 1,
  dependsOn: [],
  tagsMissingOnEnoent: true,
  defaults: {
    concurrency: 2,
    maxAttempts: 5,
    paused: false,
    pausedOnFirstBoot: false,
    last_seen_target_version: 0,
  },
  handler: motionPhotoHandler,
});

export default motionPhotoStage;

export async function startMotionPhotoStage(): Promise<RunStageHandle> {
  return runStage(motionPhotoStage);
}
