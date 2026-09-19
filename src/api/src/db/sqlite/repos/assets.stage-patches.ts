/**
 * What a pipeline stage's handler writes, as statements (#3787).
 *
 * On MongoDB a stage handler returned `{ patch }` as a map of document fields
 * and the runner folded it into its own `$set`, so one document write carried
 * both the handler's output and the runner's bookkeeping. The fields now live in
 * three tables — `assets` for the EXIF payload, `asset_detail` for the
 * transcript, `asset_search` for the synthesised blob — so the equivalent is a
 * short list of statements the runner commits in the same transaction as the
 * `stage_state` row (`./stage-writeback.ts`). The atomicity the `$set` gave is
 * preserved; what changes is that the handler has to name its table.
 *
 * They live here, beside the tables, rather than inline in each stage module,
 * for the rule the cutover exists to enforce: SQL belongs to a repository. A
 * stage file is filesystem and decode logic, and the moment one of them spells
 * an `UPDATE assets` inline the schema has two owners.
 *
 * Every statement here is deliberately *not* about `stage_state`. The runner
 * owns that row and writes it in the same transaction; `stageSuccessStatements`
 * rejects a handler that tries (`assertNoStageState`).
 */

import type { SqlStatement } from '../protocol.ts';
import type {
  AssetDoc,
  AssetExif,
  MetadataOverride,
  Place,
  TranscriptDoc,
  VideoDescriptionDoc,
  VideoDescriptionMeta,
  VisionDoc,
  VisionMeta,
} from '../../schema.ts';

/**
 * The EXIF stage's output: the parsed payload, the screenshot heuristic, and —
 * when a capture date let it derive the primary-form id — the upgraded
 * `maple_id`.
 *
 * `maple_id` is bound conditionally rather than written as NULL when absent,
 * because the fallback id already on the row is a real value the discover
 * watcher wrote; blanking it would lose the dedup key for every asset whose
 * EXIF carries no `DateTimeOriginal`.
 */
export function exifPatchStatements(
  assetId: string,
  patch: { exif: AssetExif | null; isScreenshot: boolean; mapleId?: string },
): SqlStatement[] {
  const columns = ['exif = ?', 'is_screenshot = ?'];
  const params: (string | number | null)[] = [
    patch.exif === null ? null : JSON.stringify(patch.exif),
    patch.isScreenshot ? 1 : 0,
  ];
  if (patch.mapleId !== undefined) {
    columns.push('maple_id = ?');
    params.push(patch.mapleId);
  }
  return [
    { sql: `UPDATE assets SET ${columns.join(', ')} WHERE id = ?`, params: [...params, assetId] },
  ];
}

const SEARCH_BLOB_UPSERT_SQL = `
  INSERT INTO asset_search (asset_id, search_blob) VALUES (?, ?)
  ON CONFLICT (asset_id) DO UPDATE SET search_blob = excluded.search_blob`;

const SEARCH_BLOB_DELETE_SQL = `DELETE FROM asset_search WHERE asset_id = ?`;

/**
 * The search stage's output: the recomposed blob, and the fingerprint recording
 * which embedder produced the vectors now in Meilisearch.
 *
 * An empty blob is a delete rather than an update to `''`. `asset_search` holds
 * a row only for an asset with something to match — the `CHECK (search_blob <>
 * '')` in the DDL is the partial filter the Mongo text index spelled out — and
 * the FTS5 index is external-content over this table, so a blank row would be a
 * posting list entry for nothing.
 */
export function searchBlobStatements(
  assetId: string,
  blob: string,
  semanticFingerprint: string | null,
): SqlStatement[] {
  const blobStatement: SqlStatement =
    blob === ''
      ? { sql: SEARCH_BLOB_DELETE_SQL, params: [assetId] }
      : { sql: SEARCH_BLOB_UPSERT_SQL, params: [assetId, blob] };
  if (semanticFingerprint === null) return [blobStatement];
  return [
    blobStatement,
    {
      sql: `UPDATE assets SET semantic_vector_fingerprint = ? WHERE id = ?`,
      params: [semanticFingerprint, assetId],
    },
  ];
}

/**
 * The `cf-thumb-sync` stage's output: the moment this asset's thumbnail was
 * last mirrored to the Cloudflare R2 edge cache.
 *
 * The column is also cleared from the other direction — `hidden-cleanup.ts`
 * nulls it when it takes an object back down — which is why the stamp is an
 * ordinary column write rather than something derived from the stage row.
 */
