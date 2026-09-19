// The blocks this shares with `db/assets.transform.ts` are the ones that do not
// touch a database at all — the same DTO assembled from rows instead of from a
// document. Factoring them into a shared helper would couple the two
// implementations together shortly before one of them is deleted, which is the
// opposite of what this migration's beside-then-switch shape is for. The
// duplication ends when the Mongo module goes (#3785).
// fallow-ignore-file code-duplication

/**
 * The rows the assets queries return, and the small conversions between a
 * SQLite column and the value a DTO carries.
 *
 * SQLite hands back three things the DTOs do not use directly. Booleans are
 * integers, because SQLite has no boolean type. Structured payloads are TEXT
 * holding JSON. And a location is a row rather than an array element, so the
 * `fileinfo[]` array a client expects has to be rebuilt from an ordered set of
 * them.
 *
 * ## Where a `null` becomes an absent key
 *
 * The Mongo documents are sparse: a field that was never written is missing,
 * and `JSON.stringify` drops it from the response. Several of the columns here
 * are `NOT NULL DEFAULT 0` instead, so the information "never written" is gone
 * by the time a row is read. Two rules keep the wire output as close as the
 * schema allows:
 *
 *  - A nullable column maps `NULL` to an absent key wherever the Mongo field
 *    was optional (`missing_since`, `landmarks`, `embedding`), and to `null`
 *    wherever the DTO declares `T | null`.
 *  - A `NOT NULL` boolean column is always emitted. `hidden`, `hidden_ack` and
 *    `keep` are declared optional on the DTOs and were absent on rows that
 *    never set them; they now read as `false`. Every consumer treats absent
 *    and `false` alike, and the alternative — inventing an "unset" state the
 *    column cannot store — would be worse.
 */

import { ObjectId } from 'mongodb';
import * as path from 'node:path';
import type { AssetFaceDoc, EnrichmentStageState, FileInfo } from '../../schema.ts';
// Type-only, so the `bool`/`json` import in the other direction stays the only
// runtime edge between these two modules.
import type { PersonFaceRow } from './people.rows.ts';

/** The `assets` columns behind the detail and core-info DTOs. */
export interface AssetCoreRow {
  id: string;
  size: number;
  mtime: number;
  indexed_at: string;
  rating: number;
  flag: number;
  color_label: string;
  has_xmp: number;
  sidecar_ver: number;
  hidden: number;
  hidden_reason: string | null;
  hidden_ack: number;
  is_screenshot: number;
  deleted_at: string | null;
  deleted_reason: string | null;
  original_path: string | null;
  maple_id: string | null;
  exif: string | null;
  place: string | null;
}

/** The narrow `assets` projection behind the working-set list DTO. */
export interface ListItemRow {
  id: string;
  mtime: number;
  rating: number;
  has_xmp: number;
  hidden: number;
  hidden_reason: string | null;
  hidden_ack: number;
}

/** One `asset_locations` row — one entry of the former `fileinfo[]`. */
export interface LocationRow {
  asset_id: string;
  ordinal: number;
  library_id: string;
  path: string;
  filename: string;
  deleted_at: string | null;
  missing_since: string | null;
  missing_reason: string | null;
  keep: number;
}

/**
 * One `faces` row with its person's display name already joined in.
 *
 * The columns themselves are `PersonFaceRow`'s — `people.rows.ts` owns the
 * faces table's shape, because that is where the people surfaces read it — and
 * this adds the one column the asset detail's join brings with it.
 */
export interface FaceRow extends PersonFaceRow {
  person_name: string | null;
}

/** The `asset_detail` side-table row. Absent entirely for an unenriched asset. */
export interface DetailRow {
  asset_id: string;
  description: string | null;
  description_meta: string | null;
  ocr_text: string | null;
  ocr_meta: string | null;
  vision: string | null;
  vision_meta: string | null;
  transcript: string | null;
  video_description: string | null;
  video_description_meta: string | null;
}

/** One `enrichment_state` row: one asset's state for one of three stages. */
export interface EnrichmentRow {
  asset_id: string;
  stage: string;
  done_at: string | null;
  locked_by: string | null;
  lease_expires_at: string | null;
  attempts: number;
  last_error: string | null;
  version: number | null;
  dead_letter_at: string | null;
}

/** SQLite's 0/1 as a boolean, for a `NOT NULL` column. */
export function bool(value: number | null | undefined): boolean {
  return value === 1;
}

/**
 * SQLite's 0/1/NULL as `boolean | null`, for a column that is genuinely
 * three-valued.
 *
 * Separate from {@link bool} rather than a widening of it, because the two
 * answer different questions and only one column asks the second one.
 * `is_screenshot` is `CHECK (is_screenshot IS NULL OR is_screenshot IN (0, 1))`
 * where NULL means the classifier has not looked at this asset yet, which is
 * not the same claim as "it is not a screenshot". Every other flag here is
 * `NOT NULL DEFAULT 0` and collapsing its absent case to `false` is correct.
 *
 * Passing a tri-state column through `bool` is how the distinction was lost
 * once already: it silently reported `false` for unclassified assets, and the
 * matching bug on the query side made `isScreenshot=false` match almost nothing
 * (#3761).
 */
