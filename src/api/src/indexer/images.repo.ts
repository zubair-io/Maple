/**
 * Images repository — thin wrapper over the `assets` collection.
 * Adds the fields the T7 pipeline needs (maple:id, sha1Head, deletedAt)
 * while remaining compatible with the existing `AssetDoc` shape.
 */

import type { Collection, ObjectId, UpdateResult } from "mongodb";
import { assetsCollection } from "../db/client.ts";
import { meilisearchClient } from "../enrichment/meilisearch-client.ts";
import {
  pendingEnrichment,
  type AssetDoc,
  type AssetExif,
  type AssetFaceDoc,
  type Enrichment,
  type Place,
} from "../db/schema.ts";

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

export interface UpsertInput {
  folderId: ObjectId;
  filename: string;
  absPath: string;
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
 * `$set` carries only fast-tier fields the indexer is authoritative for
 * (size, mtime, sha1Head, mapleId, exif, abs_path). `$setOnInsert` seeds
 * enrichment state and outputs (`enrichment`, `place`, `faces`, `description`,
 * `ai_tags`) so a re-upsert from the watcher (e.g. mtime changed) cannot
 * clobber what a Phase 2+ worker has already written.
 *
 * The filter is on the unique index (folder_id, filename), not on maple_id:
 * the function name is historical. mapleId is a stable secondary identifier
 * derived from EXIF + file bytes, but the asset's *identity* in the
 * collection is its (folder_id, filename) pair. Filtering on maple_id meant
 * a re-scan that derived a slightly different mapleId would miss the existing
 * row and then collide on the unique index → E11000 spam.
 */
export async function upsertByMapleId(input: UpsertInput): Promise<UpdateResult> {
  const c = await coll();
  const now = new Date().toISOString();
  const setFields: Record<string, unknown> = {
    abs_path: input.absPath,
    size: input.size,
    mtime: input.mtime,
    sha1_head: input.sha1Head,
    maple_id: input.mapleId,
    indexed_at: now,
    deleted_at: null,
  };
  // Only write exif when it was provided (undefined = unwired / test path).
  // null is a meaningful value (exif ran, no metadata) so it must persist.
  if (input.exif !== undefined) {
    setFields.exif = input.exif;
  }
  return c.updateOne(
    { folder_id: input.folderId, filename: input.filename },
    {
      $set: setFields,
      $setOnInsert: {
        folder_id: input.folderId,
        filename: input.filename,
        rating: 0,
        flag: 0,
        color_label: "",
        enrichment: pendingEnrichment(),
        place: null,
        faces: [] as AssetFace[],
        description: null,
        ai_tags: [] as string[],
      },
    },
    { upsert: true }
  );
}

export async function findByMapleId(mapleId: string): Promise<IndexerAssetDoc | null> {
  const c = await coll();
  return c.findOne({ maple_id: mapleId });
}

export async function findByAbsPath(absPath: string): Promise<IndexerAssetDoc | null> {
  const c = await coll();
  return c.findOne({ abs_path: absPath });
}

/** Soft-delete: mark deletedAt without removing the row. GC sweeps later.
 *
 * After the Mongo update, fire a best-effort tombstone into Meilisearch
 * (Phase 7). Failures must NOT propagate — Mongo is canonical, and the
 * search route's `applyLiveFilter` excludes soft-deleted rows from the
 * `$text` fallback regardless of whether the Meilisearch update succeeds.
 */
export async function softDelete(absPath: string): Promise<void> {
  const c = await coll();
  // Read the maple_id first so we can address the same row in Meilisearch.
  // Skipping when the row doesn't exist or pre-dates the maple_id field
  // (Phase 1 introduced it; older rows simply aren't in Meilisearch
  // either, so a no-op is correct).
  const existing = await c.findOne(
    { abs_path: absPath },
    { projection: { maple_id: 1 } },
  );
  await c.updateOne(
    { abs_path: absPath },
    { $set: { deleted_at: new Date().toISOString() } }
  );
  const mapleId = existing?.maple_id;
  if (typeof mapleId === "string" && mapleId.length > 0) {
    try {
      await meilisearchClient().tombstone(mapleId);
    } catch {
      // The client log-and-swallows on its own; this catch is just
      // defensive against a programmer-error throw inside the client.
    }
  }
}

/** After a rename, keep the maple:id but update the path + filename. */
export async function updatePath(
  mapleId: string,
  absPath: string,
  filename: string
): Promise<void> {
  const c = await coll();
  await c.updateOne(
    { maple_id: mapleId },
    {
      $set: {
        abs_path: absPath,
        filename,
        deleted_at: null,
        indexed_at: new Date().toISOString(),
      },
    }
  );
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