export function cfThumbSyncedStatements(assetId: string, at: Date = new Date()): SqlStatement[] {
  return [
    {
      sql: `UPDATE assets SET cf_thumb_synced_at = ? WHERE id = ?`,
      params: [at.toISOString(), assetId],
    },
  ];
}

/**
 * The transcribe stage's output.
 *
 * `SELECT … FROM assets WHERE id = ?` as the insert's source rather than a bare
 * `VALUES`: an asset deleted between the claim and the writeback would otherwise
 * fail the foreign key and roll back the runner's whole batch, where the Mongo
 * `updateOne` on a missing `_id` was a no-op. Every statement a handler hands
 * the runner has to degrade that way, because one asset's writeback must not
 * take the tick's other assets down with it.
 */
export function transcriptStatement(assetId: string, transcript: TranscriptDoc): SqlStatement {
  return {
    sql: `INSERT INTO asset_detail (asset_id, transcript)
          SELECT id, json(?) FROM assets WHERE id = ?
          ON CONFLICT (asset_id) DO UPDATE SET transcript = excluded.transcript`,
    params: [JSON.stringify(transcript), assetId],
  };
}

/**
 * What the `sidecar-metadata-index` stage reconciled out of an XMP sidecar: the
 * whole override document, plus the five grid columns it projects onto the
 * asset row.
 *
 * The projection is unconditional by design. The sidecar is the source of truth
 * for culling, so an absent attribute means the user cleared it and the stored
 * value has to go back to the insert default (rating 0, flag 0, empty label) —
 * writing only the fields the sidecar mentioned would leave a stale rating
 * showing in the grid forever. That is why every caller passes all five.
 */
export interface SidecarMetadataPatch {
  /** The rebuilt override document. Always a full replacement, never a merge. */
  metadataOverride: MetadataOverride;
  rating: number;
  flag: -1 | 0 | 1;
  colorLabel: string;
  /**
   * The effective verdict, already clamped for video by the handler.
   *
   * A boolean rather than the column's own three states: the stage always has
   * an answer, because it falls back to the filename heuristic when neither the
   * sidecar nor the describe stage has said anything. NULL on this column means
   * "never classified", and a row that reached this stage has been.
   */
  isScreenshot: boolean;
  hidden: boolean;
  /**
   * `'manual'` when the sidecar hid the asset, `null` when it un-hid it, and
   * **absent** when the sidecar said nothing either way.
   *
   * The third case is not the same as `null`: the effective hidden state then
   * comes from whatever was already stored, and blanking the reason would strip
   * the explanation off an asset the nudity classifier or a folder marker hid.
   */
  hiddenReason?: 'manual' | null;
}

const OVERRIDE_UPSERT_SQL = `
  INSERT INTO asset_detail (asset_id, metadata_override)
  SELECT id, json(?) FROM assets WHERE id = ?
  ON CONFLICT (asset_id) DO UPDATE SET metadata_override = excluded.metadata_override`;

/**
 * The stage's output as two statements: the grid columns on `assets`, and the
 * override document in `asset_detail`.
 *
 * On Mongo these were one `$set` and therefore atomic; here they are two
 * statements the runner commits in one transaction, which is the same
 * guarantee. Splitting them is forced by the schema — a sparse user-edit
 * overlay is detail data, and the columns the grid filters and sorts on are
 * not — and it is the reason the projection must not be issued from a stage
 * file as two separate writes.
 *
 * `hidden_reason` is appended to the column list only when the caller has an
 * opinion, so the "sidecar said nothing" case leaves the stored reason exactly
 * as it was rather than nulling it.
 */
export function sidecarMetadataStatements(
  assetId: string,
  patch: SidecarMetadataPatch,
): SqlStatement[] {
  const columns = ['rating = ?', 'flag = ?', 'color_label = ?', 'is_screenshot = ?', 'hidden = ?'];
  const params: (string | number | null)[] = [
    patch.rating,
    patch.flag,
    patch.colorLabel,
    patch.isScreenshot ? 1 : 0,
    patch.hidden ? 1 : 0,
  ];
  if (patch.hiddenReason !== undefined) {
    columns.push('hidden_reason = ?');
    params.push(patch.hiddenReason);
  }
  return [
    { sql: `UPDATE assets SET ${columns.join(', ')} WHERE id = ?`, params: [...params, assetId] },
    { sql: OVERRIDE_UPSERT_SQL, params: [JSON.stringify(patch.metadataOverride), assetId] },
  ];
}

