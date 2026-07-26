/**
 * Meili (search-blob) stage. Fan-in terminal stage.
 *
 * Depends on the always-on stages only (exif, thumb). When optional stages
 * (face/ocr/describe/geocode) run later, meili won't automatically re-process
 * to incorporate their outputs. Operator must bump meili.targetVersion or
 * trigger a manual reset to refresh.
 *
 * The `search_blob` patch keeps the Mongo `$text` fallback search coherent
 * so assets remain searchable even without a Meilisearch sidecar.
 *
 * When Meilisearch is configured, the doc is also upserted there for
 * typo-tolerant search. Throws on transport error so the runtime retries.
 *
 * When `maple_id` is absent (legacy row pre-dating the indexer's mapleId
 * migration), returns `{ skip: "no-maple-id" }` so the stage completes
 * rather than spinning forever on an un-fixable invariant violation.
 */

import { ObjectId } from 'mongodb';
import type { ImageDoc, StageContext, StageResult } from '../run-stage.ts';
import { defineStage, runStage, type RunStageHandle } from '../run-stage.ts';
import { meilisearchClient, type MeilisearchClient } from '../../enrichment/meilisearch-client.ts';
import { composeSearchBlob } from '../../enrichment/search-blob.ts';
import { assetPrimaryFileInfo } from '../../indexer/images.repo.ts';
import { peopleCollection } from '../../db/client.ts';
import type { AssetFaceDoc, PersonDoc, VisionDoc } from '../../db/schema.ts';
import { classifyMediaType } from '../../indexer/media-types.ts';

/** Auto-generated cluster names ("Person 1", "Person 12", …). These are
 * placeholders, not real identities — folding them into the index would
 * pollute it with the high-frequency token "person", so we exclude them
 * from both the search blob and the Meili `people` attribute. */
const AUTO_PERSON_NAME = /^Person \d+$/;

/**
 * Resolve the named people on an asset from its `faces[].person_id`s.
 * Dedupes person ids, looks up `peopleCollection`, and returns the names
 * EXCLUDING auto-generated `Person N` clusters and merged rows
 * (`merged_into != null`). Returns `[]` (no DB round-trip) when the asset
 * has no assigned faces, which keeps the no-Mongo / fixture test paths
 * cheap and offline.
 */
export async function resolveAssetPeopleNames(
  faces: AssetFaceDoc[] | null | undefined,
): Promise<string[]> {
  if (!faces || faces.length === 0) return [];
  const ids: ObjectId[] = [];
  const seen = new Set<string>();
  for (const f of faces) {
    const hex = f.person_id;
    if (!hex || seen.has(hex)) continue;
    seen.add(hex);
    if (!/^[0-9a-f]{24}$/i.test(hex)) continue;
    try {
      ids.push(new ObjectId(hex));
    } catch {
      // Malformed id — skip.
    }
  }
  if (ids.length === 0) return [];
  const coll = await peopleCollection();
  const rows = await coll
    .find({ _id: { $in: ids }, merged_into: null } as never)
    .project<{ name: string }>({ name: 1 })
    .toArray();
  const names: string[] = [];
  for (const r of rows) {
    const name = (r as Pick<PersonDoc, 'name'>).name;
    if (typeof name === 'string' && name.length > 0 && !AUTO_PERSON_NAME.test(name)) {
      names.push(name);
    }
  }
  return names;
}

// Tests inject a fake here; production leaves it null and reads the live
// module singleton on every call so an operator's `PUT /enrichment/config`
// reconfigure (reconfigureMeilisearch) is picked up without a restart.
let _testClient: MeilisearchClient | null = null;
function getClient(): MeilisearchClient {
  return _testClient ?? meilisearchClient();
}

/** Test-only setter. Call with `null` to reset between tests. */
export function setMeilisearchClientForTests(client: MeilisearchClient | null): void {
  _testClient = client;
}

