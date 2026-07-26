/**
 * Assets repository — Mongo `assets` collection access for the API routes.
 *
 * Owns the BSON ↔ wire-DTO transform for every `/api/assets/*` endpoint
 * that lives under `src/routes/assets/` plus the working-set list at
 * `src/routes/assets-list.ts`. Routes never touch `assetsCollection()`
 * directly any more; they go through the named functions exported here.
 *
 * File layout (split for #205's 400-LOC budget):
 *   - `assets.transform.ts`   DTO shapes + BSON→DTO transforms
 *   - `assets.trash.ts`       Soft-delete / hard-delete / restore workflows
 *   - `assets.repo.ts`        Reads + non-trash mutations (this file)
 *
 * Trash and transform symbols are re-exported here so callers can keep
 * a single import surface (`from "../db/assets.repo.ts"`). Adding a new
 * helper? Pick the file by responsibility, then re-export it below.
 *
 * Scope note (issue #132 incremental rollout): two repos cover the same
 * collection on purpose during the migration. This file is the
 * API-facing repo and produces wire DTOs. `src/indexer/images.repo.ts`
 * stays as the indexer-internal helper used by workers — it returns
 * snake_case `IndexerAssetDoc` shapes that are written back to Mongo,
 * not sent to clients. Unifying the two is a follow-up. See issue #132
 * body.
 */

import { ObjectId, type Filter, type Db, type UpdateResult, type Collection } from 'mongodb';
import { assetsCollection } from './client.ts';
import { loadLibraryRoots } from '../indexer/libraries.cache.ts';
import {
  normaliseEnrichment,
  type AssetDoc,
  type AssetWithId,
  type Enrichment,
  type EnrichmentStageState,
  type Place,
} from './schema.ts';
import { searchBlobUpdateExpression } from '../enrichment/search-blob.ts';
import {
  toDetailDto,
  toListItemDto,
  toCoreInfo,
  type AssetDetailDto,
  type AssetListItemDto,
  type AssetCoreInfo,
} from './assets.transform.ts';

// Re-exports so existing call sites can keep `from "../db/assets.repo.ts"`
// for both the read/mutate verbs and the DTO / trash helpers. New code
// MAY import the split files directly; both shapes are supported.
export type { AssetDetailDto, AssetListItemDto, AssetCoreInfo };
export { markSoftDeleted, hardDelete, restoreFromTrash } from './assets.trash.ts';

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
  if (dbOverride) return dbOverride.collection<AssetDoc>('assets');
  return assetsCollection();
}

// ---------------------------------------------------------------------------
// Read methods (return DTOs).
// ---------------------------------------------------------------------------

/**
 * Resolve the library-roots map. A transient DB hiccup mustn't break
 * transform paths: fall back to an empty map and let `abs_path` resolve
 * to `""` (every route handler tolerates that).
 *
 * When `dbOverride` is provided (tests), reads the folders collection
 * directly from that DB so test fixtures and the route's data share a
 * single Mongo instance. The process-wide cache is bypassed in that
 * case so two tests targeting different databases don't share entries.
 */
async function safeLoadLibraries(dbOverride?: Db): Promise<ReadonlyMap<string, string>> {
  try {
    if (dbOverride) {
      const docs = await dbOverride
        .collection('folders')
        .find({}, { projection: { path: 1 } })
        .toArray();
      const map = new Map<string, string>();
      for (const d of docs) {
        map.set((d._id as ObjectId).toHexString(), d.path as string);
      }
      return map;
    }
    return await loadLibraryRoots();
  } catch {
    return new Map();
  }
}

/** Single asset, full detail DTO (used by `GET /api/assets/:id`). */
export async function findDetailById(
  id: ObjectId,
  dbOverride?: Db,
): Promise<AssetDetailDto | null> {
  const c = await coll(dbOverride);
  const doc = await c.findOne({ _id: id });
  if (!doc) return null;
  const libs = await safeLoadLibraries(dbOverride);
  return toDetailDto(doc as AssetWithId, libs);
}

