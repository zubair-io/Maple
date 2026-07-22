/**
 * Drift checks for the derivative-audit worker. Each check fires only when the
 * owning stage claims done (version >= its targetVersion) yet the derivative is
 * missing/absent — precisely the state the stage claim query can't self-correct.
 * Pure (deps injected) so it unit-tests against temp dirs + a fake R2.
 */
import type { Stats } from 'node:fs';
import type { ImageDoc } from '../run-stage.ts';
import { assetAbsPath, assetPrimaryFileInfo } from '../../indexer/images.repo.ts';
import { resolveThumbPathForAsset, cachePathForAsset } from '../../fs/xmp.ts';
import { PREVIEW_CACHE_SUFFIX } from '../../indexer/previewer.ts';
import { isUndecodableFilename, isVideoFilename } from '../../indexer/media-types.ts';
import { thumbR2Key } from '../../cloudflare/thumb-key.ts';

const THUMB_TARGET = 3;
const PREVIEW_TARGET = 4;
const DESCRIBE_TARGET = 7;
const CF_TARGET = 1;

export interface AuditDeps {
  statOrNull(p: string): Promise<Stats | null>;
  ffmpegAvailable(): Promise<boolean>;
  /** `null` disables the deep R2 check (R2 unconfigured or turned off). */
  thumbExistsInR2: ((key: string) => Promise<boolean>) | null;
}

function stageVersion(image: ImageDoc, name: string): number {
  return image.stages?.[name]?.version ?? 0;
}

/** Would the thumb/preview stages actually produce a file for this asset?
 * Replicates their terminal skips (stub-file, no-video-decoder). */
async function pixelDerivativeExpected(image: ImageDoc, deps: AuditDeps): Promise<boolean> {
  const primary = assetPrimaryFileInfo(image);
  if (!primary) return false;
  if (isUndecodableFilename(primary.filename)) return false;
  if (isVideoFilename(primary.filename) && !(await deps.ffmpegAvailable())) return false;
  return true;
}

/** Returns the stage names to re-arm (subset of thumb/preview/describe/
 * cf-thumb-sync). Empty when nothing has drifted — or when the original file
 * isn't on disk (that's discover/missing-reaper's job, not ours). */
export async function evaluateAsset(
  image: ImageDoc,
  libs: ReadonlyMap<string, string>,
  idToSlug: ReadonlyMap<string, string>,
  deps: AuditDeps,
): Promise<string[]> {
  const absPath = assetAbsPath(image, libs);
  if (!absPath || (await deps.statOrNull(absPath)) === null) return [];

  const resets: string[] = [];
  const expectPixels = await pixelDerivativeExpected(image, deps);

  const thumbPath = resolveThumbPathForAsset(image, libs);
  const thumbPresent = thumbPath !== null && (await deps.statOrNull(thumbPath)) !== null;
  if (expectPixels && stageVersion(image, 'thumb') >= THUMB_TARGET && thumbPath && !thumbPresent) {
    resets.push('thumb');
  }

  const previewPath = cachePathForAsset(image, libs, 'previews', PREVIEW_CACHE_SUFFIX);
  const previewPresent = previewPath !== null && (await deps.statOrNull(previewPath)) !== null;
  if (
    expectPixels &&
    stageVersion(image, 'preview') >= PREVIEW_TARGET &&
    previewPath &&
    !previewPresent
  ) {
    resets.push('preview');
  }

  // Description is a DB field (survives a move); it only goes "missing" when
  // describe skipped `preview-missing`. Re-arm only when a preview now exists,
  // so the re-run actually captions instead of skipping again.
  if (
    stageVersion(image, 'describe') >= DESCRIBE_TARGET &&
    (image.description ?? '').trim() === '' &&
    expectPixels &&
    previewPresent
  ) {
    resets.push('describe');
  }

  // Deep R2 check: thumb present locally but absent in the bucket. Skip hidden
  // (absence in R2 is correct — cf-thumb-sync tears it down on hide).
  if (
    deps.thumbExistsInR2 !== null &&
    stageVersion(image, 'cf-thumb-sync') >= CF_TARGET &&
    image.hidden !== true &&
    thumbPresent
  ) {
    const primary = assetPrimaryFileInfo(image);
    const slug = primary ? idToSlug.get(primary.library_id.toHexString()) : undefined;
    if (primary && slug) {
      const key = thumbR2Key({ slug, relDir: primary.path, filename: primary.filename });
      if ((await deps.thumbExistsInR2(key)) === false) resets.push('cf-thumb-sync');
    }
  }

  return resets;
}
