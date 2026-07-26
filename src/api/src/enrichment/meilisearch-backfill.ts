import type { Collection, ObjectId } from 'mongodb';
import { assetsCollection, getDb } from '../db/client.ts';
import type { AssetFaceDoc, FileInfo, Place, TranscriptDoc, VisionDoc } from '../db/schema.ts';
import { classifyMediaType } from '../indexer/media-types.ts';
import { child as childLogger } from '../log.ts';
import { resolveAssetPeopleNames } from '../workers/stages/meili.ts';
import {
  meilisearchClient,
  type MeilisearchAssetDoc,
  type MeilisearchClient,
} from './meilisearch-client.ts';
import { composeSearchBlob } from './search-blob.ts';

const log = childLogger('enrichment:meilisearch-backfill');
const STATE_ID = 'assets';

export interface BackfillState {
  _id: string;
  cursor: ObjectId | null;
  scanned: number;
  upserted: number;
  tombstoned?: number;
  skipped: number;
  errors: number;
  started_at: string;
  updated_at: string;
  completed_at: string | null;
}

interface BackfillFailure {
  _id: ObjectId;
  maple_id: string;
  error: string;
  attempts: number;
  updated_at: string;
}

interface BackfillRow {
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

interface PreparedBatch {
  scanned: number;
  skipped: number;
  errors: number;
  docs: MeilisearchAssetDoc[];
  tombstoneIds: string[];
  lastCursor: ObjectId | null;
}

export interface BackfillResult {
  scanned: number;
  upserted: number;
  tombstoned: number;
  skipped: number;
  errors: number;
  /** True when a bulk write failed and the durable cursor was retained. */
  retryable: boolean;
  /** Safe, bounded cause for a retained-cursor write failure. */
  retryableError: string | null;
  complete: boolean;
  nextCursor: string | null;
  cumulative: {
    scanned: number;
    upserted: number;
    tombstoned: number;
    skipped: number;
    errors: number;
    startedAt: string;
    updatedAt: string;
  } | null;
}

function freshState(now: string): BackfillState {
  return {
    _id: STATE_ID,
    cursor: null,
    scanned: 0,
    upserted: 0,
    tombstoned: 0,
    skipped: 0,
    errors: 0,
    started_at: now,
    updated_at: now,
    completed_at: null,
  };
}

async function loadState(
  states: Collection<BackfillState>,
  reset: boolean,
): Promise<BackfillState> {
  if (reset) await states.deleteOne({ _id: STATE_ID });
  const state = await states.findOne({ _id: STATE_ID });
  if (state) return state;
  const created = freshState(new Date().toISOString());
  await states.insertOne(created);
  return created;
}

function rowsAfter(cursor: ObjectId | null): Record<string, unknown> {
  const filter: Record<string, unknown> = { maple_id: { $type: 'string', $ne: '' } };
  if (cursor) filter._id = { $gt: cursor };
  return filter;
}

async function loadRows(state: BackfillState, batchSize: number): Promise<BackfillRow[]> {
  const coll = await assetsCollection();
  return (await coll
    .find(rowsAfter(state.cursor) as Parameters<typeof coll.find>[0], {
      projection: {
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
      },
    })
    .sort({ _id: 1 })
    .limit(batchSize)
    .toArray()) as unknown as BackfillRow[];
}

async function countRowsAfter(cursor: ObjectId | null): Promise<number> {
  const coll = await assetsCollection();
  return coll.countDocuments(rowsAfter(cursor) as Parameters<typeof coll.countDocuments>[0]);
}

/** Remaining cursor work for the generic migration progress surface. */
export async function countMeilisearchBackfillRemaining(): Promise<number> {
  const states = (await getDb()).collection<BackfillState>('meilisearch_backfill_state');
  const state = await states.findOne({ _id: STATE_ID });
  if (state?.completed_at) return 0;
  return countRowsAfter(state?.cursor ?? null);
}

function liveLocation(row: BackfillRow): { folderId: ObjectId; filename: string } | null {
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

async function composeDocument(
  row: BackfillRow,
  mapleId: string,
  folderId: ObjectId,
  filename: string,
): Promise<MeilisearchAssetDoc> {
  const people = await resolveAssetPeopleNames(nullIfMissing(row.faces));
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

async function recordFailure(row: BackfillRow, mapleId: string, error: unknown): Promise<void> {
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

async function prepareBatch(rows: BackfillRow[], cursor: ObjectId | null): Promise<PreparedBatch> {
  const prepared: PreparedBatch = {
    scanned: 0,
    skipped: 0,
    errors: 0,
    docs: [],
    tombstoneIds: [],
    lastCursor: cursor,
  };
  for (const row of rows) {
    prepared.scanned += 1;
    prepared.lastCursor = row._id;
    const mapleId = row.maple_id;
    if (!mapleId) {
      prepared.skipped += 1;
      continue;
    }
    const location = liveLocation(row);
    if (!location) {
      prepared.tombstoneIds.push(mapleId);
      prepared.skipped += 1;
      continue;
    }
    try {
      prepared.docs.push(await composeDocument(row, mapleId, location.folderId, location.filename));
    } catch (error) {
      prepared.errors += 1;
      await recordFailure(row, mapleId, error);
    }
  }
  return prepared;
}

async function commitBatch(client: MeilisearchClient, batch: PreparedBatch): Promise<void> {
  if (client.upsertBatchOrThrow) await client.upsertBatchOrThrow(batch.docs);
  else for (const doc of batch.docs) await client.upsertOrThrow(doc);

  if (client.tombstoneBatchOrThrow) await client.tombstoneBatchOrThrow(batch.tombstoneIds);
  else for (const id of batch.tombstoneIds) await client.tombstone(id);
}

async function saveProgress(
  states: Collection<BackfillState>,
  state: BackfillState,
  batch: PreparedBatch,
  writeSucceeded: boolean,
  complete: boolean,
): Promise<{ complete: boolean; updatedAt: string }> {
  const updatedAt = new Date().toISOString();
  await states.updateOne(
    { _id: STATE_ID },
    {
      $set: {
        cursor: writeSucceeded ? batch.lastCursor : state.cursor,
        updated_at: updatedAt,
        completed_at: complete ? updatedAt : null,
      },
      $inc: {
        scanned: writeSucceeded ? batch.scanned : 0,
        upserted: writeSucceeded ? batch.docs.length : 0,
        tombstoned: writeSucceeded ? batch.tombstoneIds.length : 0,
        skipped: writeSucceeded ? batch.skipped : 0,
        errors: writeSucceeded ? batch.errors : 0,
      },
    },
  );
  return { complete, updatedAt };
}

function completedResult(state: BackfillState): BackfillResult {
  return {
    scanned: 0,
    upserted: 0,
    tombstoned: 0,
    skipped: 0,
    errors: 0,
    retryable: false,
    retryableError: null,
    complete: true,
    nextCursor: null,
    cumulative: {
      scanned: state.scanned,
      upserted: state.upserted,
      tombstoned: state.tombstoned ?? 0,
      skipped: state.skipped,
      errors: state.errors,
      startedAt: state.started_at,
      updatedAt: state.updated_at,
    },
  };
}

export async function runMeilisearchBackfill(
  batchSize: number,
  reset: boolean,
): Promise<BackfillResult> {
  const client = meilisearchClient();
  await client.ensureIndex();
  const states = (await getDb()).collection<BackfillState>('meilisearch_backfill_state');
  const state = await loadState(states, reset);
  if (state.completed_at) return completedResult(state);
  const rows = await loadRows(state, batchSize);
  const batch = await prepareBatch(rows, state.cursor);
  let writeSucceeded = true;
  let retryableError: string | null = null;
  try {
    await commitBatch(client, batch);
  } catch (error) {
    writeSucceeded = false;
    retryableError = (error instanceof Error ? error.message : String(error))
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 2000);
    log.warn(
      {
        err: retryableError,
        batchSize: batch.docs.length + batch.tombstoneIds.length,
      },
      'backfill batch failed; cursor retained for retry',
    );
  }
  // The indexed _id count avoids requiring an extra empty request when the
  // final batch happens to contain exactly batchSize rows.
  const complete = writeSucceeded && (await countRowsAfter(batch.lastCursor)) === 0;
  await saveProgress(states, state, batch, writeSucceeded, complete);
  const cumulative = await states.findOne({ _id: STATE_ID });
  const writeErrors = writeSucceeded ? 0 : 1;
  return {
    scanned: batch.scanned,
    upserted: writeSucceeded ? batch.docs.length : 0,
    tombstoned: writeSucceeded ? batch.tombstoneIds.length : 0,
    skipped: batch.skipped,
    errors: batch.errors + writeErrors,
    retryable: !writeSucceeded,
    retryableError,
    complete,
    nextCursor: complete
      ? null
      : ((writeSucceeded ? batch.lastCursor : state.cursor)?.toHexString() ?? null),
    cumulative: cumulative
      ? {
          scanned: cumulative.scanned,
          upserted: cumulative.upserted,
          tombstoned: cumulative.tombstoned ?? 0,
          skipped: cumulative.skipped,
          errors: cumulative.errors,
          startedAt: cumulative.started_at,
          updatedAt: cumulative.updated_at,
        }
      : null,
  };
}
