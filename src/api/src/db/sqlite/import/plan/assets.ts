/**
 * The asset document, fanned out across the eight tables it became.
 *
 * One Mongo asset produces:
 *
 *  - one `assets` row — the narrow grid-and-filter row, plus the two JSON
 *    payloads (`exif`, `place`) the generated columns read;
 *  - one `asset_locations` row per `fileinfo[]` entry, keeping the array
 *    position as `ordinal`;
 *  - one `faces` row per `faces[]` entry, keeping the array position as
 *    `face_index` because clients address a face by it;
 *  - one `asset_phasset_links` row per `phasset_links[]` entry;
 *  - at most one `asset_detail` row, written only when the asset carries at
 *    least one of the describe-stage payloads — 335,000 rows of nulls would
 *    cost pages for nothing;
 *  - at most one `asset_search` row, written only when `search_blob` is
 *    non-empty, which is exactly the partial filter the Mongo text index had;
 *  - one `stage_state` row per canonical stage name, ALWAYS, plus one for every
 *    non-canonical stage the document happens to carry;
 *  - one `enrichment_state` row per present `enrichment.<stage>` subdocument.
 *
 * Two of those deserve their reason stated rather than discovered.
 *
 * **Stage rows are seeded densely.** On Mongo a missing `stages.<name>`
 * subdocument is claimable, because BSON orders a missing field below any
 * number. The SQL equivalent would be an anti-join against `assets`, which
 * cannot use an index, so the schema seeds every asset with a row per stage at
 * `version = 0` and the claim becomes an index range scan. An asset that has
 * never been through a stage therefore still gets that stage's row here.
 *
 * **Non-canonical stage names are carried, not dropped.** Production documents
 * carry `stages.hash` and `stages.face` from stages that were retired or split.
 * The `stage` column is free-form and no claim query asks for those names, so
 * the rows are inert; importing them costs a little space and loses nothing,
 * where dropping them would quietly discard the only record that the work was
 * ever done. The run reports which non-canonical names it saw.
 */

import type { Db, Document, Filter } from 'mongodb';
import type { CollectionPlan, MapContext, Row, TableRows } from '../types.ts';
import {
  asArray,
  asRecord,
  clampInt,
  enumOr,
  intOr,
  numberOr,
  toBit,
  toEnum,
  toIso,
  toJsonText,
  toNumber,
  toText,
} from '../values.ts';
import { DETAIL_SOURCE_FIELDS, ENRICHMENT_STAGES } from './asset-fields.ts';
import { assetExpectedCounts } from './assets-counts.ts';
import { docId } from './shared.ts';

const HIDDEN_REASONS = ['manual', 'nudity', 'nudity-burst', 'folder'] as const;
const MEDIA_KINDS = ['image', 'video', 'audio'] as const;
const GEO_SKIPS = ['no-donor', 'skip'] as const;

const ASSETS_COLUMNS = [
  'id',
  'size',
  'mtime',
  'indexed_at',
  'rating',
  'flag',
  'color_label',
  'has_xmp',
  'sidecar_ver',
  'media_kind',
  'hidden',
  'hidden_reason',
  'hidden_ack',
  'is_screenshot',
  'deleted_at',
  'deleted_reason',
  'original_path',
  'damaged_since',
  'damaged_stage',
  'damaged_reason',
  'maple_id',
  'sha1_head',
  'deleted_from_photos',
  'apple_rendered_path',
  'cf_thumb_synced_at',
  'semantic_vector_fingerprint',
  'backup_layout_version',
  'legacy_daydir_version',
  'video_meta_version',
  'video_poster_rearm_version',
  'video_screenshot_clear_version',
  'preview_missing_redrive_version',
  'geo_backfill_skipped',
  'exif',
  'place',
] as const;

const LOCATION_COLUMNS = [
  'asset_id',
  'ordinal',
  'library_id',
  'path',
  'filename',
  'deleted_at',
  'missing_since',
  'missing_reason',
  'keep',
] as const;

const DETAIL_COLUMNS = [
  'asset_id',
  'description',
  'description_meta',
  'ocr_text',
  'ocr_meta',
  'vision',
  'vision_meta',
  'transcript',
  'video_description',
  'video_description_meta',
  'metadata_override',
  'derivative_audit',
  'geo_inferred',
] as const;

const PHASSET_COLUMNS = [
  'asset_id',
  'device_id',
  'phasset_local_id',
  'phasset_cloud_id',
  'first_seen',
] as const;

const FACE_COLUMNS = [
  'asset_id',
  'face_index',
  'person_id',
  'confidence',
  'bbox_x',
  'bbox_y',
  'bbox_w',
  'bbox_h',
  'hidden',
  'landmarks',
  'embedding',
  'embedding_version',
] as const;

