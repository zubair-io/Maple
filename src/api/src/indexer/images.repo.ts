/**
 * Images repository — thin wrapper over the `assets` collection.
 * Adds the fields the T7 pipeline needs (maple:id, sha1Head, deletedAt)
 * while remaining compatible with the existing `AssetDoc` shape.
 */

import type { Collection, ObjectId, UpdateResult } from "mongodb";
import { assetsCollection } from "../db/client.ts";
import type { AssetDoc } from "../db/schema.ts";

/**
 * Extra indexer-owned fields. Stored on the same `assets` document.
 *
 * `maple_id` is the stable content-derived hex id (see `./id.ts`).
 * `sha1_head` is the hex of SHA-1 over the first 64 KB; used to
 * detect content change without re-hashing the full file.
 */
export interface IndexerAssetFields {
  maple_id?: string;
  sha1_head?: string;
  deleted_at?: string | null;
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
}

export async function upsertByMapleId(input: UpsertInput): Promise<UpdateResult> {
  const c = await coll();
  const now = new Date().toISOString();
  return c.updateOne(
    { maple_id: input.mapleId },
    {
      $set: {
        folder_id: input.folderId,
        filename: input.filename,
        abs_path: input.absPath,
        size: input.size,
        mtime: input.mtime,
        sha1_head: input.sha1Head,
        indexed_at: now,
        deleted_at: null,
      },
      $setOnInsert: {
        maple_id: input.mapleId,
        rating: 0,
        flag: 0,
        color_label: "",
        thumb_hash: null,
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

/** Soft-delete: mark deletedAt without removing the row. GC sweeps later. */
export async function softDelete(absPath: string): Promise<void> {
  const c = await coll();
  await c.updateOne(
    { abs_path: absPath },
    { $set: { deleted_at: new Date().toISOString() } }
  );
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