export async function meiliHandler(image: ImageDoc, _ctx: StageContext): Promise<StageResult> {
  const mapleId = (image as unknown as { maple_id?: string }).maple_id ?? '';
  if (mapleId.length === 0) {
    return { skip: 'no-maple-id' };
  }

  // Vision signals from the qwen3-vl describe stage — see schema.ts
  // §VisionDoc. Optional: `vision` is null on assets that haven't been
  // through the describe stage yet (paused on first boot, paid provider
  // without a key, etc.) — the blob simply omits them in that case.
  const vision =
    (
      image as unknown as {
        vision?: VisionDoc | null;
      }
    ).vision ?? null;

  // Named people on this asset — excludes auto-generated `Person N`
  // clusters and merged rows. `[]` when the asset has no assigned faces.
  const peopleNames = await resolveAssetPeopleNames(image.faces ?? null);

  const blob = composeSearchBlob({
    place: image.place,
    description: image.description,
    ocrText: (image as unknown as { ocr_text?: string }).ocr_text ?? null,
    transcript: (image as unknown as { transcript?: { text?: string } }).transcript?.text ?? null,
    visionSubjects: vision?.subjects ?? null,
    visionSetting: vision?.setting ?? null,
    visionActivity: vision?.activity ?? null,
    visionNotableObjects: vision?.notable_objects ?? null,
    people: peopleNames,
  });

  const isScreenshot = (image as unknown as { is_screenshot?: boolean }).is_screenshot ?? null;

  const client = getClient();
  if (client.isConfigured()) {
    // Resolve folder id (== library id) from the primary fileinfo entry.
    // Skip the Meili upsert if the row has no live fileinfo — the document
    // can't be filtered by folder without it.
    const primary = assetPrimaryFileInfo(image as never);
    if (!primary) {
      return { skip: 'no-resolvable-location' };
    }
    await client.upsertOrThrow({
      id: mapleId,
      filename: primary.filename,
      searchBlob: blob,
      description: image.description ?? null,
      ocrText: (image as unknown as { ocr_text?: string }).ocr_text ?? null,
      folderId: primary.library_id.toHexString(),
      capturedAt: image.exif?.captured_at ?? null,
      deletedAt: null,
      visionSceneType: vision?.scene_type ?? null,
      visionActivity: vision?.activity ?? null,
      visionSubjects: vision?.subjects ?? null,
      isScreenshot,
      people: peopleNames.length > 0 ? peopleNames : null,
      mediaType: classifyMediaType(primary.filename),
      hidden: image.hidden === true,
    });
  }

  return { patch: { search_blob: blob } };
}

const meiliStage = defineStage({
  name: 'meili',
  // v2: introduced a mean-confidence gate on `ocr_text` (removed with the
  // legacy OCR stage). Bumping forced a re-index against the cleaned value.
  //
  // v3: search_blob now folds in the structured vision fields
  // (subjects / setting / activity / notable_objects) from the qwen2.5-vl
  // describe stage. Bumping invalidates v2 rows so the index picks up the
  // new tokens.
  //
  // v4: the Meilisearch document now carries discrete `visionSceneType` /
  // `visionActivity` / `visionSubjects` fields (filterable attributes) for
  // the browse-facets UI. Bumping forces re-index so v3 rows learn the
  // new attribute shape.
  //
  // v5: adds `isScreenshot` to the Meilisearch document + filterable
  // attributes for the photos-vs-screenshots filter. Bumping invalidates
  // v4 rows so the index picks up the new field.
  //
  // v6: folds named people (from `faces[].person_id`, excluding auto
  // `Person N` clusters + merged rows) into both the search_blob and the
  // Meilisearch document's `people` searchable+filterable attribute.
  // Bumping re-indexes everything so v5 rows learn the people tokens.
  //
  // v7: adds the highest-weight filename plus mediaType and hidden filter
  // fields used by the Maple-owned service-search contract.
  targetVersion: 7,
  // Only depends on always-on stages so search is available early. Optional
  // semantic sources explicitly invalidate this stage when their output
  // changes (describe/OCR, geocode, transcript, people, sidecar metadata).
  dependsOn: ['exif', 'thumb'],
  defaults: {
    concurrency: 2,
    maxAttempts: 5,
    paused: false,
    last_seen_target_version: 0,
    pausedOnFirstBoot: false,
  },
  handler: meiliHandler,
});

export default meiliStage;

export async function startMeiliStage(): Promise<RunStageHandle> {
  return runStage(meiliStage);
}
