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
import {
  meilisearchClient,
  type MeilisearchAssetDoc,
  type MeilisearchClient,
} from '../../enrichment/meilisearch-client.ts';
import { composeSearchBlob } from '../../enrichment/search-blob.ts';
import { placeTextForIndex, transcriptForIndex } from '../../enrichment/asset-doc-fields.ts';
import { ASSET_DOC_SHAPE_VERSION } from '../../enrichment/meilisearch-embedder-template.ts';
import { assetPrimaryFileInfo } from '../../indexer/images.repo.ts';
import { peopleCollection } from '../../db/client.ts';
import type { AssetFaceDoc, FileInfo, PersonDoc, VisionDoc } from '../../db/schema.ts';
import { classifyMediaType } from '../../indexer/media-types.ts';

/** Auto-generated cluster names ("Person 1", "Person 12", …). These are
 * placeholders, not real identities — folding them into the index would
 * pollute it with the high-frequency token "person", so we exclude them
 * from both the search blob and the Meili `people` attribute. */
const AUTO_PERSON_NAME = /^Person \d+$/;

function validPersonIds(faces: AssetFaceDoc[] | null | undefined): ObjectId[] {
  if (!faces || faces.length === 0) return [];
  const ids: ObjectId[] = [];
  const seen = new Set<string>();
  for (const face of faces) {
    const hex = face.person_id;
    if (!hex || seen.has(hex) || !/^[0-9a-f]{24}$/i.test(hex)) continue;
    seen.add(hex);
    ids.push(new ObjectId(hex));
  }
  return ids;
}

/** Load all indexable person names for one or more assets in a single query. */
export async function loadNamedPeople(
  faceSets: Array<AssetFaceDoc[] | null | undefined>,
): Promise<Map<string, string>> {
  const uniqueIds = new Map<string, ObjectId>();
  for (const faces of faceSets) {
    for (const id of validPersonIds(faces)) uniqueIds.set(id.toHexString(), id);
  }
  if (uniqueIds.size === 0) return new Map();

  const coll = await peopleCollection();
  const rows = await coll
    .find({
      _id: { $in: [...uniqueIds.values()] },
      merged_into: null,
      hidden: { $ne: true },
    } as never)
    .project<{ _id: ObjectId; name: PersonDoc['name'] }>({ _id: 1, name: 1 })
    .toArray();
  return new Map(
    rows
      .filter(
        (row) =>
          typeof row.name === 'string' && row.name.length > 0 && !AUTO_PERSON_NAME.test(row.name),
      )
      .map((row) => [row._id.toHexString(), row.name]),
  );
}

