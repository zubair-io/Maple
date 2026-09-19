/**
 * Asset-document helpers shared across the indexer, the workers and the routes.
 *
 * Most of this file is pure: given an asset's `fileinfo[]` and the map of
 * registered library roots, work out which entry is the live one and where its
 * bytes are. Those helpers describe the document shape rather than any
 * database, so they survived the SQLite cutover (#3787) untouched — the DTO
 * layer rebuilds the same `fileinfo[]` from `asset_locations` rows
 * (`db/repos/assets.rows.ts`).
 *
 * What did not survive is the storage. The skeleton upsert moved to
 * `db/repos/assets.upsert.ts`, and `findByMapleId` / `softDelete` /
 * `listExpiredDeletions` / `hardDelete` went with the collection: none had a
 * caller left, and the trash workflows they predate live in
 * `db/repos/assets.trash.ts`.
 *
 * Nothing here opens a collection or writes to one. The two denormalised
 * fields this module used to hand-maintain — the live-location count and the
 * asset's media kind — are now derived by database triggers instead, so there
 * is no recompute for a caller to remember: `asset_locations` keeps
 * `assets.live_location_count` in step on every insert, delete and liveness
 * change (`db/sqlite/ddl/asset-locations.ts`), and `stage_state.media_kind`
 * follows `assets.media_kind` the same way (`db/sqlite/ddl/stage-state.ts`).
 */

import * as path from 'node:path';
import { ObjectId } from '../db/object-id.ts';
import {
  type AssetDoc,
  type AssetFaceDoc,
  type Enrichment,
  type FileInfo,
  type Place,
} from '../db/schema.ts';

/**
 * Persisted face-detection result. Re-exported from the schema so existing
 * consumers can keep using the `AssetFace` name; the canonical type lives in
 * `db/schema.ts` so the repo and the read-side both reference the same shape.
 */
export type AssetFace = AssetFaceDoc;

/**
 * Extra indexer-owned fields. Stored on the same `assets` document.
 *
 * `maple_id` is the stable content-derived hex id (see `./id.ts`).
 * `sha1_head` is the hex of SHA-1 over the first 64 KB; used to
 * detect content change without re-hashing the full file.
 *
 * `faces`, `description`, `place` and the `enrichment` sub-document are
 * Phase 2+ enrichment outputs. The fast-tier upsert seeds them on insert via
 * `$setOnInsert` and never touches them again, so worker writes are not
 * clobbered when the file's mtime/sha1Head changes and the indexer re-upserts.
 * `ai_tags` is a legacy AI-stage output kept on $setOnInsert for backward
 * compat; it is not written by Phase 1 and will be replaced by `description`
 * in Phase 6.
 */
export interface IndexerAssetFields {
  maple_id?: string;
  sha1_head?: string;
  deleted_at?: string | null;
  faces?: AssetFace[];
  ai_tags?: string[];
  enrichment?: Enrichment;
  place?: Place | null;
  description?: string | null;
}

export type IndexerAssetDoc = AssetDoc & IndexerAssetFields;

// ---------------------------------------------------------------------------
// Location helpers (content-addressing migration)
//
// `fileinfo[]` is the canonical location record. After the
// drop-abs-path-2026-05-21 migration the legacy `abs_path` / `folder_id` /
// `filename` fallbacks were retired: these helpers consult fileinfo only.
// ---------------------------------------------------------------------------

/**
 * A `fileinfo` entry is **live** when it holds this asset's content at a path
 * that is on disk: neither `deleted_at` (bytes replaced by other content) nor
 * `missing_since` (file vanished) is set. This is the predicate for stage
 * eligibility (`buildClaimQuery`), dedupe, primary-location resolution below,
 * AND search visibility (`applyLiveFilter` in `routes/search/query.ts`): a
 * search result must have a resolvable primary, else the projection emits a
 * blank `fs:` row with an empty path.
 */
export function isLiveFileInfo(entry: Pick<FileInfo, 'deleted_at' | 'missing_since'>): boolean {
  return !entry.deleted_at && !entry.missing_since;
}

