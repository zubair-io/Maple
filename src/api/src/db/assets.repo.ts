/**
 * Assets repository — Mongo `assets` collection access for the API routes.
 *
 * Owns the BSON ↔ wire-DTO transform for every `/api/assets/*` endpoint
 * that lives under `src/routes/assets/` plus the working-set list at
 * `src/routes/assets-list.ts`. Routes never touch `assetsCollection()`
 * directly any more; they go through the named functions exported here.
 *
 * Scope note (issue #132 incremental rollout): two repos cover the same
 * collection on purpose during the migration. This file is the
 * API-facing repo and produces wire DTOs. `src/indexer/images.repo.ts`
 * stays as the indexer-internal helper used by workers — it returns
 * snake_case `IndexerAssetDoc` shapes that are written back to Mongo,
 * not sent to clients. Unifying the two is a follow-up. See issue #132
 * body.
 *
 * Wire-DTO convention (preserves the existing contract — the Swift
 * client and the Angular shell both read snake_case keys today):
 *   - `_id` is rendered as `id` (hex string).
 *   - `folder_id` ObjectId is rendered as the same hex string.
 *   - Every other persisted snake_case field name passes through
 *     verbatim. Renaming to camelCase is a separate breaking change
 *     and is not in scope for this PR.
 *   - The DTO `mtime` carries the value in epoch *milliseconds* — same
 *     unit the document stores. The working-set list endpoint at
 *     `/api/assets` returns seconds and has its own DTO shape
 *     (`AssetListItemDto`) that explicitly divides by 1000; do not
 *     conflate the two.
 */

import {
  ObjectId,
  type Filter,
  type Db,
  type UpdateResult,
  type DeleteResult,
  type Collection,
} from "mongodb";
import { assetsCollection } from "./client.ts";
import {
  normaliseEnrichment,
  type AssetDoc,
  type AssetExif,
  type AssetFaceDoc,
  type AssetWithId,
  type Enrichment,
  type EnrichmentStageState,
  type Place,
  type VisionDoc,
  type VisionMeta,
} from "./schema.ts";
import { searchBlobUpdateExpression } from "../enrichment/search-blob.ts";

// ---------------------------------------------------------------------------
// DTO shapes returned over the wire.
// ---------------------------------------------------------------------------

/**
 * Full single-asset DTO returned by `GET /api/assets/:id`.
 *
 * Keeps the snake_case field names from the persisted `AssetDoc` — the
 * working contract today is snake_case on the wire and renaming is out
 * of scope for #132. The `description_meta` field is carried as a
 * passthrough because the describe stage writes it but it isn't typed
 * on `AssetDoc`; we keep it as `unknown` rather than dropping it
 * silently from the response.
 */
export interface AssetDetailDto {
  id: string;
  folder_id: string;
  filename: string;
  abs_path: string;
  size: number;
  /** Epoch milliseconds (same unit the document stores). The list
   * endpoint at `/api/assets` returns seconds and uses its own DTO. */
  mtime: number;
  rating: number;
  flag: -1 | 0 | 1;
  color_label: string;
  indexed_at: string;
  place: Place | null;
  faces: AssetFaceDoc[];
  description: string | null;
  description_meta: unknown;
  ocr_text: string | null;
  ocr_meta: AssetDoc["ocr_meta"] | null;
  vision: VisionDoc | null;
  vision_meta: VisionMeta | null;
  is_screenshot: boolean | null;
  enrichment: Enrichment;
}

/**
 * Working-set list item DTO returned by `GET /api/assets`. NB: `mtime`
 * is reported in *seconds* — the Swift File Provider consumes it via
 * `Date(timeIntervalSince1970:)` which expects seconds. See the inline
 * comment in `routes/assets-list.ts` that justified the division.
 */
export interface AssetListItemDto {
  id: string;
  folder_id: string;
  filename: string;
  abs_path: string;
  /** Epoch seconds (NOT milliseconds — Swift's
   * `Date(timeIntervalSince1970:)` expects seconds). */
  mtime: number;
  rating: number;
  has_xmp: boolean;
}

/** Minimal shape used by routes that need to drive FS / change-feed
 * side effects (xmp, trash, overrides) but don't ship the full DTO to
 * the client. Keeps callers from holding a raw Mongo document. */
