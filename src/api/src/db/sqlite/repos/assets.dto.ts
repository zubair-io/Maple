/**
 * Rows in, wire DTOs out — the single boundary between SQLite and the JSON the
 * API ships.
 *
 * The three DTO shapes are imported from `db/assets.transform.ts` rather than
 * redeclared, so "the ported repo returns the same DTO" is checked by the type
 * system on every build instead of by inspection. What changes is only where
 * each field comes from: a column, a JSON payload on the asset row, the
 * `asset_detail` side table, or a set of rows that used to be an array.
 *
 * ## Two differences a reviewer should know about rather than discover
 *
 * **`is_screenshot` is tri-state, and stays that way through this boundary.**
 * The column is `CHECK (is_screenshot IS NULL OR is_screenshot IN (0, 1))` and
 * the DTO reports `boolean | null`, where `null` means the classifier has not
 * looked at this asset yet — which is a different claim from "it is not a
 * screenshot". It goes through `nullableBool`, not `bool`.
 *
 * An earlier draft of this comment asserted the column was `NOT NULL DEFAULT 0`
 * and that a tri-state would have to be reintroduced by the facets slice. Both
 * halves were wrong, and the same mistake was live on the query side, where
 * `isScreenshot=false` tested equality against zero and so matched only assets
 * already classified — almost nothing on a library mid-enrichment (#3761). A
 * test now asserts all three states round-trip, because nothing failed when
 * this collapsed the first time.
 *
 * **`hidden` and `hidden_ack` are always present.** Both are `NOT NULL` 0/1
 * columns, so an asset that never set them reports `false` where Mongo omitted
 * the key. Absent and `false` are interchangeable for every client that reads
 * them.
 */

import { ObjectId } from 'mongodb';
import {
  normaliseEnrichment,
  type AssetDoc,
  type AssetExif,
  type Enrichment,
  type Place,
  type TranscriptDoc,
  type VideoDescriptionDoc,
  type VideoDescriptionMeta,
  type VisionDoc,
  type FileInfo,
  type VisionMeta,
} from '../../schema.ts';
import type {
  AssetCoreInfo,
  AssetDetailDto,
  AssetListItemDto,
  DetailFaceDto,
  TranscriptDto,
} from '../../assets.transform.ts';
import {
  bool,
  json,
  resolvePrimary,
  nullableBool,
  toEnrichmentStage,
  toFace,
  toFileInfo,
  type AssetCoreRow,
  type DetailRow,
  type EnrichmentRow,
  type FaceRow,
  type ListItemRow,
  type LocationRow,
} from './assets.rows.ts';

/** Everything one asset's DTOs are built from, already grouped by asset. */
export interface AssetBundle {
  locations: readonly LocationRow[];
  faces: readonly FaceRow[];
  detail: DetailRow | undefined;
  enrichment: readonly EnrichmentRow[];
}

/** An empty bundle — an asset with no locations, faces, detail or enrichment. */
export const EMPTY_BUNDLE: AssetBundle = {
  locations: [],
  faces: [],
  detail: undefined,
  enrichment: [],
};

/**
 * An asset's locations as its `fileinfo[]`, or `undefined` when it has none.
 *
 * `undefined` rather than `[]` because the Mongo field is optional and
 * `JSON.stringify` drops an absent key: an asset with no locations answered
 * without a `fileinfo` field, and a client that tests for the key rather than
 * its length would see a behaviour change from an empty array.
 */
function toFileInfoOrAbsent(rows: readonly LocationRow[]): FileInfo[] | undefined {
  return rows.length > 0 ? toFileInfo(rows) : undefined;
}

/** The stage names the `enrichment` subdocument carries, in wire order. */
const ENRICHMENT_STAGES = ['geocode', 'face', 'describe'] as const;

/**
 * The `enrichment` object, rebuilt from its rows.
 *
 * Funnelled through the shared `normaliseEnrichment` so a stage with no row
 * defaults to the same pending shape a freshly-skeletoned Mongo document had.
 * The one-table-per-state design means a missing row and a never-written
 * subdocument are the same thing, which is what makes that reuse exact.
 */
function toEnrichment(rows: readonly EnrichmentRow[]): Enrichment {
  const partial: Partial<Enrichment> = {};
  for (const row of rows) {
    const stage = ENRICHMENT_STAGES.find((name) => name === row.stage);
    if (stage) partial[stage] = toEnrichmentStage(row);
  }
  return normaliseEnrichment(partial);
}

/**
 * The stored transcript projected for display: the info pane renders `text` as
 * one block, so the per-segment timing array is dropped exactly as the Mongo
 * transform drops it.
 */