/**
 * First live `fileinfo` entry, or `null` when the array is missing or every
 * entry is non-live (`deleted_at` and/or `missing_since` set). "Live" is
 * defined by {@link isLiveFileInfo}.
 *
 * This is the only place that knows the entry is at index 0; callers should
 * not depend on the index itself.
 */
export function assetPrimaryFileInfo(asset: Pick<AssetDoc, 'fileinfo'>): FileInfo | null {
  const list = asset.fileinfo;
  if (!list || list.length === 0) return null;
  for (const entry of list) {
    if (isLiveFileInfo(entry)) return entry;
  }
  return null;
}

/**
 * `slug:relPath` address of an asset's primary file, or null when the
 * owning library has no slug (pre-M1 install) or no live fileinfo exists.
 * `idToSlug` comes from `loadLibraryIdToSlug()` — passed in so batch
 * callers resolve the map once.
 */
export function assetAddress(
  asset: Pick<AssetDoc, 'fileinfo'>,
  idToSlug: ReadonlyMap<string, string>,
): string | null {
  const primary = assetPrimaryFileInfo(asset);
  if (!primary) return null;
  const slug = idToSlug.get(primary.library_id.toHexString());
  if (!slug) return null;
  const relPath = primary.path ? `${primary.path}/${primary.filename}` : primary.filename;
  return `${slug}:${relPath}`;
}

/**
 * Library root absolute path for this asset's primary location, looked up
 * in the supplied `libraries` map (`hex(_id) → root path`).
 *
 * Returns `null` when the primary entry's `library_id` is not present in
 * `libraries` (the registered folder has been removed) or when the asset
 * has no live `fileinfo` entry at all.
 */
export function assetLibraryPath(
  asset: Pick<AssetDoc, 'fileinfo'>,
  libraries: ReadonlyMap<string, string>,
): string | null {
  const primary = assetPrimaryFileInfo(asset);
  if (!primary) return null;
  const root = libraries.get(primary.library_id.toHexString());
  return root ?? null;
}

/**
 * Resolve the absolute filesystem path of the asset's primary location.
 *
 * Composed from `(library root, fileinfo[0].path, fileinfo[0].filename)`.
 * `fileinfo.path` is stored POSIX-style (`/` separators); we re-split on
 * `/` so that on a Windows host the join uses platform-correct separators
 * via `path.join`. On Linux/macOS (the production target) the split is a
 * no-op.
 *
 * Returns `null` when the primary entry's `library_id` is not present in
 * `libraries` (the registered folder has been removed) or when the asset
 * has no live `fileinfo` entry. Callers MUST handle the null and decide
 * whether to 404, skip, or log.
 */
export function assetAbsPath(
  asset: Pick<AssetDoc, 'fileinfo'>,
  libraries: ReadonlyMap<string, string>,
  options?: { allowMissing?: boolean },
): string | null {
  const list = asset.fileinfo;
  if (!list || list.length === 0) return null;

  let primary: FileInfo | null = null;
  // First pass: look for a fully live entry (neither deleted nor missing)
  for (const entry of list) {
    if (!entry.deleted_at && !entry.missing_since) {
      primary = entry;
      break;
    }
  }
  // Fallback if allowMissing is true: look for any active entry (not deleted, even if missing)
  if (!primary && options?.allowMissing) {
    for (const entry of list) {
      if (!entry.deleted_at) {
        primary = entry;
        break;
      }
    }
  }
  if (!primary) return null;

  const libraryIdStr =
    typeof primary.library_id === 'string'
      ? new ObjectId(primary.library_id).toHexString()
      : primary.library_id.toHexString();
  const root = libraries.get(libraryIdStr);
  if (!root) return null;
  const segments = primary.path === '' ? [] : primary.path.split('/');
  return path.join(root, ...segments, primary.filename);
}

/** True when an error is a filesystem "no such file or directory".
 *
 * Used by the stage runner to decide whether a stage failure means the
 * on-disk original vanished — in which case it stamps `missing_since` (the
 * "pending delete" tag the missing-reaper consumes). Only stages that read
 * the original opt in via `StageConfig.tagsMissingOnEnoent`. */
export function isEnoentError(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === 'ENOENT';
}
