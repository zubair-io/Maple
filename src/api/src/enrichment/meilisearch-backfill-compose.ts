/**
 * Row → Meilisearch-document composition, shared by the main cursor pass
 * (`meilisearch-backfill.ts`) and the dead-letter redrive pass
 * (`meilisearch-backfill-redrive.ts`). Split out so both callers can write
 * and dead-letter documents through one code path without an import cycle
 * between the two pass-driving modules.
 */

import type { ObjectId } from 'mongodb';
import { getDb } from '../db/client.ts';
import type { AssetFaceDoc, FileInfo, Place, TranscriptDoc, VisionDoc } from '../db/schema.ts';
import { classifyMediaType } from '../indexer/media-types.ts';
import { child as childLogger } from '../log.ts';
import { MeilisearchTaskError } from './meilisearch-transport.ts';
import { markAssetsVectorized } from './meilisearch-vector-coverage.ts';
import { composeSearchBlob } from './search-blob.ts';
import type { MeilisearchAssetDoc, MeilisearchClient } from './meilisearch-client.ts';

const log = childLogger('enrichment:meilisearch-backfill');

export interface BackfillFailure {
  _id: ObjectId;
  maple_id: string;
  error: string;
  attempts: number;
  updated_at: string;
}

export interface BackfillRow {
  _id: ObjectId;
  maple_id?: string;
  folder_id?: ObjectId;
  filename?: string;
  fileinfo?: FileInfo[];
  exif?: { captured_at?: string | null } | null;
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

/** Mongo projection shared by every row loader (main cursor pass + redrive
 * re-fetch) so the two stay in lockstep with what `composeDocument` reads. */
export const ROW_PROJECTION = {
  _id: 1,
  maple_id: 1,
  folder_id: 1,
  filename: 1,
  fileinfo: 1,
  'exif.captured_at': 1,
  place: 1,
  description: 1,
  ocr_text: 1,
  transcript: 1,
  vision: 1,
  is_screenshot: 1,
  faces: 1,
  deleted_at: 1,
  hidden: 1,
} as const;

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

export function liveLocation(row: BackfillRow): { folderId: ObjectId; filename: string } | null {
  if (row.deleted_at != null) return null;
  if (row.fileinfo && row.fileinfo.length > 0) {
    const primary = row.fileinfo.find(
      (entry) => entry.deleted_at == null && entry.missing_since == null,
    );
    return primary ? { folderId: primary.library_id, filename: primary.filename } : null;
  }
  return row.folder_id && row.filename ? { folderId: row.folder_id, filename: row.filename } : null;
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
    people,
  });
  return {
    id: mapleId,
    filename,
    searchBlob,
    description: nullIfMissing(row.description),
    ocrText: nullIfMissing(row.ocr_text),
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

/** Dead-letter a row that failed to compose or write. Upserts by asset `_id`
 * (not a generated id) so a repeat failure for the same row increments
 * `attempts` on the same document instead of piling up duplicates — the
 * redrive pass relies on this to tell a first-time failure from a repeat. */
export async function recordFailure(
  row: BackfillRow,
  mapleId: string,
  error: unknown,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const failures = (await getDb()).collection<BackfillFailure>('meilisearch_backfill_failures');
  await failures.updateOne(
    { _id: row._id },
    {
      $set: { maple_id: mapleId, error: message, updated_at: new Date().toISOString() },
      $inc: { attempts: 1 },
    },
    { upsert: true },
  );
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
 * (timeouts, transport failures) propagate to the caller unchanged. */
export async function writeDocuments(
  client: MeilisearchClient,
  entries: ComposedEntry[],
): Promise<{ upserted: number; errors: number; assetIds: ObjectId[] }> {
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
      assetIds: entries.map((entry) => entry.row._id),
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
): Promise<{ upserted: number; errors: number; assetIds: ObjectId[] }> {
  const writes = await writeDocuments(client, batch.docs);

  if (client.tombstoneBatchOrThrow) await client.tombstoneBatchOrThrow(batch.tombstoneIds);
  else for (const id of batch.tombstoneIds) await client.tombstone(id);
  await markAssetsVectorized(writes.assetIds, client.semanticFingerprint?.());
  return writes;
}
