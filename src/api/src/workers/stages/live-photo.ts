/**
 * Live Photo stage (#5540, part of #5448) — records the Apple content
 * identifier of every JPEG, HEIC, HEIF and MOV so a still and its motion clip
 * can be paired by identity rather than by filename.
 *
 * Reads metadata only (`indexer/live-photo/`). A file without an identifier
 * writes NULL, so a re-run over an edited original (migration 0039's trigger
 * re-arms the stage on a size or mtime change) retires one the file no longer
 * carries. Pairing itself is derived when a folder is listed
 * (`library/live-photo-pairs.ts`): it needs no write to the partner, so
 * neither stage order nor a late-arriving half can leave a pair stale.
 */
import { liveContentIdStatements } from '../../db/repos/assets.stage-patches.ts';
import { readLiveContentId } from '../../indexer/live-photo/content-id.ts';
import { liveFileKind } from '../../indexer/live-photo/live-file-kind.ts';
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

export async function livePhotoHandler(image: ImageDoc, ctx: StageContext): Promise<StageResult> {
  const primary = assetPrimaryFileInfo(image as never);
  const kind = primary ? liveFileKind(primary.filename) : null;
  if (primary && !kind) return { skip: 'not-a-live-photo-candidate' };
  const libs = await loadLibraryRootsForAsset(image as never);
  const absPath = assetAbsPath(image as never, libs);
  if (!absPath || !kind) return noResolvableLocation(image as never, libs);
  const contentId = await readLiveContentId(absPath, kind, ctx.signal);
  ctx.log.debug({ assetId: image._id.toHexString(), kind, contentId }, 'live photo identifier');
  return { patch: liveContentIdStatements(image._id.toHexString(), contentId) };
}

const livePhotoStage = defineStage({
  name: 'live-photo',
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
  handler: livePhotoHandler,
});

export default livePhotoStage;

export async function startLivePhotoStage(): Promise<RunStageHandle> {
  return runStage(livePhotoStage);
}
