/**
 * The asset document a stage handler receives, rebuilt from its rows (#3787).
 *
 * ## Why the runner still hands handlers a document
 *
 * `StageConfig.handler` takes an `ImageDoc`, and fifteen stage handlers read
 * fields off it — `fileinfo`, `exif`, `vision`, `media_kind`, a sibling stage's
 * `last_error`. Replacing that with "a row and eight loaders" would rewrite
 * every handler for no behavioural gain, so the claim still resolves to a
 * document; what changed is that the document is assembled from six tables here
 * instead of being one BSON blob.
 *
 * ## Six statements, never one per asset
 *
 * A claim batch is 5× a stage's concurrency, so the loaders take the whole id
 * list and run together: the asset rows, then locations, faces, detail
 * payloads, enrichment state and the stage bookkeeping for exactly those ids.
 * The alternative — a document read per claimed asset — would put a round trip
 * per asset on the pool's readers at the front of every tick.
 *
 * ## What is deliberately absent from the result
 *
 * The migration-generation markers (`backup_layout_version` and friends) and
 * `search_blob` are columns of `assets` that no stage handler reads: the
 * migrations that own them query the table directly. They are left out rather
 * than carried, because every column named here is one the batch reads before
 * the first handler runs.
 */

import { ObjectId } from '../object-id.ts';
import type { AssetExif, Place, VisionDoc, VisionMeta } from '../schema.ts';
import type { ImageDoc, StageState } from '../../workers/stage-config.ts';
import { assetsDb, type SqliteDb } from './db-handle.ts';
import { toEnrichment } from './assets.dto.ts';
import {
  groupByAsset,
  json,
  toFace,
  toFileInfo,
  type EnrichmentRow,
  type FaceRow,
  type LocationRow,
} from './assets.rows.ts';
import {
  bucketedIds,
  detailByAssetIdsSql,
  enrichmentByAssetIdsSql,
  facesByAssetIdsSql,
  locationsByAssetIdsSql,
} from './assets.sql.ts';
import { placeholders } from './values.ts';

/** The `assets` columns a stage handler can read off its document. */
const STAGE_ASSET_COLUMNS = `
  id, size, mtime, indexed_at,
  rating, flag, color_label, has_xmp, sidecar_ver, media_kind,
  hidden, hidden_reason, hidden_ack, is_screenshot,
  deleted_at, maple_id, sha1_head,
  damaged_since, damaged_stage, damaged_reason,
  live_location_count, deleted_from_photos, apple_rendered_path,
  cf_thumb_synced_at, semantic_vector_fingerprint, geo_backfill_skipped,
  exif, place`;

interface StageAssetRow {
  id: string;
  size: number;
  mtime: number;
  indexed_at: string;
  rating: number;
  flag: number;
  color_label: string;
  has_xmp: number;
  sidecar_ver: number;
  media_kind: string;
  hidden: number;
  hidden_reason: string | null;
  hidden_ack: number;
  is_screenshot: number | null;
  deleted_at: string | null;
  maple_id: string | null;
  sha1_head: string | null;
  damaged_since: string | null;
  damaged_stage: string | null;
  damaged_reason: string | null;
  live_location_count: number;
  deleted_from_photos: number;
  apple_rendered_path: string | null;
  cf_thumb_synced_at: string | null;
  semantic_vector_fingerprint: string | null;
  geo_backfill_skipped: string | null;
  exif: string | null;
  place: string | null;
}

interface DetailRow {
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
  metadata_override: string | null;
}

interface StageStateRow {
  asset_id: string;
  stage: string;
  version: number;
  attempts: number;
  last_error: string | null;
  processed_at: string | null;
  dead: number;
  failed_at: string | null;
  next_attempt_at: string | null;
}

/**
 * The detail columns an asset with no `asset_detail` row reads as.
 *
 * An asset is given a detail row the first time something enriches it, so for
 * an unenriched one the join simply finds nothing. Collapsing that here rather
 * than at each of the ten fields below is what keeps the document assembly a
 * list of columns instead of ten repetitions of "and if there is no row".
 */
const NO_DETAIL: Omit<DetailRow, 'asset_id'> = {
  description: null,
  description_meta: null,
  ocr_text: null,
  ocr_meta: null,
  vision: null,
  vision_meta: null,
  transcript: null,
  video_description: null,
  video_description_meta: null,
  metadata_override: null,
};

