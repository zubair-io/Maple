/**
 * Images repository — thin wrapper over the `assets` collection.
 * Adds the fields the T7 pipeline needs (maple:id, sha1Head, deletedAt)
 * while remaining compatible with the existing `AssetDoc` shape.
 */

import * as path from 'node:path';
import { ObjectId, type Collection, type UpdateResult } from 'mongodb';
import { assetsCollection } from '../db/client.ts';
import { meilisearchClient } from '../enrichment/meilisearch-client.ts';
import {
  pendingEnrichment,
  type AssetDoc,
  type AssetExif,
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

export async function coll(): Promise<Collection<IndexerAssetDoc>> {
  const c = await assetsCollection();
  return c as unknown as Collection<IndexerAssetDoc>;
}

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
 * Mongo predicate for "this asset has ≥2 *live* `fileinfo` entries", used by
 * both the deduplicate worker's candidate `find` and the `/status` pending
 * count so the two stay in sync (#1290).
 *
 * **Query strategy:** we first apply the `fileinfo.1 exists` partial-index
 * filter (`fileinfo_multi_location`) to restrict the scan to the small set of
 * multi-location rows, then use `$expr` + `$filter` to count only the live
 * subset of each row's `fileinfo` array in-memory. This avoids a full
 * COLLSCAN while giving an exact "≥2 live" count rather than the coarser
 * "≥2 total" that the bare index predicate would give.
 *
 * **Tradeoff:** `$expr` with `$filter` is not covered by the partial index
 * (MongoDB cannot use an index to evaluate `$expr` sub-expressions), so the
 * executor does:
 *   1. Index COUNT_SCAN / FETCH over the `fileinfo_multi_location` partial
 *      index (only duplicate-location rows, typically tiny).
 *   2. Per-row in-memory `$filter` over the `fileinfo` array to count live
 *      entries (array is small — usually 2–3 elements).
 *
 * This is safe under the 2 s status cache: step 1 is O(duplicates) not
 * O(total assets), and step 2 is O(fileinfo.length) per row. On a library
 * with 100 k assets but only 1 k duplicates the index prunes to 1 k rows;
 * the per-row work is negligible. A defensible cheaper alternative would be
 * `fileinfo.1 exists AND ≥1 live` (one `$elemMatch`), which also narrows via
 * the partial index and avoids `$expr` entirely, but would still count some
 * one-live + tombstoned-sibling rows. The exact predicate is preferred because
 * it lets the badge reach 0 from deduplicate alone.
 *
 * In `$expr`/`$filter` context, absent fields are NOT automatically `null` —
 * they evaluate to a missing-value that `$in: [null]` does not match. We use
 * `$ifNull` to coerce absent fields to `null` before comparing, so both
 * missing and explicit `null` are treated as "no tag" (live), exactly matching
 * `isLiveFileInfo` which checks `!entry.deleted_at && !entry.missing_since`.
 */
export function liveAwareDuplicatePredicate(): Record<string, unknown> {
  return {
    'fileinfo.1': { $exists: true },
    $expr: {
      $gte: [
        {
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
        },
        2,
      ],
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
export function liveLocationCountExpression(): Record<string, unknown> {
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
 * the dedupe worker uses the exact `liveAwareDuplicatePredicate()` (drift-proof)
 * and only the 2 s-cached `/status` count reads this field.
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
  await collection.updateOne({ _id: id as unknown }, [
    { $set: { live_location_count: liveLocationCountExpression() } },
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
 * True when the asset HAS `fileinfo` entries but none of them is live — i.e.
 * it once had at least one on-disk location and all of them are now gone
 * (every entry `deleted_at` and/or `missing_since`). Distinct from "no
 * fileinfo at all" (a never-located skeleton row) and from "live entry but
 * library unregistered" (a transient/config condition). See `assetAbsPath`
 * for the three null cases.
 */
export function hasOnlySoftDeletedFileInfo(asset: Pick<AssetDoc, 'fileinfo'>): boolean {
  const list = asset.fileinfo;
  if (!list || list.length === 0) return false;
  return assetPrimaryFileInfo(asset) === null;
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

export interface UpsertInput {
  libraryId: ObjectId;
  /** POSIX-style relative directory under the library root. `""` for root. */
  relDir: string;
  filename: string;
  size: number;
  mtime: number;
  mapleId: string;
  sha1Head: string;
  /**
   * EXIF extraction result. `undefined` means the caller (typically a test)
   * did not run exif and we should not write/clear the field. `null` means
   * exif ran and produced no usable data — write `exif: null` so the search
   * route can distinguish "not yet processed" from "no metadata available".
   */
  exif?: AssetExif | null;
}

/**
 * Skeleton upsert (Phase 1, `docs/indexer-enrichment.md` §1.1).
 *
 * Filters on `maple_id` (the new content-addressing identity) and seeds
 * `fileinfo[0]` on first insert. Subsequent calls update the indexer-owned
 * fast-tier fields (size, mtime, sha1_head, exif, indexed_at) without
 * touching the fileinfo array — the discover watcher writes the array
 * directly when it observes new locations or renames.
 *
 * `$setOnInsert` seeds enrichment state and outputs so a re-upsert (e.g.
 * mtime changed) cannot clobber what a worker has already written.
 */
export async function upsertByMapleId(input: UpsertInput): Promise<UpdateResult> {
  const c = await coll();
  const now = new Date().toISOString();
  const setFields: Record<string, unknown> = {
    size: input.size,
    mtime: input.mtime,
    sha1_head: input.sha1Head,
    indexed_at: now,
    deleted_at: null,
  };
  // Only write exif when it was provided (undefined = unwired / test path).
  // null is a meaningful value (exif ran, no metadata) so it must persist.
  if (input.exif !== undefined) {
    setFields.exif = input.exif;
  }
  return c.updateOne(
    { maple_id: input.mapleId },
    {
      $set: setFields,
      $setOnInsert: {
        maple_id: input.mapleId,
        fileinfo: [
          {
            path: input.relDir,
            filename: input.filename,
            library_id: input.libraryId,
            deleted_at: null,
          } as FileInfo,
        ],
        // One live fileinfo entry on insert.
        live_location_count: 1,
        rating: 0,
        flag: 0,
        color_label: '',
        enrichment: pendingEnrichment(),
        place: null,
        faces: [] as AssetFace[],
        description: null,
        ai_tags: [] as string[],
      },
    },
    { upsert: true },
  );
}

export async function findByMapleId(mapleId: string): Promise<IndexerAssetDoc | null> {
  const c = await coll();
  return c.findOne({ maple_id: mapleId });
}

/** Soft-delete by maple_id. Marks `deleted_at` on the row without removing
 * it; GC sweeps later.
 *
 * After the Mongo update, fire a best-effort tombstone into Meilisearch
 * (Phase 7). Failures must NOT propagate — Mongo is canonical, and the
 * search route's `applyLiveFilter` excludes soft-deleted rows from the
 * `$text` fallback regardless of whether the Meilisearch update succeeds.
 */
export async function softDelete(mapleId: string): Promise<void> {
  // Defensive: an empty maple_id can't refer to a real row (the
  // uniqueness contract from #244 makes maple_id mandatory on every
  // live row); skip the Meili tombstone too so we don't pollute the
  // index with empty-key writes. This matches the old "skip Meili
  // when maple_id absent" branch the route used to take itself.
  if (!mapleId) return;
  const c = await coll();
  await c.updateOne({ maple_id: mapleId }, { $set: { deleted_at: new Date().toISOString() } });
  try {
    await meilisearchClient().tombstone(mapleId);
  } catch {
    // The client log-and-swallows on its own; this catch is just
    // defensive against a programmer-error throw inside the client.
  }
}

/** Assets soft-deleted before `olderThan` (ms epoch). Used by GC sweep. */
export async function listExpiredDeletions(olderThanIso: string): Promise<IndexerAssetDoc[]> {
  const c = await coll();
  return c.find({ deleted_at: { $ne: null, $lt: olderThanIso } }).toArray();
}

export async function hardDelete(mapleId: string): Promise<void> {
  const c = await coll();
  await c.deleteOne({ maple_id: mapleId });
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
