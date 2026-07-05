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

import * as path from 'node:path';
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

/**
 * Resolve the canonical wire fields for an asset's primary location from
 * its `fileinfo` array and the supplied libraries map. Returns nulls when
 * the asset has no live fileinfo entry or its library is no longer
 * registered — the transforms surface those as empty strings on the wire
 * (existing contract) and the resolved string when present.
 */
function resolvePrimary(
  fileinfo: FileInfo[] | undefined,
  libraries: ReadonlyMap<string, string>,
): {
  folder_id: ObjectId | null;
  filename: string;
  abs_path: string;
  fileinfo: FileInfo[] | undefined;
} {
  if (!fileinfo || fileinfo.length === 0) {
    return { folder_id: null, filename: '', abs_path: '', fileinfo };
  }
  // Primary = first LIVE location (neither replaced nor missing from disk), so
  // the DTO's path points at a file that actually exists. Mirrors
  // `assetPrimaryFileInfo`. Falls back to `fileinfo[0]` when nothing is live so
  // a fully-gone row still resolves a `folder_id` (always set from the chosen
  // entry's `library_id`); only `abs_path` is empty — when the library root is
  // unregistered. Callers tolerate the empty `abs_path`.
  const primary = fileinfo.find((e) => !e.deleted_at && !e.missing_since) ?? fileinfo[0]!;
  const root = libraries.get(primary.library_id.toHexString()) ?? '';
  const segments = primary.path === '' ? [] : primary.path.split('/');
  const abs_path = root ? path.join(root, ...segments, primary.filename) : '';
  return {
    folder_id: primary.library_id,
    filename: primary.filename,
    abs_path,
    fileinfo,
  };
}

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
  /** Resolved hex of `fileinfo[0].library_id`. Empty string when the
   * primary entry's library is no longer registered — clients should
   * prefer the raw `fileinfo[]` for routing. */
  folder_id: string;
  filename: string;
  abs_path: string;
  /** Canonical location records — populated by discover / backup-ingest. */
  fileinfo?: FileInfo[];
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
  hidden?: boolean;
  hidden_reason?: 'manual' | 'nudity' | 'nudity-burst';
  hidden_ack?: boolean;
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
  /** Resolved hex of `fileinfo[0].library_id`. */
  folder_id: string;
  filename: string;
  abs_path: string;
  /** Canonical location records — populated by discover / backup-ingest. */
  fileinfo?: FileInfo[];
  /** Epoch seconds (NOT milliseconds — Swift's
   * `Date(timeIntervalSince1970:)` expects seconds). */
  mtime: number;
  rating: number;
  has_xmp: boolean;
  hidden?: boolean;
  hidden_reason?: 'manual' | 'nudity' | 'nudity-burst';
  hidden_ack?: boolean;
}

/** Minimal shape used by routes that need to drive FS / change-feed
 * side effects (xmp, trash, overrides) but don't ship the full DTO to
 * the client. Keeps callers from holding a raw Mongo document.
 *
 * `folder_id` / `filename` / `abs_path` are RESOLVED at transform time
 * from `fileinfo[0]` + the libraries map. They are `null` / `""` when
 * the primary entry's library is no longer registered; callers MUST
 * tolerate that (skip / 404 / log) — the underlying `fileinfo` array
 * is retained on this shape for any caller that needs to inspect the
 * raw locations. */
export interface AssetCoreInfo {
  id: ObjectId;
  /** Resolved library id (`fileinfo[0].library_id`). Null when the
   * asset has no live `fileinfo` entry. */
  folder_id: ObjectId | null;
  filename: string;
  abs_path: string;
  /** Canonical location records — populated by discover / backup-ingest. */
  fileinfo?: FileInfo[];
  size: number;
  mtime: number;
  /** Used by trash / Meilisearch tombstone paths. */
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

export function toDetailDto(
  doc: AssetWithId,
  libraries: ReadonlyMap<string, string>,
): AssetDetailDto {
  // `description_meta` is not typed on `AssetDoc` (the describe stage
  // added it after the schema froze). Read through `Record<string,
  // unknown>` so we don't drop the field on the wire — same pattern the
  // pre-refactor `routes/assets/metadata.ts` used inline.
  const rawDoc = doc as unknown as Record<string, unknown>;
  const resolved = resolvePrimary(doc.fileinfo, libraries);
  return {
    id: doc._id.toHexString(),
    folder_id: resolved.folder_id ? resolved.folder_id.toHexString() : '',
    filename: resolved.filename,
    abs_path: resolved.abs_path,
    fileinfo: resolved.fileinfo,
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
    hidden: doc.hidden,
    hidden_reason: doc.hidden_reason,
    hidden_ack: doc.hidden_ack,
    enrichment: normaliseEnrichment(doc.enrichment),
  };
}

export function toListItemDto(
  doc: AssetWithId,
  libraries: ReadonlyMap<string, string>,
): AssetListItemDto {
  const resolved = resolvePrimary(doc.fileinfo, libraries);
  return {
    id: doc._id.toHexString(),
    folder_id: resolved.folder_id ? resolved.folder_id.toHexString() : '',
    filename: resolved.filename,
    abs_path: resolved.abs_path,
    fileinfo: resolved.fileinfo,
    // `AssetDoc.mtime` is epoch ms (from `stat.mtimeMs`). The list
    // endpoint reports seconds so the Swift File Provider's
    // `Date(timeIntervalSince1970:)` round-trips into a sensible date.
    mtime: Math.floor(doc.mtime / 1000),
    rating: doc.rating,
    has_xmp: doc.has_xmp ?? false,
    hidden: doc.hidden,
    hidden_reason: doc.hidden_reason,
    hidden_ack: doc.hidden_ack,
  };
}

export function toCoreInfo(
  doc: AssetWithId,
  libraries: ReadonlyMap<string, string>,
): AssetCoreInfo {
  const rawDoc = doc as unknown as Record<string, unknown>;
  const mapleId = rawDoc.maple_id;
  const originalPath = rawDoc.original_path;
  const resolved = resolvePrimary(doc.fileinfo, libraries);
  return {
    id: doc._id,
    folder_id: resolved.folder_id,
    filename: resolved.filename,
    abs_path: resolved.abs_path,
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