function toTranscriptDto(text: string | null): TranscriptDto | null {
  const stored = json<TranscriptDoc>(text);
  if (!stored) return null;
  return {
    text: stored.text,
    language: stored.language,
    model: stored.model,
    duration_sec: stored.duration_sec,
    generated_at: stored.generated_at,
  };
}

/** Full single-asset DTO, as `GET /api/assets/:id` returns it. */
export function toDetailDto(
  row: AssetCoreRow,
  bundle: AssetBundle,
  libraries: ReadonlyMap<string, string>,
): AssetDetailDto {
  const fileinfo = toFileInfoOrAbsent(bundle.locations);
  const primary = resolvePrimary(fileinfo, libraries);
  const detail = bundle.detail;
  const faces: DetailFaceDto[] = bundle.faces.map((face) => toFace(face));
  return {
    id: row.id,
    folder_id: primary.folder_id ? primary.folder_id.toHexString() : '',
    filename: primary.filename,
    abs_path: primary.abs_path,
    fileinfo,
    size: row.size,
    mtime: row.mtime,
    rating: row.rating,
    sidecar_ver: row.sidecar_ver,
    flag: row.flag as AssetDetailDto['flag'],
    color_label: row.color_label,
    indexed_at: row.indexed_at,
    place: json<Place>(row.place),
    faces,
    description: detail?.description ?? null,
    description_meta: json<unknown>(detail?.description_meta ?? null),
    ocr_text: detail?.ocr_text ?? null,
    ocr_meta: json<NonNullable<AssetDoc['ocr_meta']>>(detail?.ocr_meta ?? null),
    vision: json<VisionDoc>(detail?.vision ?? null),
    vision_meta: json<VisionMeta>(detail?.vision_meta ?? null),
    is_screenshot: nullableBool(row.is_screenshot),
    transcript: toTranscriptDto(detail?.transcript ?? null),
    video_description: json<VideoDescriptionDoc>(detail?.video_description ?? null),
    video_description_meta: json<VideoDescriptionMeta>(detail?.video_description_meta ?? null),
    hidden: bool(row.hidden),
    hidden_reason: row.hidden_reason as AssetDetailDto['hidden_reason'],
    hidden_ack: bool(row.hidden_ack),
    enrichment: toEnrichment(bundle.enrichment),
  };
}

/**
 * Working-set list DTO, as `GET /api/assets` returns it.
 *
 * `mtime` is divided by 1000 because this endpoint reports epoch *seconds* —
 * the Swift File Provider decodes it through `Date(timeIntervalSince1970:)`.
 * The detail DTO above reports milliseconds. Conflating the two is the bug the
 * Mongo transform's comment warns about, and it is preserved here for the same
 * reason.
 */
export function toListItemDto(
  row: ListItemRow,
  locations: readonly LocationRow[],
  libraries: ReadonlyMap<string, string>,
): AssetListItemDto {
  const fileinfo = toFileInfoOrAbsent(locations);
  const primary = resolvePrimary(fileinfo, libraries);
  return {
    id: row.id,
    folder_id: primary.folder_id ? primary.folder_id.toHexString() : '',
    filename: primary.filename,
    abs_path: primary.abs_path,
    fileinfo,
    mtime: Math.floor(row.mtime / 1000),
    rating: row.rating,
    has_xmp: bool(row.has_xmp),
    hidden: bool(row.hidden),
    hidden_reason: row.hidden_reason as AssetListItemDto['hidden_reason'],
    hidden_ack: bool(row.hidden_ack),
  };
}

/**
 * Minimal shape for routes that drive filesystem or change-feed side effects
 * without shipping the full DTO — `id` stays an ObjectId here, as it is today.
 */
export function toCoreInfo(
  row: AssetCoreRow,
  bundle: AssetBundle,
  libraries: ReadonlyMap<string, string>,
): AssetCoreInfo {
  const fileinfo = toFileInfoOrAbsent(bundle.locations);
  const primary = resolvePrimary(fileinfo, libraries);
  const mapleId = row.maple_id;
  const originalPath = row.original_path;
  return {
    id: new ObjectId(row.id),
    folder_id: primary.folder_id,
    filename: primary.filename,
    abs_path: primary.abs_path,
    fileinfo,
    size: row.size,
    mtime: row.mtime,
    maple_id: mapleId !== null && mapleId.length > 0 ? mapleId : null,
    deleted_at: row.deleted_at,
    deleted_reason: row.deleted_reason === 'reaped' ? 'reaped' : null,
    original_path: originalPath !== null && originalPath.length > 0 ? originalPath : null,
    place: json<Place>(row.place),
    description: bundle.detail?.description ?? null,
    ocr_text: bundle.detail?.ocr_text ?? null,
    exif: json<AssetExif>(row.exif),
  };
}
