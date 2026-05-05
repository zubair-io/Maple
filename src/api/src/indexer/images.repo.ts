/**
 * Images repository — thin wrapper over the `assets` collection.
 * Adds the fields the T7 pipeline needs (maple:id, sha1Head, deletedAt)
 * while remaining compatible with the existing `AssetDoc` shape.
 */

import type { Collection, ObjectId, UpdateResult } from "mongodb";
import { assetsCollection } from "../db/client.ts";
import type { AssetDoc, AssetExif } from "../db/schema.ts";

/**
 * Persisted face-detection result. The shape mirrors `AiFace` in `pipeline.ts`;
 * `embedding` is stored only when a real detector has run (Float32 as an
 * array of numbers so Mongo can round-trip it).
 */
export interface AssetFace {
  bbox: { x: number; y: number; w: number; h: number };
  person_id: string | null;
  confidence: number;
  embedding?: number[];
}

/**
 * Extra indexer-owned fields. Stored on the same `assets` document.
 *
 * `maple_id` is the stable content-derived hex id (see `./id.ts`).
 * `sha1_head` is the hex of SHA-1 over the first 64 KB; used to
 * detect content change without re-hashing the full file.
 * `faces` / `ai_tags` are written by the ai stage (empty today). They are
 * always present so consumers can index `faces.person_id` without sparse
 * index gymnastics.
 */
export interface IndexerAssetFields {
  maple_id?: string;
  sha1_head?: string;
  deleted_at?: string | null;
  faces?: AssetFace[];
  ai_tags?: string[];
}

export type IndexerAssetDoc = AssetDoc & IndexerAssetFields;

export async function coll(): Promise<Collection<IndexerAssetDoc>> {
  const c = await assetsCollection();
  return c as unknown as Collection<IndexerAssetDoc>;
}

export interface UpsertFaceInput {
  bbox: { x: number; y: number; w: number; h: number };
  personId: string | null;
  confidence: number;
  embedding?: Float32Array | number[];
}

export interface UpsertInput {
  folderId: ObjectId;
  filename: string;
  absPath: string;
  size: number;
  mtime: number;
  mapleId: string;
  sha1Head: string;
  faces?: UpsertFaceInput[];
  aiTags?: string[];
  /**
   * EXIF extraction result. `undefined` means the caller (typically a test)
   * did not run exif and we should not write/clear the field. `null` means
   * exif ran and produced no usable data — write `exif: null` so the search
   * route can distinguish "not yet processed" from "no metadata available".
   */
  exif?: AssetExif | null;
}

function faceToDoc(f: UpsertFaceInput): AssetFace {
  const out: AssetFace = {
    bbox: f.bbox,
    person_id: f.personId,
    confidence: f.confidence,
  };
  if (f.embedding) {
    out.embedding = Array.from(f.embedding);
  }
  return out;
}

export async function upsertByMapleId(input: UpsertInput): Promise<UpdateResult> {
  const c = await coll();
  const now = new Date().toISOString();
  const faces: AssetFace[] = (input.faces ?? []).map(faceToDoc);
  const aiTags: string[] = input.aiTags ?? [];
  // Filter on the unique index (folder_id, filename), not on maple_id. The
  // function name is historical — mapleId is a stable secondary identifier
  // derived from EXIF + file bytes, but the asset's *identity* in the
  // collection is its (folder_id, filename) pair (that's the unique index).
  // Filtering on maple_id meant a re-scan that derived a slightly different
  // mapleId (older indexer runs that left maple_id null, or capturedAt that
  // changed since last index) would miss the existing row, then the upsert
  // would try to insert and collide on the unique index → E11000 spam.
  // Filtering on (folder_id, filename) hits the existing row and updates
  // maple_id alongside the rest of the metadata.
  const setFields: Record<string, unknown> = {
    abs_path: input.absPath,
    size: input.size,
    mtime: input.mtime,
    sha1_head: input.sha1Head,
    maple_id: input.mapleId,
    indexed_at: now,
    deleted_at: null,
    faces,
    ai_tags: aiTags,
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
