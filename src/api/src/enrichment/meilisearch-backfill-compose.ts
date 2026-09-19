/**
 * Row → Meilisearch-document composition, shared by the main cursor pass
 * (`meilisearch-backfill.ts`) and the dead-letter redrive pass
 * (`meilisearch-backfill-redrive.ts`). Split out so both callers can write
 * and dead-letter documents through one code path without an import cycle
 * between the two pass-driving modules.
 */

// Type-only: `fileinfo[].library_id` is still an `ObjectId` on the wire, and
// `toFileInfo` is what mints it. No query in this module uses the driver.
import type { ObjectId } from 'mongodb';
import { recordBackfillFailure } from '../db/sqlite/repos/meilisearch-backfill.repo.ts';
import type {
  MeiliAssetBatch,
  MeiliAssetRow,
  MeiliFaceRow,
} from '../db/sqlite/repos/assets.meilisearch.ts';
import { toFileInfo } from '../db/sqlite/repos/assets.rows.ts';
import type { AssetFaceDoc, FileInfo, Place, TranscriptDoc, VisionDoc } from '../db/schema.ts';
import { classifyMediaType } from '../indexer/media-types.ts';
import { child as childLogger } from '../log.ts';
import { MeilisearchTaskError } from './meilisearch-transport.ts';
import { markAssetsVectorized } from './meilisearch-vector-coverage.ts';
import { composeSearchBlob } from './search-blob.ts';
import { placeTextForIndex, transcriptForIndex } from './asset-doc-fields.ts';
import type { MeilisearchAssetDoc, MeilisearchClient } from './meilisearch-client.ts';

const log = childLogger('enrichment:meilisearch-backfill');

export interface BackfillRow {
  /** The asset's 24-character hex id — the key of both the cursor and the
   * dead-letter work list. */
  id: string;
  maple_id?: string;
  fileinfo?: FileInfo[];
  exif?: { captured_at?: string | null; captured_month?: number | null } | null;
  place?: Place | null;
  description?: string | null;
  ocr_text?: string | null;
  transcript?: TranscriptDoc | null;
  vision?: VisionDoc | null;
  is_screenshot?: boolean | null;
  faces?: AssetFaceDoc[] | null;
  deleted_at?: string | null;
  hidden?: boolean;
}

/** A JSON column as the value it encodes, or `null` when it was never written. */
function decode<T>(text: string | null): T | null {
  return text === null ? null : (JSON.parse(text) as T);
}

/**
 * One face row as the type the people-name lookup accepts.
 *
 * Only `person_id` is read downstream; the geometry is carried because
 * `AssetFaceDoc` declares it, and selecting the real columns beats inventing
 * placeholder values to satisfy a type.
 */
function toFaceDoc(row: MeiliFaceRow): AssetFaceDoc {
  return {
    bbox: { x: row.bbox_x, y: row.bbox_y, w: row.bbox_w, h: row.bbox_h },
    person_id: row.person_id,
    confidence: row.confidence,
  };
}

/**
 * One batch row as the shape `composeDocument` reads.
 *
 * This is where the tables become the document again: the location rows rebuild
 * the `fileinfo[]` array `liveLocation` walks, the two JSON columns decode back
 * into their objects, and SQLite's 0/1 integers become the booleans the search
 * document carries.
 */
export function toBackfillRows(batch: MeiliAssetBatch): BackfillRow[] {
  return batch.rows.map((row: MeiliAssetRow) => ({
    id: row.id,
    maple_id: row.maple_id ?? undefined,
    fileinfo: toFileInfo(batch.locations.get(row.id) ?? []),
    exif: { captured_at: row.captured_at, captured_month: row.captured_month },
    place: decode<Place>(row.place),
    description: row.description,
    ocr_text: row.ocr_text,
    transcript: decode<TranscriptDoc>(row.transcript),
    vision: decode<VisionDoc>(row.vision),
    is_screenshot: row.is_screenshot === null ? null : row.is_screenshot === 1,
    faces: (batch.faces.get(row.id) ?? []).map(toFaceDoc),
    deleted_at: row.deleted_at,
    hidden: row.hidden === 1,
  }));
}

export interface ComposedEntry {
  row: BackfillRow;
  doc: MeilisearchAssetDoc;
}

/** A batch of composed documents plus tombstone ids, ready to write. Both the
 * main pass's `PreparedBatch` and the redrive pass's prep result satisfy
 * this shape. */
export interface WriteBatch {
  docs: ComposedEntry[];
  tombstoneIds: string[];
}

/** What a write reported: the totals, and the asset ids whose documents landed. */
export interface WriteOutcome {
  upserted: number;
  errors: number;
  /** Hex asset ids, for the vector-coverage stamp and the redrive's clear-up. */
  assetIds: string[];
}

export function liveLocation(row: BackfillRow): { folderId: ObjectId; filename: string } | null {
  if (row.deleted_at != null) return null;
  const primary = row.fileinfo?.find(
    (entry) => entry.deleted_at == null && entry.missing_since == null,
  );
  return primary ? { folderId: primary.library_id, filename: primary.filename } : null;
}