/** Resolve an asset's ordered, de-duplicated names from a batch name map. */
export function peopleNamesForFaces(
  faces: AssetFaceDoc[] | null | undefined,
  namesById: ReadonlyMap<string, string>,
): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const id of validPersonIds(faces)) {
    const name = namesById.get(id.toHexString());
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

/**
 * Resolve the named people on an asset from its `faces[].person_id`s.
 * Dedupes person ids, looks up `peopleCollection`, and returns the names
 * EXCLUDING auto-generated `Person N` clusters and merged rows
 * (`merged_into != null`). Returns `[]` (no DB round-trip) when the asset
 * has no assigned faces, which keeps the no-Mongo / fixture test paths
 * cheap and offline.
 */
async function resolveAssetPeopleNames(
  faces: AssetFaceDoc[] | null | undefined,
): Promise<string[]> {
  const namesById = await loadNamedPeople([faces]);
  return peopleNamesForFaces(faces, namesById);
}

// Tests inject a fake here; production leaves it null and reads the live
// module singleton on every call so the API-process save path and the
// worker-process DB refresh can replace it without restarting either process.
let _testClient: MeilisearchClient | null = null;
function getClient(): MeilisearchClient {
  return _testClient ?? meilisearchClient();
}

/** Test-only setter. Call with `null` to reset between tests. */
export function setMeilisearchClientForTests(client: MeilisearchClient | null): void {
  _testClient = client;
}

type SearchableImage = ImageDoc & {
  maple_id?: string;
  ocr_text?: string;
  transcript?: { text?: string };
  vision?: VisionDoc | null;
  is_screenshot?: boolean;
};

function nullIfMissing<T>(value: T | null | undefined): T | null {
  return value === undefined ? null : value;
}

function searchBlobFor(image: SearchableImage, vision: VisionDoc | null, people: string[]): string {
  return composeSearchBlob({
    place: image.place,
    description: image.description,
    ocrText: nullIfMissing(image.ocr_text),
    transcript: nullIfMissing(image.transcript?.text),
    visionSubjects: nullIfMissing(vision?.subjects),
    visionSetting: nullIfMissing(vision?.setting),
    visionActivity: nullIfMissing(vision?.activity),
    visionNotableObjects: nullIfMissing(vision?.notable_objects),
    people,
  });
}

function meilisearchDocument(
  image: SearchableImage,
  primary: FileInfo,
  mapleId: string,
  searchBlob: string,
  vision: VisionDoc | null,
  people: string[],
): MeilisearchAssetDoc {
  return {
    id: mapleId,
    filename: primary.filename,
    searchBlob,
    description: nullIfMissing(image.description),
    ocrText: nullIfMissing(image.ocr_text),
    transcript: transcriptForIndex(image.transcript),
    placeText: placeTextForIndex(image.place),
    folderId: primary.library_id.toHexString(),
    capturedAt: nullIfMissing(image.exif?.captured_at),
    deletedAt: null,
    visionSceneType: nullIfMissing(vision?.scene_type),
    visionActivity: nullIfMissing(vision?.activity),
    visionSubjects: nullIfMissing(vision?.subjects),
    isScreenshot: nullIfMissing(image.is_screenshot),
    people: people.length === 0 ? null : people,
    mediaType: classifyMediaType(primary.filename),
    hidden: image.hidden === true,
  };
}

/**
 * Timeout for this stage's single-asset tombstone wait (#2359). The client's
 * configured `taskTimeoutMs` (`DEFAULT_MEILISEARCH_TASK_TIMEOUT_MS` = 10 min)
 * is sized for bulk backfill batches, which are expected to take a while and
 * run outside the per-asset concurrency pool. Reusing it here would let a
 * degraded Meilisearch stall one of this stage's 2 concurrency slots for up
 * to 10 minutes per asset. The stage's retry/backoff (`run-stage.ts`, #2360
 * design) already covers a fast-failing wait safely, so keep this short.
 */
export const SINGLE_DOC_TOMBSTONE_TIMEOUT_MS = 30_000;

/**
 * Tombstone one asset in Meilisearch, preferring the batch-throwing form
 * when the client offers it. No-ops when Meilisearch isn't configured.
 * Shared by both `meiliHandler` early-return branches below (trashed,
 * no-resolvable-location) so neither drifts from the other on the
 * batch-vs-single fallback.
 */
async function tombstoneIfConfigured(client: MeilisearchClient, mapleId: string): Promise<void> {
  if (!client.isConfigured()) return;
  if (client.tombstoneBatchOrThrow) {
    await client.tombstoneBatchOrThrow([mapleId], SINGLE_DOC_TOMBSTONE_TIMEOUT_MS);
  } else {
    await client.tombstone(mapleId);
  }
}

export async function meiliHandler(image: ImageDoc, _ctx: StageContext): Promise<StageResult> {
  const searchable = image as SearchableImage;
  const mapleId = searchable.maple_id ?? '';
  if (mapleId.length === 0) {
    return { skip: 'no-maple-id' };
  }
  const client = getClient();
  // Trashed asset (root `deleted_at` set). Its fileinfo entry still points at
  // the `.maple/trash/…` location and stays live PER-ENTRY, so the claim query
  // does hand trashed rows to this handler — the trash route re-arms this
  // stage on soft-delete precisely so a failed inline tombstone converges
  // here (#2354). Tombstone instead of upserting: an upsert would resurrect
  // the row in search (`meilisearchDocument` writes `deletedAt: null`).
  // Throws on transport error so the runtime retries; the later restore
  // re-arms the stage again, which rebuilds the full live document.
  if (searchable.deleted_at) {
    await tombstoneIfConfigured(client, mapleId);
    return { skip: 'trashed' };
  }
  const primary = client.isConfigured() ? assetPrimaryFileInfo(image as never) : null;
  if (client.isConfigured() && !primary) {
    await tombstoneIfConfigured(client, mapleId);
    return { skip: 'no-resolvable-location' };
  }

  // Vision signals from the qwen3-vl describe stage — see schema.ts
  // §VisionDoc. Optional: `vision` is null on assets that haven't been
  // through the describe stage yet (paused on first boot, paid provider
  // without a key, etc.) — the blob simply omits them in that case.
  const vision = nullIfMissing(searchable.vision);

  // Named people on this asset — excludes auto-generated `Person N`
  // clusters and merged rows. `[]` when the asset has no assigned faces.
  const peopleNames = await resolveAssetPeopleNames(nullIfMissing(image.faces));
  const blob = searchBlobFor(searchable, vision, peopleNames);

  if (client.isConfigured() && primary) {
    await client.upsertOrThrow(
      meilisearchDocument(searchable, primary, mapleId, blob, vision, peopleNames),
    );
  }

  const semanticFingerprint = client.semanticFingerprint?.();
  return {
    patch: {
      search_blob: blob,
      ...(semanticFingerprint ? { semantic_vector_fingerprint: semanticFingerprint } : {}),
    },
  };
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
  //
  // v8: the document carries prose `transcript` and `placeText` fields so the
  // embedder reads real sentences instead of the alphabetised `searchBlob`
  // token bag (#2384). Bound to ASSET_DOC_SHAPE_VERSION rather than written
  // as a literal because a document-shape change is exactly the condition
  // under which every asset must be re-upserted — the two can never
  // legitimately disagree.
  targetVersion: ASSET_DOC_SHAPE_VERSION,
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