/**
 * The geocode stage's output: the resolved place, and — when the place moves
 * the asset's canonical backup folder — the `backup_layout_version` reset that
 * puts it back into the refile-backups candidate set.
 *
 * Two statements on the same row rather than one, because the reset is
 * conditional and folding it into the place UPDATE would mean building the
 * column list by hand for a single optional column. They commit in the same
 * transaction, so "place resolved" and "needs re-filing" still land together.
 */
export function placeStatements(
  assetId: string,
  place: Place,
  refileNeeded: boolean,
): SqlStatement[] {
  const write: SqlStatement = {
    sql: `UPDATE assets SET place = json(?) WHERE id = ?`,
    params: [JSON.stringify(place), assetId],
  };
  if (!refileNeeded) return [write];
  return [
    write,
    {
      sql: `UPDATE assets SET backup_layout_version = ? WHERE id = ?`,
      params: [REFILE_RESET_VERSION, assetId],
    },
  ];
}

/**
 * Reset value for `backup_layout_version` that puts an asset back into the
 * refile-backups candidate set. Lives here rather than in the stage file
 * because it is a property of the column, not of the geocoder.
 */
const REFILE_RESET_VERSION = 0;

/**
 * The describe stage's output.
 *
 * `is_screenshot` is the one field of it that is not detail data: the grid
 * filters on it, so it is a column on `assets` and a separate statement. The
 * rest — caption, structured vision, OCR mirror, and the three provenance
 * blobs — are `asset_detail`'s, written as one upsert.
 */
export interface DescribePatch {
  /** Free-text caption mirror of `vision.caption`. */
  description: string;
  /** Provenance blob. Open-ended: providers append their own diagnostics. */
  descriptionMeta: Record<string, unknown>;
  vision: VisionDoc;
  visionMeta: VisionMeta;
  /** Mirrored from `vision.text_visible`; empty when the model saw no text. */
  ocrText: string;
  ocrMeta: NonNullable<AssetDoc['ocr_meta']>;
  /** The VLM's verdict, already clamped to `false` for video by the handler. */
  isScreenshot: boolean;
}

const DESCRIBE_UPSERT_SQL = `
  INSERT INTO asset_detail
    (asset_id, description, description_meta, ocr_text, ocr_meta, vision, vision_meta)
  SELECT id, ?, json(?), ?, json(?), json(?), json(?) FROM assets WHERE id = ?
  ON CONFLICT (asset_id) DO UPDATE SET
    description      = excluded.description,
    description_meta = excluded.description_meta,
    ocr_text         = excluded.ocr_text,
    ocr_meta         = excluded.ocr_meta,
    vision           = excluded.vision,
    vision_meta      = excluded.vision_meta`;

export function describeStatements(assetId: string, patch: DescribePatch): SqlStatement[] {
  return [
    {
      sql: DESCRIBE_UPSERT_SQL,
      params: [
        patch.description,
        JSON.stringify(patch.descriptionMeta),
        patch.ocrText,
        JSON.stringify(patch.ocrMeta),
        JSON.stringify(patch.vision),
        JSON.stringify(patch.visionMeta),
        assetId,
      ],
    },
    {
      sql: `UPDATE assets SET is_screenshot = ? WHERE id = ?`,
      params: [patch.isScreenshot ? 1 : 0, assetId],
    },
  ];
}

const VIDEO_DESCRIPTION_UPSERT_SQL = `
  INSERT INTO asset_detail (asset_id, video_description, video_description_meta)
  SELECT id, json(?), json(?) FROM assets WHERE id = ?
  ON CONFLICT (asset_id) DO UPDATE SET
    video_description      = excluded.video_description,
    video_description_meta = excluded.video_description_meta`;

/**
 * The video-describe stage's output: the whole multi-frame description and its
 * provenance. One upsert, because the two are meaningless apart — a summary
 * with no record of which model and how many frames produced it cannot be
 * triaged or invalidated.
 */
export function videoDescriptionStatements(
  assetId: string,
  description: VideoDescriptionDoc,
  meta: VideoDescriptionMeta,
): SqlStatement[] {
  return [
    {
      sql: VIDEO_DESCRIPTION_UPSERT_SQL,
      params: [JSON.stringify(description), JSON.stringify(meta), assetId],
    },
  ];
}