export interface AssetCoreInfo {
  id: ObjectId;
  folder_id: ObjectId;
  filename: string;
  abs_path: string;
  size: number;
  mtime: number;
  /** Used by trash / Meilisearch tombstone paths. Null when the hash
   * stage hasn't run on this asset yet. */
  maple_id: string | null;
  deleted_at: string | null;
  original_path: string | null;
  /** Carried for the trash route's Meilisearch re-index branch. */
  place: Place | null;
  description: string | null;
  ocr_text: string | null;
  exif: AssetExif | null;
}

// ---------------------------------------------------------------------------
// Transform layer (the single BSON → DTO boundary for the assets repo).
// ---------------------------------------------------------------------------

function toDetailDto(doc: AssetWithId): AssetDetailDto {
  // `description_meta` is not typed on `AssetDoc` (the describe stage
  // added it after the schema froze). Read through `Record<string,
  // unknown>` so we don't drop the field on the wire — same pattern the
  // pre-refactor `routes/assets/metadata.ts` used inline.
  const rawDoc = doc as unknown as Record<string, unknown>;
  return {
    id: doc._id.toHexString(),
    folder_id: doc.folder_id.toHexString(),
    filename: doc.filename,
    abs_path: doc.abs_path,
    size: doc.size,
    mtime: doc.mtime,
    rating: doc.rating,
    flag: doc.flag,
    color_label: doc.color_label,
    indexed_at: doc.indexed_at,
    place: doc.place ?? null,
    faces: doc.faces ?? [],
    description: doc.description ?? null,
    description_meta: rawDoc.description_meta ?? null,
    ocr_text: doc.ocr_text ?? null,
    ocr_meta: doc.ocr_meta ?? null,
    vision: doc.vision ?? null,
    vision_meta: doc.vision_meta ?? null,
    is_screenshot: doc.is_screenshot ?? null,
    enrichment: normaliseEnrichment(doc.enrichment),
  };
}

function toListItemDto(doc: AssetWithId): AssetListItemDto {
  return {
    id: doc._id.toHexString(),
    folder_id: doc.folder_id.toHexString(),
    filename: doc.filename,
    abs_path: doc.abs_path,
    // `AssetDoc.mtime` is epoch ms (from `stat.mtimeMs`). The list
    // endpoint reports seconds so the Swift File Provider's
    // `Date(timeIntervalSince1970:)` round-trips into a sensible date.
    mtime: Math.floor(doc.mtime / 1000),
    rating: doc.rating,
    has_xmp: doc.has_xmp ?? false,
  };
}

