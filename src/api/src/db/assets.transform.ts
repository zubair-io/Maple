/**
 * The shapes the HTTP API returns for an asset.
 *
 * Three DTOs and the small types they are built from, and nothing else: no
 * database access, no transform. They live in their own module so that the
 * repository which builds them (`db/repos/assets.dto.ts`) and the route
 * handlers which return them name the same declarations, and a field that
 * changes on one side stops compiling on the other instead of quietly
 * disagreeing.
 *
 * Wire conventions, all of them load-bearing for clients that exist today —
 * the Swift app and the Angular shell both read these keys:
 *   - `id` and `folder_id` are hex strings; `AssetCoreInfo` is the one
 *     internal shape that keeps them as `ObjectId`s, because its callers hand
 *     them straight back to another repository call.
 *   - Field names are snake_case throughout. Renaming to camelCase would be a
 *     breaking change for both clients and is deliberately not attempted here.
 *   - `AssetDetailDto.mtime` is epoch *milliseconds*; `AssetListItemDto.mtime`
 *     is epoch *seconds*, because the Swift File Provider decodes it through
 *     `Date(timeIntervalSince1970:)`. The two are genuinely different units on
 *     two endpoints — do not conflate them.
 */

import { type ObjectId } from './object-id.ts';
import {
  type AssetDoc,
  type AssetExif,
  type AssetFaceDoc,
  type Enrichment,
  type FileInfo,
  type Place,
  type VideoDescriptionDoc,
  type VideoDescriptionMeta,
  type VisionDoc,
  type VisionMeta,
} from './schema.ts';

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
  /** Epoch milliseconds (same unit the `assets` row stores). The list
   * endpoint at `/api/assets` returns seconds and uses its own DTO. */
  mtime: number;
  rating: number;
  /** Monotonic sidecar edit counter (`AssetDoc.sidecar_ver`), 0 when never
   * edited through the server. */
  sidecar_ver: number;
  /** Sidecar stat, attached by the metadata routes (#3563): epoch SECONDS
   * and bytes, `null` when no `.xmp` exists on disk. Absent from callers
   * that build the DTO without touching the filesystem. */
  xmp_mtime?: number | null;
  xmp_size?: number | null;
  flag: -1 | 0 | 1;
  color_label: string;
  indexed_at: string;
  place: Place | null;
  faces: DetailFaceDto[];
  description: string | null;
  description_meta: unknown;
  ocr_text: string | null;
  ocr_meta: AssetDoc['ocr_meta'] | null;
  vision: VisionDoc | null;
  vision_meta: VisionMeta | null;
  is_screenshot: boolean | null;
  /** Lean projection of the persisted `TranscriptDoc` for display. The
   * per-segment timing array is deliberately omitted — the info pane
   * renders `text` as a plain block; `null` until the transcribe stage
   * has run (or the asset carries no audio track). */
  transcript: TranscriptDto | null;
  /** Multi-frame visual description from the `video-describe` stage
   * (#2158). `null` until the stage has run, or for any non-video asset. */
  video_description: VideoDescriptionDoc | null;
  /** Provenance of `video_description`. */
  video_description_meta: VideoDescriptionMeta | null;
  hidden?: boolean;
  hidden_reason?: 'manual' | 'nudity' | 'nudity-burst' | 'folder' | null;
  hidden_ack?: boolean;
  enrichment: Enrichment;
}

/** A detected face plus its resolved person display name. `name` is the
 * `people` row's `name` for `person_id`, or `null` when the face is
 * unassigned or the person has no name / was not found. The web + Apple info
 * panes render `name` (falling back to `person_id`) instead of the raw id. */
export type DetailFaceDto = AssetFaceDoc & { name: string | null };

/** Display projection of `TranscriptDoc` (schema.ts). Drops `segments[]`
 * since the info pane shows the full `text` as one block. */
export interface TranscriptDto {
  text: string;
  language: string;
  model: string;
  duration_sec: number | null;
  generated_at: string;
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
  hidden_reason?: 'manual' | 'nudity' | 'nudity-burst' | 'folder' | null;
  hidden_ack?: boolean;
}

/** Minimal shape used by routes that need to drive FS / change-feed
 * side effects (xmp, trash, overrides) but don't ship the full DTO to
 * the client. Keeps callers from handling raw database rows.
 *
 * `folder_id` / `filename` / `abs_path` are RESOLVED when the DTO is built,
 * from the asset's locations + the libraries map. They are `null` / `""` when
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
  /** `'reaped'` when the missing-reaper soft-deleted the row (#2977) — no
   * trashed file copy exists, so restore/purge must not touch disk. */
  deleted_reason: 'reaped' | null;
  original_path: string | null;
  /** Carried for the trash route's Meilisearch re-index branch. */
  place: Place | null;
  description: string | null;
  ocr_text: string | null;
  exif: AssetExif | null;
}