/**
 * The documents for a claim batch, keyed by asset id.
 *
 * An id with no `assets` row is absent from the map rather than present with a
 * blank document. That is not defensive padding: an asset can be hard-deleted
 * between the claim and this load, and the runner skips what it cannot find so
 * the handler never sees a document whose `fileinfo` is empty for a reason it
 * has no way to distinguish from an unindexed file.
 */
export async function loadStageDocuments(
  ids: readonly string[],
  dbOverride?: SqliteDb,
): Promise<Map<string, ImageDoc>> {
  if (ids.length === 0) return new Map();
  const db = assetsDb(dbOverride);
  const bound = bucketedIds(ids);
  const [assets, locations, faces, details, enrichment, stages] = await Promise.all([
    db.read<StageAssetRow>(
      `SELECT ${STAGE_ASSET_COLUMNS} FROM assets WHERE id IN (${placeholders(bound.length)})`,
      bound,
    ),
    db.read<LocationRow>(locationsByAssetIdsSql(bound.length), bound),
    db.read<FaceRow>(facesByAssetIdsSql(bound.length), bound),
    db.read<DetailRow>(detailByAssetIdsSql(bound.length), bound),
    db.read<EnrichmentRow>(enrichmentByAssetIdsSql(bound.length), bound),
    db.read<StageStateRow>(
      `SELECT asset_id, stage, version, attempts, last_error, processed_at,
              dead, failed_at, next_attempt_at
         FROM stage_state WHERE asset_id IN (${placeholders(bound.length)})`,
      bound,
    ),
  ]);

  const locationsByAsset = groupByAsset(locations);
  const facesByAsset = groupByAsset(faces);
  const enrichmentByAsset = groupByAsset(enrichment);
  const stagesByAsset = groupByAsset(stages);
  const detailByAsset = new Map(details.map((row) => [row.asset_id, row] as const));

  return new Map(
    assets.map((row) => [
      row.id,
      toImageDoc(
        row,
        locationsByAsset.get(row.id) ?? [],
        facesByAsset.get(row.id) ?? [],
        detailByAsset.get(row.id),
        enrichmentByAsset.get(row.id) ?? [],
        stagesByAsset.get(row.id) ?? [],
      ),
    ]),
  );
}

/**
 * One row and its side tables as the document the Mongo collection held.
 *
 * Optional fields are omitted rather than nulled wherever the document omitted
 * them, because handlers test several of them for presence — `maple_id`,
 * `apple_rendered_path` and `cf_thumb_synced_at` all gate a branch somewhere in
 * `stages/`. The `NOT NULL` boolean columns are always emitted, which is the
 * same accommodation `assets.rows.ts` documents for the DTO path: absent and
 * `false` were interchangeable for every reader.
 *
 * Every part of the document that carries a decision of its own is a named
 * helper below — the side table's payloads, the keys that stay absent, the
 * damage record — so this function is the list of parts rather than the list of
 * rules. That is deliberate: a document assembled column by column grows one
 * more branch every time the table does, and this one reached thirty of them
 * before it was split (#3789).
 */
function toImageDoc(
  row: StageAssetRow,
  locations: readonly LocationRow[],
  faces: readonly FaceRow[],
  detail: DetailRow | undefined,
  enrichment: readonly EnrichmentRow[],
  stages: readonly StageStateRow[],
): ImageDoc {
  return {
    _id: new ObjectId(row.id),
    fileinfo: toFileInfo(locations),
    size: row.size,
    mtime: row.mtime,
    indexed_at: row.indexed_at,
    rating: row.rating,
    flag: row.flag as -1 | 0 | 1,
    color_label: row.color_label,
    has_xmp: row.has_xmp === 1,
    sidecar_ver: row.sidecar_ver,
    media_kind: row.media_kind,
    hidden: row.hidden === 1,
    hidden_reason: row.hidden_reason as ImageDoc['hidden_reason'],
    hidden_ack: row.hidden_ack === 1,
    // Tri-state, and the third state has to survive: NULL means the classifier
    // has not looked at this asset, which is a different claim from "not a
    // screenshot" and the one `false` would erase.
    is_screenshot: row.is_screenshot === null ? undefined : row.is_screenshot === 1,
    deleted_at: row.deleted_at,
    live_location_count: row.live_location_count,
    deleted_from_photos: row.deleted_from_photos === 1,
    exif: json<AssetExif>(row.exif),
    place: json<Place>(row.place),
    faces: faces.map((face) => toFace(face)),
    ...detailFields(detail),
    enrichment: toEnrichment(enrichment),
    stages: toStageStates(stages),
    ...sparseFields(row),
  } as ImageDoc;
}