function toCoreInfo(doc: AssetWithId): AssetCoreInfo {
  const rawDoc = doc as unknown as Record<string, unknown>;
  const mapleId = rawDoc.maple_id;
  const originalPath = rawDoc.original_path;
  return {
    id: doc._id,
    folder_id: doc.folder_id,
    filename: doc.filename,
    abs_path: doc.abs_path,
    size: doc.size,
    mtime: doc.mtime,
    maple_id: typeof mapleId === "string" && mapleId.length > 0 ? mapleId : null,
    deleted_at: doc.deleted_at ?? null,
    original_path:
      typeof originalPath === "string" && originalPath.length > 0
        ? originalPath
        : null,
    place: doc.place ?? null,
    description: doc.description ?? null,
    ocr_text: doc.ocr_text ?? null,
    exif: doc.exif ?? null,
  };
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

/**
 * Parse a hex string into an ObjectId. Returns `null` on malformed
 * input so routes can produce a 400 without throwing.
 */
export function parseAssetId(id: string): ObjectId | null {
  try {
    return new ObjectId(id);
  } catch {
    return null;
  }
}

async function coll(dbOverride?: Db): Promise<Collection<AssetDoc>> {
  if (dbOverride) return dbOverride.collection<AssetDoc>("assets");
  return assetsCollection();
}

// ---------------------------------------------------------------------------
// Read methods (return DTOs).
// ---------------------------------------------------------------------------

/** Single asset, full detail DTO (used by `GET /api/assets/:id`). */
export async function findDetailById(
  id: ObjectId,
  dbOverride?: Db,
): Promise<AssetDetailDto | null> {
  const c = await coll(dbOverride);
  const doc = await c.findOne({ _id: id });
  return doc ? toDetailDto(doc as AssetWithId) : null;
}

/** Single asset, minimal info used by routes that drive FS / change-feed
 * side effects rather than shipping the full DTO. */
export async function findCoreInfoById(
  id: ObjectId,
  dbOverride?: Db,
): Promise<AssetCoreInfo | null> {
  const c = await coll(dbOverride);
  const doc = await c.findOne({ _id: id });
  return doc ? toCoreInfo(doc as AssetWithId) : null;
}

/** Filter shape accepted by `findListItems`. All fields are optional —
 * routes assemble the subset they need and the repo defaults the rest. */
export interface ListFilter {
  /** When true, exclude soft-deleted rows. Default `true`. */
  liveOnly?: boolean;
  hasXmp?: boolean;
  ratingGte?: number;
  capturedAfterIso?: string;
}

/** Bounded list query used by `GET /api/assets`. The `limit` is clamped
 * to `[1, 20000]` here so the route doesn't have to duplicate the
 * bounds check. Returns wire DTOs. */
export async function findListItems(
  filter: ListFilter,
  limit: number,
  dbOverride?: Db,
): Promise<AssetListItemDto[]> {
  const c = await coll(dbOverride);
  const mongoFilter: Filter<AssetDoc> = {};
  if (filter.liveOnly !== false) {
    (mongoFilter as Filter<AssetDoc>).deleted_at = null;
  }
  if (filter.hasXmp !== undefined) mongoFilter.has_xmp = filter.hasXmp;
  if (filter.ratingGte !== undefined) {
    mongoFilter.rating = { $gte: filter.ratingGte };
  }
  if (filter.capturedAfterIso !== undefined) {
    (mongoFilter as Filter<AssetDoc>)["exif.captured_at"] = {
      $gt: filter.capturedAfterIso,
    } as never;
  }
  const clamped = Math.min(Math.max(limit, 1), 20000);
  const rows = await c.find(mongoFilter).limit(clamped).toArray();
  return rows.map((r) => toListItemDto(r as AssetWithId));
}

// ---------------------------------------------------------------------------
// Mutation methods. These return Mongo result types (UpdateResult /
// DeleteResult) rather than DTOs — the routes that need a refreshed DTO
// after a write do a follow-up `findDetailById`.
// ---------------------------------------------------------------------------

/** Flip `has_xmp` on a single asset. Called by the XMP write / delete
 * handlers so the working-set filter can find the asset cheaply. */
export async function setHasXmp(
  id: ObjectId,
  value: boolean,
  dbOverride?: Db,
): Promise<UpdateResult> {
  const c = await coll(dbOverride);
  return c.updateOne({ _id: id }, { $set: { has_xmp: value } });
}

/**
 * Set the manual `place` override and recompute `search_blob`
 * atomically (the worker stages do the same recomputation via the
 * shared aggregation expression). `place === null` clears the
 * override.
 */
export async function setPlaceOverride(
  id: ObjectId,
  place: Place | null,
  dbOverride?: Db,
): Promise<UpdateResult> {
  const c = await coll(dbOverride);
  const placeBlob = place?.search_blob ?? null;
  return c.updateOne({ _id: id }, [
    {
      $set: {
        place,
        search_blob: searchBlobUpdateExpression({
          placeSearchBlob: placeBlob,
        }),
      },
    },
  ]);
}

/**
 * Set the manual `description` override and recompute `search_blob`
 * atomically. `text === null` clears the override.
 */
export async function setDescriptionOverride(
  id: ObjectId,
  text: string | null,
  dbOverride?: Db,
): Promise<UpdateResult> {
  const c = await coll(dbOverride);
  return c.updateOne({ _id: id }, [
    {
      $set: {
        description: text,
        search_blob: searchBlobUpdateExpression({ description: text }),
      },
    },
  ]);
}

/**
 * Requeue one enrichment stage on a single asset. Reads the current
 * version, bumps it, and clears the worker-claim fields so the next
 * tick picks the row up. Returns the new version number, or `null`
 * when the asset doesn't exist.
 *
 * Encapsulating the find → mutate workflow here keeps the route from
 * touching Mongo twice.
 */
export async function requeueEnrichmentStage(
  id: ObjectId,
  stage: keyof Enrichment,
  dbOverride?: Db,
): Promise<{ version: number } | null> {
  const c = await coll(dbOverride);
  const doc = await c.findOne({ _id: id });
  if (!doc) return null;
  const current: EnrichmentStageState =
    normaliseEnrichment(doc.enrichment)[stage];
  const nextVersion = (current.version ?? 0) + 1;
  const result = await c.updateOne(
    { _id: id },
    {
      $set: {
        [`enrichment.${stage}.done_at`]: null,
        [`enrichment.${stage}.version`]: nextVersion,
        [`enrichment.${stage}.attempts`]: 0,
        [`enrichment.${stage}.last_error`]: null,
        [`enrichment.${stage}.dead_letter_at`]: null,
        [`enrichment.${stage}.locked_by`]: null,
        [`enrichment.${stage}.lease_expires_at`]: null,
      },
    },
  );
  if (result.matchedCount === 0) return null;
  return { version: nextVersion };
}

// ---------------------------------------------------------------------------
// Trash + restore. These are the multi-step Mongo workflows the trash
// route used to inline; pulling them in here lets the route stop
// touching the collection directly while keeping the FS / Meilisearch /
// change-feed orchestration in the route (the repo doesn't take a
// Meilisearch dependency).
// ---------------------------------------------------------------------------

/**
 * Mark a live asset as soft-deleted and record its pre-trash path.
 * `newAbsPath` is where the FS layer just moved the file; `originalAbsPath`
 * is the location it had before the move. The route writes both; on
 * restore we read `original_path` back out.
 */
export async function markSoftDeleted(args: {
  id: ObjectId;
  newAbsPath: string;
  originalAbsPath: string;
  dbOverride?: Db;
}): Promise<UpdateResult> {
  const c = await coll(args.dbOverride);
  return c.updateOne(
    { _id: args.id },
    {
      $set: {
        abs_path: args.newAbsPath,
        deleted_at: new Date().toISOString(),
        original_path: args.originalAbsPath,
      },
    },
  );
}

/** Permanent purge: drop the doc. Called after the FS layer has
 * removed the file + sidecars. */
export async function hardDelete(
  id: ObjectId,
  dbOverride?: Db,
): Promise<DeleteResult> {
  const c = await coll(dbOverride);
  return c.deleteOne({ _id: id });
}

/**
 * Restore: drop a watcher-inserted transient row at the new abs path
 * (if any), then update the canonical row to point at its new location.
 *
 * The watcher-race delete is bundled in here so the workflow is atomic
 * at the repo layer — splitting it would put two Mongo ops in the route
 * with a Mongo verb in between (the trash route already had this
 * pattern; moving it intact preserves behaviour).
 */
export async function restoreFromTrash(args: {
  id: ObjectId;
  newAbsPath: string;
  filename: string;
  size: number;
  /** ISO string — the route re-stats the file and converts mtimeMs. */
  mtimeIso: string;
  dbOverride?: Db;
}): Promise<UpdateResult> {
  const c = await coll(args.dbOverride);
  // Watcher race: between the FS move and this update, the discover
  // watcher may have observed the file at its new abs_path and inserted
  // a transient row keyed on (folder_id, filename). That row reserves
  // the unique slot and would block the updateOne below — delete any
  // doc at the new abs_path that isn't ours.
  await c.deleteOne({
    abs_path: args.newAbsPath,
    _id: { $ne: args.id },
  });
  return c.updateOne(
    { _id: args.id },
    {
      $set: {
        abs_path: args.newAbsPath,
        filename: args.filename,
        size: args.size,
        // The doc field is typed `number` (epoch ms) elsewhere, but the
        // pre-refactor route wrote an ISO string here when re-stat
        // failed. Preserve that behaviour byte-for-byte — the field is
        // untyped via the cast.
        mtime: args.mtimeIso as unknown as number,
        deleted_at: null,
        original_path: null,
      },
    },
  );
}
