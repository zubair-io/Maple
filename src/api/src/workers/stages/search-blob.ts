/**
 * Search-blob stage. Fan-in terminal stage.
 *
 * Writes the per-asset `search_blob` row of `asset_search`, the external content of the FTS5
 * index that answers keyword searches and takes over whenever the in-process search engine
 * cannot. An empty blob is a delete rather than a write of `''`, which is what the repo's
 * `searchBlobStatements` encodes.
 *
 * Depends on the always-on stages only (exif, thumb). Stages whose output feeds the blob
 * (describe, geocode, transcribe, video-describe, sidecar metadata, people) re-arm this one
 * through `invalidates` or a trigger.
 *
 * When `maple_id` is absent (legacy row pre-dating the indexer's mapleId migration), returns
 * `{ skip: "no-maple-id" }` so the stage completes rather than spinning forever on an
 * un-fixable invariant violation.
 */

import type { ImageDoc, StageContext, StageResult } from '../run-stage.ts';
import { defineStage, runStage, type RunStageHandle } from '../run-stage.ts';
import { composeSearchBlob } from '../../enrichment/search-blob.ts';
import { searchBlobStatements } from '../../db/repos/assets.stage-patches.ts';
import { loadNamedPeople, peopleNamesForFaces } from '../../people/asset-person-names.ts';
import type { VisionDoc } from '../../db/schema.ts';

type SearchableImage = ImageDoc & {
  maple_id?: string;
  ocr_text?: string;
  transcript?: { text?: string };
  vision?: VisionDoc | null;
};

function nullIfMissing<T>(value: T | null | undefined): T | null {
  return value === undefined ? null : value;
}

// Wide passthrough into composeSearchBlob's optional fields, not branching
// logic — each `?.`/`??` is one more source, not one more decision.
// fallow-ignore-next-line complexity
function searchBlobFor(image: SearchableImage, vision: VisionDoc | null, people: string[]): string {
  const video = image.video_description;
  return composeSearchBlob({
    place: image.place,
    description: image.description,
    ocrText: nullIfMissing(image.ocr_text),
    transcript: nullIfMissing(image.transcript?.text),
    visionSubjects: nullIfMissing(vision?.subjects),
    visionSetting: nullIfMissing(vision?.setting),
    visionActivity: nullIfMissing(vision?.activity),
    visionNotableObjects: nullIfMissing(vision?.notable_objects),
    visionTags: nullIfMissing(vision?.tags),
    people,
    capturedMonth: nullIfMissing(image.exif?.captured_month),
    videoSummary: nullIfMissing(video?.summary),
    videoSceneCaptions: video?.scenes.map((s) => s.caption) ?? null,
    videoSceneTextVisible:
      video?.scenes.map((s) => s.text_visible).filter((t) => t !== null) ?? null,
  });
}

export async function searchBlobHandler(image: ImageDoc, _ctx: StageContext): Promise<StageResult> {
  const searchable = image as SearchableImage;
  if ((searchable.maple_id ?? '').length === 0) return { skip: 'no-maple-id' };
  if (searchable.deleted_at) return { skip: 'trashed' };

  const faces = nullIfMissing(image.faces);
  const people = peopleNamesForFaces(faces, await loadNamedPeople([faces]));
  const blob = searchBlobFor(searchable, nullIfMissing(searchable.vision), people);
  return { patch: searchBlobStatements(image._id.toHexString(), blob) };
}

const searchBlobStage = defineStage({
  name: 'search-blob',
  // Carried over from the retired `meili` stage so its finished rows stay finished. Bump it when
  // `composeSearchBlob` starts folding in a new source, so every row is recomposed.
  targetVersion: 10,
  dependsOn: ['exif', 'thumb'],
  defaults: {
    concurrency: 2,
    maxAttempts: 5,
    paused: false,
    last_seen_target_version: 0,
    pausedOnFirstBoot: false,
  },
  handler: searchBlobHandler,
});

export default searchBlobStage;

export async function startSearchBlobStage(): Promise<RunStageHandle> {
  return runStage(searchBlobStage);
}