export function nullableBool(value: number | null | undefined): boolean | null {
  return value === null || value === undefined ? null : value === 1;
}

/**
 * A JSON column as the value it encodes, or `null`.
 *
 * Every JSON column in this schema carries a `json_valid` CHECK, so malformed
 * text cannot be stored — but a column can still be read from a database an
 * operator has edited by hand, and a detail view returning `null` for one
 * field beats a 500 for the whole asset.
 */
export function json<T>(text: string | null | undefined): T | null {
  if (text == null) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/** Groups rows by the asset they belong to, preserving each query's order. */
export function groupByAsset<T extends { asset_id: string }>(rows: T[]): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const existing = grouped.get(row.asset_id);
    if (existing) existing.push(row);
    else grouped.set(row.asset_id, [row]);
  }
  return grouped;
}

/**
 * Rebuilds one asset's `fileinfo[]` from its location rows.
 *
 * The rows arrive ordered by `ordinal`, which is the array position the
 * entries had. Optional fields are omitted rather than nulled where the Mongo
 * documents omitted them, so the JSON a client receives is unchanged.
 *
 * Two of those fields are asymmetric, and deliberately so. `deleted_at` is
 * emitted unconditionally because every writer that creates an entry writes it
 * explicitly as `null` — `indexer/images.repo.ts`, the discover handlers and
 * `discover/folder-hidden.ts` all do — so a live entry on Mongo carries the
 * key today and dropping it here is what would be the change. `keep` is
 * emitted only when true because no writer in the codebase ever stores
 * `false`, and `FileInfo.keep`'s own contract is that absent and false mean
 * the same thing ("ordinary keeper ranking applies").
 */
export function toFileInfo(rows: readonly LocationRow[]): FileInfo[] {
  return rows.map((row) => {
    const entry: FileInfo = {
      path: row.path,
      filename: row.filename,
      library_id: new ObjectId(row.library_id),
      deleted_at: row.deleted_at,
    };
    if (row.missing_since !== null) entry.missing_since = row.missing_since;
    if (row.missing_reason !== null) entry.missing_reason = row.missing_reason;
    if (row.keep === 1) entry.keep = true;
    return entry;
  });
}

/** One face row as the detail DTO's face, name resolved. */
export function toFace(row: FaceRow): AssetFaceDoc & { name: string | null } {
  const face: AssetFaceDoc & { name: string | null } = {
    bbox: { x: row.bbox_x, y: row.bbox_y, w: row.bbox_w, h: row.bbox_h },
    person_id: row.person_id,
    confidence: row.confidence,
    name: row.person_name,
  };
  const landmarks = json<Array<{ x: number; y: number }>>(row.landmarks);
  if (landmarks !== null) face.landmarks = landmarks;
  const embedding = json<number[]>(row.embedding);
  if (embedding !== null) face.embedding = embedding;
  if (row.embedding_version !== null) face.embedding_version = row.embedding_version;
  if (row.hidden === 1) face.hidden = true;
  return face;
}

/** One `enrichment_state` row as the wire's per-stage state. */
export function toEnrichmentStage(row: EnrichmentRow): EnrichmentStageState {
  return {
    done_at: row.done_at,
    locked_by: row.locked_by,
    lease_expires_at: row.lease_expires_at,
    attempts: row.attempts,
    last_error: row.last_error,
    version: row.version,
    dead_letter_at: row.dead_letter_at,
  };
}

/**
 * The canonical wire fields for an asset's primary location.
 *
 * Primary is the first entry that is still live — neither replaced in place
 * (`deleted_at`) nor gone from disk (`missing_since`) — so the DTO's path
 * points at a file that exists. A fully non-live asset falls back to entry
 * zero, which still resolves a `folder_id`; only `abs_path` goes empty, and
 * then only when the library root is no longer registered. Callers tolerate
 * the empty string, which is the existing contract.
 */
export function resolvePrimary(
  fileinfo: FileInfo[] | undefined,
  libraries: ReadonlyMap<string, string>,
): { folder_id: ObjectId | null; filename: string; abs_path: string } {
  if (!fileinfo || fileinfo.length === 0) {
    return { folder_id: null, filename: '', abs_path: '' };
  }
  const primary = fileinfo.find((e) => !e.deleted_at && !e.missing_since) ?? fileinfo[0]!;
  const root = libraries.get(primary.library_id.toHexString()) ?? '';
  const segments = primary.path === '' ? [] : primary.path.split('/');
  const abs_path = root ? path.join(root, ...segments, primary.filename) : '';
  return { folder_id: primary.library_id, filename: primary.filename, abs_path };
}
