/**
 * Person-segmentation stage — the server half of web subject masks (#4284, #3300 slice 3).
 *
 * Runs person instance and skin segmentation against the cached preview/thumb image,
 * records `{ model, persons: [{ person, bbox }] }` in `person_segmentations`,
 * and caches 1024px grayscale PNG rasters by FNV-1a digest.
 *
 * Depends on `["preview"]`. Concurrency 1 (single-threaded CPU/ORT session).
 * `pausedOnFirstBoot: true` — starts paused until enabled by the operator.
 */

import { readFile } from 'node:fs/promises';
import { maple } from 'maple';
import type { ImageDoc, RunStageHandle, StageContext, StageResult } from '../run-stage.ts';
import { defineStage, runStage } from '../run-stage.ts';
import { cachePathForAsset } from '../../fs/xmp.ts';
import { loadLibraryRoots, loadLibraryIdToSlug } from '../../indexer/libraries.cache.ts';
import { assetPrimaryFileInfo } from '../../indexer/images.repo.ts';
import { isUndecodableFilename, isVideoFilename } from '../../indexer/media-types.ts';
import { PREVIEW_CACHE_SUFFIX } from '../../indexer/previewer.ts';
import {
  defaultPersonSegmenter,
  PERSON_SEGMENTATION_MODEL_ID,
} from '../../enrichment/subject-masks/person-segmenter.ts';
import { subjectMaskDigest } from '../../enrichment/subject-masks/subject-mask-digest.ts';
import { writeRasterPng } from '../../enrichment/subject-masks/subject-mask-cache.ts';
import { personSegmentationStatements } from '../../db/repos/subject-masks.repo.ts';
import { loadThumbBytes } from './face-stage-shared.ts';

export const PERSON_SEGMENTATION_TARGET_VERSION = 1;

export async function personSegmentationHandler(
  image: ImageDoc,
  _ctx: StageContext,
): Promise<StageResult> {
  const primary = assetPrimaryFileInfo(image);
  if (primary && isUndecodableFilename(primary.filename)) {
    return { skip: 'stub-file' };
  }
  if (primary && isVideoFilename(primary.filename)) {
    return { skip: 'video-unsupported' };
  }

  const assetId = image._id.toHexString();
  const segmenter = defaultPersonSegmenter();

  // Try loading preview image bytes; fall back to thumbnail if preview is missing
  let imageBytes: Uint8Array | null = null;
  let libs: ReadonlyMap<string, string> = new Map();
  try {
    libs = await loadLibraryRoots();
  } catch {
    libs = new Map();
  }

  const previewPath = cachePathForAsset(image as never, libs, 'previews', PREVIEW_CACHE_SUFFIX);
  if (previewPath) {
    try {
      imageBytes = await readFile(previewPath);
    } catch {
      imageBytes = null;
    }
  }

  if (!imageBytes) {
    const loadedThumb = await loadThumbBytes(image).catch(
      () => ({ skip: 'thumb-missing' }) as const,
    );
    if ('skip' in loadedThumb) return loadedThumb;
    imageBytes = loadedThumb.bytes;
  }

  const result = await segmenter.segment(imageBytes);
  const model = result.model ?? PERSON_SEGMENTATION_MODEL_ID;

  // Resolve address if possible for dual digest caching
  let address: string | null = null;
  if (primary) {
    try {
      const idToSlug = await loadLibraryIdToSlug();
      const slug = idToSlug.get(primary.library_id.toHexString());
      if (slug) {
        const rel = primary.path ? `${primary.path}/${primary.filename}` : primary.filename;
        address = `${slug}:${rel}`;
      }
    } catch {
      // Ignore address lookup failure
    }
  }

  // Save generated rasters by digest
  for (const p of result.persons) {
    if (p.maskRaster && p.maskRaster.data.length > 0) {
      const pngBuffer = await maple({
        data: p.maskRaster.data,
        width: p.maskRaster.width,
        height: p.maskRaster.height,
        channels: 1,
      })
        .png()
        .toBuffer();

      const digest = subjectMaskDigest(assetId, p.person, true, true, model);
      await writeRasterPng(digest, pngBuffer);

      if (address) {
        const addressDigest = subjectMaskDigest(address, p.person, true, true, model);
        if (addressDigest !== digest) {
          await writeRasterPng(addressDigest, pngBuffer);
        }
      }
    }
  }

  const personsMeta = result.persons.map((p) => ({
    person: p.person,
    bbox: p.bbox,
  }));

  return { patch: personSegmentationStatements(assetId, model, personsMeta) };
}

const personSegmentationStage = defineStage({
  name: 'person-segmentation',
  targetVersion: PERSON_SEGMENTATION_TARGET_VERSION,
  dependsOn: [{ name: 'preview', minVersion: 1 }],
  defaults: {
    concurrency: 1,
    maxAttempts: 5,
    paused: false,
    last_seen_target_version: 0,
    pausedOnFirstBoot: true,
  },
  handler: personSegmentationHandler,
});

export default personSegmentationStage;

export async function startPersonSegmentationStage(): Promise<RunStageHandle> {
  return runStage(personSegmentationStage);
}