/**
 * The fields that come from the `asset_detail` side table.
 *
 * Each payload is stored as JSON text and handed back as the object the
 * document carried, so a handler that reads `vision.tags` reads it the way it
 * did on Mongo. `transcript` is the one field that is omitted rather than
 * nulled: it is declared optional on the document instead of nullable, so an
 * asset with no transcript carries no key at all, which is the shape the
 * collection held and the shape `meili` reads through `image.transcript?.text`.
 */
function detailFields(detail: DetailRow | undefined) {
  const columns = detail ?? NO_DETAIL;
  return {
    description: columns.description,
    ocr_text: columns.ocr_text,
    ocr_meta: json<NonNullable<ImageDoc['ocr_meta']>>(columns.ocr_meta),
    vision: json<VisionDoc>(columns.vision),
    vision_meta: json<VisionMeta>(columns.vision_meta),
    transcript: json<NonNullable<ImageDoc['transcript']>>(columns.transcript) ?? undefined,
    video_description: json<NonNullable<ImageDoc['video_description']>>(columns.video_description),
    video_description_meta: json<NonNullable<ImageDoc['video_description_meta']>>(
      columns.video_description_meta,
    ),
    // Read by `sidecar-metadata-index`, which re-arms `geocode` only when the
    // sidecar's coordinates differ from the ones already stored here.
    metadata_override: json<NonNullable<ImageDoc['metadata_override']>>(columns.metadata_override),
  };
}

/**
 * The columns whose key the document left out entirely when they were unset.
 *
 * A nullable column and an absent key are the same state here, and which of the
 * two a handler sees matters: `maple_id`, `apple_rendered_path` and
 * `cf_thumb_synced_at` each gate a branch somewhere under `stages/` by testing
 * the key, so emitting an explicit `null` would send those branches down the
 * "yes, there is one" path with nothing in it.
 */
function sparseFields(row: StageAssetRow) {
  return {
    ...(row.maple_id === null ? {} : { maple_id: row.maple_id }),
    ...(row.sha1_head === null ? {} : { sha1_head: row.sha1_head }),
    ...(row.apple_rendered_path === null ? {} : { apple_rendered_path: row.apple_rendered_path }),
    ...(row.cf_thumb_synced_at === null ? {} : { cf_thumb_synced_at: row.cf_thumb_synced_at }),
    ...(row.semantic_vector_fingerprint === null
      ? {}
      : { semantic_vector_fingerprint: row.semantic_vector_fingerprint }),
    ...(row.geo_backfill_skipped === null
      ? {}
      : { geo_backfill_skipped: row.geo_backfill_skipped as 'no-donor' | 'skip' }),
    ...damageRecord(row),
  };
}

/**
 * The `damaged` subdocument, present only for an asset a stage gave up on.
 *
 * `damaged_since` alone decides whether the record exists, because the three
 * columns are set by one statement and cleared by another — there is no write
 * that leaves a stage or a reason behind without a timestamp. A row carrying a
 * timestamp and nothing else predates those columns, and the empty strings keep
 * the subdocument's declared shape rather than making each reader test three
 * fields instead of one.
 */
function damageRecord(row: StageAssetRow) {
  if (row.damaged_since === null) return {};
  return {
    damaged: {
      since: row.damaged_since,
      stage: row.damaged_stage ?? '',
      reason: row.damaged_reason ?? '',
    },
  };
}

/**
 * The `stages` subdocument, rebuilt from its rows.
 *
 * `processed_at` and `failed_at` become `Date`s because that is what the
 * document declared and what `describe` compares against. The claim's own
 * bookkeeping is in here too, which costs nothing — the rows were read for the
 * fields the handlers use, and omitting the rest would mean deciding per stage
 * which of a row's eight columns are interesting.
 */
function toStageStates(rows: readonly StageStateRow[]): Record<string, StageState> {
  return Object.fromEntries(
    rows.map((row) => [
      row.stage,
      {
        version: row.version,
        attempts: row.attempts,
        last_error: row.last_error,
        processed_at: row.processed_at === null ? null : new Date(row.processed_at),
        dead: row.dead === 1,
        failed_at: row.failed_at === null ? null : new Date(row.failed_at),
        next_attempt_at: row.next_attempt_at === null ? null : new Date(row.next_attempt_at),
      } satisfies StageState,
    ]),
  );
}