/**
 * Single asset resolved by its library + library-relative path rather than by
 * Mongo id.
 *
 * The Angular browse grid lists directories through `/api/fs/dir-fast`, a pure
 * filesystem walk that deliberately carries no Mongo `_id` (that is the point
 * of the "fast" variant). Its assets are keyed by the `slug:relPath` address,
 * so the enrichment pane needs a way to reach the detail DTO from that address
 * alone. Backs `GET /api/assets/by-address`.
 *
 * `relPath` is POSIX, library-root-relative, and includes the filename
 * (`"vacation/2024/IMG_1.dng"`, or `"root.dng"` at the library root). Matching
 * is scoped to `libraryId` so the same relative path in a different library
 * never collides.
 */
export async function findDetailByAddress(
  libraryId: ObjectId,
  relPath: string,
  dbOverride?: Db,
): Promise<AssetDetailDto | null> {
  const normalised = relPath.replace(/^\/+/, '');
  const lastSlash = normalised.lastIndexOf('/');
  // `fileinfo.path` holds the directory only ("" at the library root) and
  // `fileinfo.filename` the basename — split the address the same way.
  const dirPath = lastSlash === -1 ? '' : normalised.slice(0, lastSlash);
  const filename = lastSlash === -1 ? normalised : normalised.slice(lastSlash + 1);
  if (filename === '') return null;

  const c = await coll(dbOverride);
  const doc = await c.findOne({
    fileinfo: { $elemMatch: { library_id: libraryId, path: dirPath, filename } },
  });
  if (!doc) return null;
  const libs = await safeLoadLibraries(dbOverride);
  return toDetailDto(doc as AssetWithId, libs);
}

/** Single asset, minimal info used by routes that drive FS / change-feed
 * side effects rather than shipping the full DTO. */
export async function findCoreInfoById(
  id: ObjectId,
  dbOverride?: Db,
): Promise<AssetCoreInfo | null> {
  const c = await coll(dbOverride);
  const doc = await c.findOne({ _id: id });
  if (!doc) return null;
  const libs = await safeLoadLibraries(dbOverride);
  return toCoreInfo(doc as AssetWithId, libs);
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
    (mongoFilter as Filter<AssetDoc>)['exif.captured_at'] = {
      $gt: filter.capturedAfterIso,
    } as never;
  }
  // Normalize non-integer / NaN `limit` to the default before clamping —
  // `Math.min(Math.max(NaN, 1), 20000)` returns NaN, which Mongo treats
  // as "no limit" and returns the entire collection. Routes already
  // validate user input, but this is a defensive backstop for direct
  // repo callers.
  const safeLimit = Number.isFinite(limit) && limit >= 1 ? limit : 1000;
  const clamped = Math.min(Math.max(safeLimit, 1), 20000);
  const rows = await c.find(mongoFilter).limit(clamped).toArray();
  const libs = await safeLoadLibraries(dbOverride);
  return rows.map((r) => toListItemDto(r as AssetWithId, libs));
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
 * Record an XMP edit: mark `has_xmp` and bump the monotonic `sidecar_ver`
 * edit counter, in one atomic `$set` + `$inc`.
 *
 * `sidecar_ver` is retained as a general edit-generation counter (consumed by
 * the client editor write-policy work in #2009/#2010); it no longer keys any
 * preview cache file. The preview is a single, unversioned `<filename>.avif`
 * (#2017) — the editor overwrites it in place on edit and the serving routes
 * bust their ETag from the file's own mtime/size, so there is no per-version
 * developed-preview file to re-arm a stage for.
 */
export async function recordSidecarEdit(id: ObjectId, dbOverride?: Db): Promise<UpdateResult> {
  const c = await coll(dbOverride);
  return c.updateOne({ _id: id }, { $set: { has_xmp: true }, $inc: { sidecar_ver: 1 } });
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
        'stages.meili.version': 0,
        'stages.meili.attempts': 0,
        'stages.meili.last_error': null,
        'stages.meili.processed_at': null,
        'stages.meili.dead': false,
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
        'stages.meili.version': 0,
        'stages.meili.attempts': 0,
        'stages.meili.last_error': null,
        'stages.meili.processed_at': null,
        'stages.meili.dead': false,
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
  const current: EnrichmentStageState = normaliseEnrichment(doc.enrichment)[stage];
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