function nullIfMissing<T>(value: T | null | undefined): T | null {
  return value === undefined ? null : value;
}

function nullIfEmpty<T>(values: T[]): T[] | null {
  return values.length === 0 ? null : values;
}

function transcriptText(row: BackfillRow): string | null {
  return nullIfMissing(row.transcript?.text);
}

function capturedAt(row: BackfillRow): string | null {
  return nullIfMissing(row.exif?.captured_at);
}

export function composeDocument(
  row: BackfillRow,
  mapleId: string,
  folderId: ObjectId,
  filename: string,
  people: string[],
): MeilisearchAssetDoc {
  const vision = nullIfMissing(row.vision);
  const visionFields: Partial<VisionDoc> = vision ?? {};
  const searchBlob = composeSearchBlob({
    place: nullIfMissing(row.place),
    description: nullIfMissing(row.description),
    ocrText: nullIfMissing(row.ocr_text),
    transcript: transcriptText(row),
    visionSubjects: nullIfMissing(visionFields.subjects),
    visionSetting: nullIfMissing(visionFields.setting),
    visionActivity: nullIfMissing(visionFields.activity),
    visionNotableObjects: nullIfMissing(visionFields.notable_objects),
    visionTags: nullIfMissing(visionFields.tags),
    people,
    capturedMonth: nullIfMissing(row.exif?.captured_month),
  });
  return {
    id: mapleId,
    filename,
    searchBlob,
    description: nullIfMissing(row.description),
    ocrText: nullIfMissing(row.ocr_text),
    transcript: transcriptForIndex(row.transcript),
    placeText: placeTextForIndex(row.place),
    folderId: folderId.toHexString(),
    capturedAt: capturedAt(row),
    deletedAt: null,
    visionSceneType: nullIfMissing(visionFields.scene_type),
    visionActivity: nullIfMissing(visionFields.activity),
    visionSubjects: nullIfMissing(visionFields.subjects),
    isScreenshot: nullIfMissing(row.is_screenshot),
    people: nullIfEmpty(people),
    mediaType: classifyMediaType(filename),
    hidden: row.hidden === true,
  };
}

/** Dead-letter a row that failed to compose or write. Keyed on the asset id
 * (not a generated id) so a repeat failure for the same row increments
 * `attempts` on the same row instead of piling up duplicates — the
 * redrive pass relies on this to tell a first-time failure from a repeat. */
export async function recordFailure(
  row: BackfillRow,
  mapleId: string,
  error: unknown,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await recordBackfillFailure({
    assetId: row.id,
    mapleId,
    error: message,
    updatedAt: new Date().toISOString(),
  });
  log.warn({ mapleId, err: message }, 'backfill row dead-lettered');
}

function isPermanentDocumentFailure(error: unknown): boolean {
  return (
    error instanceof MeilisearchTaskError &&
    (error.code === 'missing_document_id' ||
      error.code === 'document_fields_limit_reached' ||
      error.code?.startsWith('invalid_document_') === true)
  );
}

/** Write composed documents, splitting the batch on a permanent per-document
 * rejection so one bad row can't block its siblings. Transient errors
 * (timeouts, transport failures) propagate to the caller unchanged. Not
 * exported — `commitBatch` below is the module's public write entry point. */
async function writeDocuments(
  client: MeilisearchClient,
  entries: ComposedEntry[],
): Promise<WriteOutcome> {
  if (entries.length === 0) return { upserted: 0, errors: 0, assetIds: [] };
  try {
    if (client.upsertBatchOrThrow) {
      await client.upsertBatchOrThrow(entries.map((entry) => entry.doc));
    } else {
      for (const entry of entries) await client.upsertOrThrow(entry.doc);
    }
    return {
      upserted: entries.length,
      errors: 0,
      assetIds: entries.map((entry) => entry.row.id),
    };
  } catch (error) {
    if (!isPermanentDocumentFailure(error)) throw error;
    if (entries.length === 1) {
      const entry = entries[0]!;
      await recordFailure(entry.row, entry.doc.id, error);
      return { upserted: 0, errors: 1, assetIds: [] };
    }
    const middle = Math.ceil(entries.length / 2);
    const left = await writeDocuments(client, entries.slice(0, middle));
    const right = await writeDocuments(client, entries.slice(middle));
    return {
      upserted: left.upserted + right.upserted,
      errors: left.errors + right.errors,
      assetIds: [...left.assetIds, ...right.assetIds],
    };
  }
}

/** Write a composed batch (documents + tombstones) and advance vector
 * coverage for whatever landed. Shared by the main pass and the redrive
 * pass — neither owns cursor or dead-letter bookkeeping, so this stays pure
 * write plumbing. */
export async function commitBatch(
  client: MeilisearchClient,
  batch: WriteBatch,
): Promise<WriteOutcome> {
  const writes = await writeDocuments(client, batch.docs);

  if (client.tombstoneBatchOrThrow) await client.tombstoneBatchOrThrow(batch.tombstoneIds);
  else for (const id of batch.tombstoneIds) await client.tombstone(id);
  await markAssetsVectorized(writes.assetIds, client.semanticFingerprint?.());
  return writes;
}