const SEARCH_COLUMNS = ['asset_id', 'search_blob'] as const;

const STAGE_COLUMNS = [
  'asset_id',
  'stage',
  'version',
  'attempts',
  'last_error',
  'processed_at',
  'dead',
  'failed_at',
  'next_attempt_at',
] as const;

const ENRICHMENT_COLUMNS = [
  'asset_id',
  'stage',
  'done_at',
  'locked_by',
  'lease_expires_at',
  'attempts',
  'last_error',
  'version',
  'dead_letter_at',
] as const;

/**
 * `indexed_at` is NOT NULL, and a handful of the oldest production rows predate
 * the field. The ObjectId's own timestamp is the closest true answer available
 * — it IS when the row was created — so it stands in rather than a sentinel.
 */
function indexedAt(doc: Record<string, unknown>, id: string, ctx: MapContext): string {
  const stored = toIso(doc.indexed_at);
  if (stored !== null) return stored;
  ctx.note('assets.indexed_at derived from the ObjectId timestamp');
  return new Date(Number.parseInt(id.slice(0, 8), 16) * 1000).toISOString();
}

function assetRow(doc: Record<string, unknown>, id: string, ctx: MapContext): Row {
  const damaged = asRecord(doc.damaged);
  const rating = clampInt(doc.rating, 0, 5, 0);
  if (toNumber(doc.rating) !== null && rating !== doc.rating) ctx.note('assets.rating clamped');
  const flag = [-1, 0, 1].includes(doc.flag as number) ? (doc.flag as number) : 0;
  return [
    id,
    intOr(doc.size, 0),
    intOr(doc.mtime, 0),
    indexedAt(doc, id, ctx),
    rating,
    flag,
    typeof doc.color_label === 'string' ? doc.color_label : '',
    toBit(doc.has_xmp),
    intOr(doc.sidecar_ver, 0),
    enumOr(doc.media_kind, MEDIA_KINDS, 'image'),
    toBit(doc.hidden),
    toEnum(doc.hidden_reason, HIDDEN_REASONS),
    toBit(doc.hidden_ack),
    toBit(doc.is_screenshot),
    toIso(doc.deleted_at),
    doc.deleted_reason === 'reaped' ? 'reaped' : null,
    toText(doc.original_path),
    toIso(damaged.since),
    toText(damaged.stage),
    toText(damaged.reason),
    toText(doc.maple_id),
    toText(doc.sha1_head),
    toBit(doc.deleted_from_photos),
    toText(doc.apple_rendered_path),
    toIso(doc.cf_thumb_synced_at),
    toText(doc.semantic_vector_fingerprint),
    toNumber(doc.backup_layout_version),
    toNumber(doc.legacy_daydir_version),
    toNumber(doc.video_meta_version),
    toNumber(doc.video_poster_rearm_version),
    toNumber(doc.video_screenshot_clear_version),
    toNumber(doc.preview_missing_redrive_version),
    toEnum(doc.geo_backfill_skipped, GEO_SKIPS),
    toJsonText(doc.exif),
    toJsonText(doc.place),
  ];
}

function locationRows(doc: Record<string, unknown>, id: string): Row[] {
  return asArray(doc.fileinfo).map((raw, ordinal) => {
    const entry = asRecord(raw);
    const libraryId = entry.library_id;
    const hex =
      typeof libraryId === 'string'
        ? libraryId.toLowerCase()
        : ((libraryId as { toHexString?(): string } | undefined)?.toHexString?.() ?? null);
    if (hex === null || !/^[0-9a-f]{24}$/.test(hex)) {
      throw new Error(`fileinfo[${ordinal}].library_id is not an ObjectId`);
    }
    return [
      id,
      ordinal,
      hex,
      typeof entry.path === 'string' ? entry.path : '',
      typeof entry.filename === 'string' ? entry.filename : '',
      toIso(entry.deleted_at),
      toIso(entry.missing_since),
      toText(entry.missing_reason),
      toBit(entry.keep),
    ];
  });
}

function faceRows(doc: Record<string, unknown>, id: string, ctx: MapContext): Row[] {
  return asArray(doc.faces).map((raw, faceIndex) => {
    const face = asRecord(raw);
    const bbox = asRecord(face.bbox);
    if (toNumber(bbox.x) === null) ctx.note('faces.bbox defaulted to zero');
    const personId = typeof face.person_id === 'string' ? face.person_id.toLowerCase() : null;
    return [
      id,
      faceIndex,
      personId !== null && /^[0-9a-f]{24}$/.test(personId) ? personId : null,
      numberOr(face.confidence, 0),
      numberOr(bbox.x, 0),
      numberOr(bbox.y, 0),
      numberOr(bbox.w, 0),
      numberOr(bbox.h, 0),
      toBit(face.hidden),
      toJsonText(face.landmarks),
      toJsonText(face.embedding),
      toText(face.embedding_version),
    ];
  });
}

