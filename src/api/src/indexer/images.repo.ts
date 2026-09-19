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
 * Nothing here opens a collection any more. What is left is the document
 * helpers — the ones that read a `fileinfo` array and answer a question about
 * it — which are pure functions over a shape the SQLite rows are still
 * assembled into, plus a few query-fragment builders whose last callers are
 * going with them. Each of those is noted at its own declaration.
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
import { mediaKindExpression } from './media-types.ts';

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
 * Mongo `$elemMatch` fragment that selects assets with at least one live
 * fileinfo entry (neither `deleted_at` nor `missing_since` set). The
 * `{ $in: [null] }` form treats a missing field as live (legacy rows wrote
 * neither tag), matching `isLiveFileInfo`. Used by `buildClaimQuery` (stage
 * claims), the dedupe worker, and search visibility (`applyLiveFilter` in
 * `routes/search/query.ts`) — a search result must have a resolvable primary
 * location, else the projection emits a blank `fs:` row that renders no
 * thumbnail and opens nothing.
 */
export function liveFileInfoElemMatch(): Record<string, unknown> {
  return {
    fileinfo: {
      $elemMatch: {
        deleted_at: { $in: [null] },
        missing_since: { $in: [null] },
      },
    },
  };
}

/**
 * MongoDB aggregation expression that counts live `fileinfo` entries (where
 * neither `deleted_at` nor `missing_since` is set). Identical liveness
 * definition as `isLiveFileInfo`. Used in pipeline `$set` stages so the
 * denormalized `live_location_count` field is recomputed atomically in the
 * same update that mutates the array (#1302).
 *
 * In aggregation context, absent fields evaluate to a missing-value that
 * `$eq: null` does NOT match — we use `$ifNull` to coerce absent → `null`
 * before comparing, matching `isLiveFileInfo` exactly.
 */
function liveLocationCountExpression(): Record<string, unknown> {
  return {
    $size: {
      $filter: {
        input: { $ifNull: ['$fileinfo', []] },
        cond: {
          $and: [
            { $eq: [{ $ifNull: ['$$this.deleted_at', null] }, null] },
            { $eq: [{ $ifNull: ['$$this.missing_since', null] }, null] },
          ],
        },
      },
    },
  };
}

/**
 * Recompute `live_location_count` from the stored `fileinfo` array for one
 * asset identified by `_id`. Called after any mutation that changes liveness
 * of an array element (set/clear `missing_since` or `deleted_at`, `$pull`).
 *
 * This helper issues its OWN single pipeline `updateOne` that atomically
 * recomputes `live_location_count` from `$fileinfo`. It is normally called as
 * a SEPARATE round-trip AFTER the mutation that changed liveness, so there is
 * a brief window where the stored count is stale. That window is safe because:
 * the dedupe worker counts live locations from the column directly
 * (drift-proof) and only the 2 s-cached `/status` count reads this field.
 *
 * Callers that already issue a pipeline update themselves (e.g. adding a new
 * entry via `$concatArrays`) should inline `liveLocationCountExpression()`
 * instead of calling this separately, to avoid a second round-trip.
 *
 * ── EXHAUSTIVE SITE REGISTRY ────────────────────────────────────────────────
 * Every site that adds/removes a fileinfo entry OR sets/clears a per-entry
 * `deleted_at` / `missing_since` MUST either call this function or inline
 * `liveLocationCountExpression()`. If you add a 9th site, add it here too.
 *
 * Site 1 — workers/discover/handle-event.ts
 *   • tag `fileinfo.$[e].missing_since` (remove event)   → updateLiveLocationCount
 *   • clear `fileinfo.$[entry].deleted_at + missing_since` (re-add known loc) → updateLiveLocationCount
 *   • replace fileinfo array with `$concatArrays` (new location)              → inline liveLocationCountExpression
 *   • tag `fileinfo.$[entry].deleted_at + missing_since` (stale-at-path)      → updateLiveLocationCount
 *   • clear during dedup-merge                                                 → updateLiveLocationCount ×2
 *
 * Site 2 — workers/dedupe.ts
 *   • tag `fileinfo.$[e].missing_since` (mark absent entries)  → updateLiveLocationCount
 *   • `$pull` entry (collapse to primary)                      → updateLiveLocationCount
 *
 * Site 3 — workers/tag-missing.ts
 *   • tag `fileinfo.$[e].missing_since` (stage runner ENOENT) → updateLiveLocationCount (best-effort)
 *
 * Site 4 — workers/missing-reaper.ts
 *   • clear `fileinfo.$[r].missing_since` (file recovered)    → updateLiveLocationCount
 *
 * Site 5 — workers/stages/exif.ts
 *   • clear `fileinfo.$[entry].deleted_at` (exif merge)       → updateLiveLocationCount ×2
 *
 * Site 6 — routes/backup-ingest.ts
 *   • `$push fileinfo` (cross-library dedup, add new entry)   → updateLiveLocationCount
 *   • `insertOne` (fresh asset)                               → live_location_count: 1 inline
 *
 * Site 7 — routes/folders.ts (upload route)
 *   • `$set { fileinfo: [singleEntry], deleted_at }` (re-upload-overwrite) → updateLiveLocationCount (#1302)
 *   • `findOneAndUpdate upsert` INSERT arm (`$setOnInsert`)                → live_location_count: 1 in $setOnInsert (#1302)
 *
 * Site 8 — workers/migration/move-backup-asset.ts :: dedupeLiveFileinfo
 *   • `$set { fileinfo: deduped }` (collapse discover-race dup entry)      → updateLiveLocationCount (#1302)
 *
 * NO-OP sites (do NOT require recompute):
 *   • db/assets.trash.ts markSoftDeleted / restoreFromTrash: rewrites the
 *     fileinfo entry's (path, filename) to the trash / restore path, and sets
 *     the TOP-LEVEL asset `deleted_at`. Per-entry `deleted_at` is NOT touched
 *     — the entry stays live throughout. Count is unchanged.
 *   • workers/trash-gc.ts: calls `deleteOne` — doc is gone, no recompute needed.
 *   • db/migrations.ts backfill-fileinfo-from-abs-path: one-time startup
 *     migration; `backfill-live-location-count` (also a startup migration)
 *     runs after and populates the field for all pre-existing rows.
 *   • db/client.ts missing_since migration: same — runs at startup before the
 *     backfill-live-location-count migration.
 *   • indexer/images.repo.ts softDelete: sets TOP-LEVEL `deleted_at` only.
 *   • workers/migration/move-backup-asset.ts moveBackupAsset positional $:
 *     updates `fileinfo.$.path / filename` of ONE entry — no change to liveness.
 * ────────────────────────────────────────────────────────────────────────────
 */
/** Minimal structural interface so call sites don't need `as never` casts. */
interface CollectionWithUpdateOne {
  updateOne(filter: Record<string, unknown>, update: Record<string, unknown>[]): Promise<unknown>;
}

export async function updateLiveLocationCount(
  collection: CollectionWithUpdateOne,
  id: ObjectId,
): Promise<void> {
  // `media_kind` rides along (#3492): every site that appends a location
  // (discover dedup, cross-library backup ingest) ends here, and a still
  // asset that gains a `.MOV` location must become `video` for the media
  // stages and migrations to see it.
  await collection.updateOne({ _id: id as unknown }, [
    {
      $set: {
        live_location_count: liveLocationCountExpression(),
        media_kind: mediaKindExpression(),
      },
    },
  ]);
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
