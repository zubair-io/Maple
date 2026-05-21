/**
 * Images repository — thin wrapper over the `assets` collection.
 * Adds the fields the T7 pipeline needs (maple:id, sha1Head, deletedAt)
 * while remaining compatible with the existing `AssetDoc` shape.
 */

import * as path from 'node:path';
import type { Collection, ObjectId, UpdateResult } from 'mongodb';
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
 * First live `fileinfo` entry, or `null` when the array is missing or every
 * entry is marked `deleted_at`. "Live" means `deleted_at` is null or absent.
 *
 * This is the only place that knows the entry is at index 0; callers should
 * not depend on the index itself.
 */
export function assetPrimaryFileInfo(asset: Pick<AssetDoc, 'fileinfo'>): FileInfo | null {
  const list = asset.fileinfo;
  if (!list || list.length === 0) return null;
  for (const entry of list) {
    if (!entry.deleted_at) return entry;
  }
  return null;
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
): string | null {
  const primary = assetPrimaryFileInfo(asset);
  if (!primary) return null;
  const root = libraries.get(primary.library_id.toHexString());
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