function phassetRows(doc: Record<string, unknown>, id: string): Row[] {
  const seen = new Set<string>();
  const rows: Row[] = [];
  for (const raw of asArray(doc.phasset_links)) {
    const link = asRecord(raw);
    const deviceId = toText(link.device_id);
    const localId = toText(link.phasset_local_id);
    if (deviceId === null || localId === null) continue;
    // The table's UNIQUE (asset_id, device_id, phasset_local_id) is stronger
    // than the array was: Mongo could hold the same pair twice. Keep the first.
    const key = `${deviceId}\u0000${localId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push([
      id,
      deviceId,
      localId,
      toText(link.phasset_cloud_id),
      toIso(link.first_seen) ?? new Date(0).toISOString(),
    ]);
  }
  return rows;
}

function detailRow(doc: Record<string, unknown>, id: string): Row | null {
  const present = DETAIL_SOURCE_FIELDS.some(
    (field) => doc[field] !== undefined && doc[field] !== null,
  );
  if (!present) return null;
  return [
    id,
    toText(doc.description),
    null,
    typeof doc.ocr_text === 'string' ? doc.ocr_text : null,
    toJsonText(doc.ocr_meta),
    toJsonText(doc.vision),
    toJsonText(doc.vision_meta),
    toJsonText(doc.transcript),
    toJsonText(doc.video_description),
    toJsonText(doc.video_description_meta),
    toJsonText(doc.metadata_override),
    toJsonText(doc.derivative_audit),
    toJsonText(doc.geo_inferred),
  ];
}

function stageRows(doc: Record<string, unknown>, id: string, ctx: MapContext): Row[] {
  const stages = asRecord(doc.stages);
  const names = new Set<string>(ctx.stageNames);
  for (const name of Object.keys(stages)) {
    if (!names.has(name)) ctx.note(`stage:${name}`);
    names.add(name);
  }
  return [...names].map((name) => {
    const state = asRecord(stages[name]);
    return [
      id,
      name,
      intOr(state.version, 0),
      intOr(state.attempts, 0),
      toText(state.last_error),
      toIso(state.processed_at),
      toBit(state.dead),
      toIso(state.failed_at),
      toIso(state.next_attempt_at),
    ];
  });
}

function enrichmentRows(doc: Record<string, unknown>, id: string): Row[] {
  const enrichment = asRecord(doc.enrichment);
  const rows: Row[] = [];
  for (const stage of ENRICHMENT_STAGES) {
    const raw = enrichment[stage];
    if (raw === undefined || raw === null) continue;
    const state = asRecord(raw);
    rows.push([
      id,
      stage,
      toIso(state.done_at),
      toText(state.locked_by),
      toIso(state.lease_expires_at),
      intOr(state.attempts, 0),
      toText(state.last_error),
      toNumber(state.version),
      toIso(state.dead_letter_at),
    ]);
  }
  return rows;
}

/** Turns one asset document into every row it becomes. */
function mapAsset(doc: Record<string, unknown>, ctx: MapContext): TableRows[] {
  const id = docId(doc);
  const out: TableRows[] = [
    { table: 'assets', columns: ASSETS_COLUMNS, rows: [assetRow(doc, id, ctx)] },
    { table: 'asset_locations', columns: LOCATION_COLUMNS, rows: locationRows(doc, id) },
    { table: 'asset_phasset_links', columns: PHASSET_COLUMNS, rows: phassetRows(doc, id) },
    { table: 'faces', columns: FACE_COLUMNS, rows: faceRows(doc, id, ctx) },
    { table: 'stage_state', columns: STAGE_COLUMNS, rows: stageRows(doc, id, ctx) },
    { table: 'enrichment_state', columns: ENRICHMENT_COLUMNS, rows: enrichmentRows(doc, id) },
  ];

  const detail = detailRow(doc, id);
  if (detail !== null) out.push({ table: 'asset_detail', columns: DETAIL_COLUMNS, rows: [detail] });

  const blob = doc.search_blob;
  if (typeof blob === 'string' && blob.length > 0) {
    out.push({ table: 'asset_search', columns: SEARCH_COLUMNS, rows: [[id, blob]] });
  }
  return out;
}

export const assetsPlan: CollectionPlan = {
  source: 'assets',
  tables: [
    'assets',
    'asset_locations',
    'asset_phasset_links',
    'faces',
    'asset_detail',
    'asset_search',
    'stage_state',
    'enrichment_state',
  ],
  idKind: 'objectid',
  map: mapAsset,
  expected(db: Db, filter: Filter<Document>, ctx: MapContext): Promise<Record<string, number>> {
    return assetExpectedCounts(db, filter, ctx.stageNames);
  },
};
