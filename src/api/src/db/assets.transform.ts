/**
 * Assets repository — BSON ↔ wire-DTO transform layer.
 *
 * Split out of `assets.repo.ts` so the file budget per #205 stays under
 * 400 LOC. The transforms here are the single boundary between Mongo
 * documents and the JSON the API ships to clients; the repo modules
 * import these helpers and never mutate the shapes inline.
 *
 * Wire-DTO convention (preserves the existing contract — the Swift
 * client and the Angular shell both read snake_case keys today):
 *   - `_id` is rendered as `id` (hex string).
 *   - `folder_id` ObjectId is rendered as the same hex string.
 *   - Every other persisted snake_case field name passes through
 *     verbatim. Renaming to camelCase is a separate breaking change
 *     and is not in scope for this PR.
 *   - The detail DTO `mtime` carries the value in epoch *milliseconds* —
 *     same unit the document stores. The working-set list endpoint at
 *     `/api/assets` returns seconds and has its own DTO shape
 *     (`AssetListItemDto`) that explicitly divides by 1000; do not
 *     conflate the two.
 */

import { type ObjectId } from 'mongodb';
import {
  normaliseEnrichment,
  type AssetDoc,
  type AssetExif,
  type AssetFaceDoc,
  type AssetWithId,
  type Enrichment,
  type FileInfo,
  type Place,
  type VisionDoc,
  type VisionMeta,
} from './schema.ts';

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
  ocr_meta: AssetDoc['ocr_meta'] | null;
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
  /** Canonical location records — populated by discover / backup-ingest.
   * Carried alongside `abs_path` during the content-addressing migration
   * so route handlers can resolve the on-disk path via
   * `assetAbsPath(info, libraries)`. Absent on legacy rows that the
   * backfill hasn't reached yet; `assetAbsPath` falls back to `abs_path`
   * in that case. */
  fileinfo?: FileInfo[];
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

export function toDetailDto(doc: AssetWithId): AssetDetailDto {
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

export function toListItemDto(doc: AssetWithId): AssetListItemDto {
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

export function toCoreInfo(doc: AssetWithId): AssetCoreInfo {
  const rawDoc = doc as unknown as Record<string, unknown>;
  const mapleId = rawDoc.maple_id;
  const originalPath = rawDoc.original_path;
  return {
    id: doc._id,
    folder_id: doc.folder_id,
    filename: doc.filename,
    abs_path: doc.abs_path,
    fileinfo: doc.fileinfo,
    size: doc.size,
    mtime: doc.mtime,
    maple_id: typeof mapleId === 'string' && mapleId.length > 0 ? mapleId : null,
    deleted_at: doc.deleted_at ?? null,
    original_path:
      typeof originalPath === 'string' && originalPath.length > 0 ? originalPath : null,
    place: doc.place ?? null,
    description: doc.description ?? null,
    ocr_text: doc.ocr_text ?? null,
    exif: doc.exif ?? null,
  };
}
