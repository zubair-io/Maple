import type { Collection, ObjectId } from 'mongodb';
import { assetsCollection, getDb } from '../db/client.ts';
import type { AssetFaceDoc, FileInfo, Place, TranscriptDoc, VisionDoc } from '../db/schema.ts';
import { classifyMediaType } from '../indexer/media-types.ts';
import { child as childLogger } from '../log.ts';
import { loadNamedPeople, peopleNamesForFaces } from '../workers/stages/meili.ts';
import {
  meilisearchClient,
  type MeilisearchAssetDoc,
  type MeilisearchClient,
} from './meilisearch-client.ts';
import { MeilisearchTaskError } from './meilisearch-transport.ts';
import { withMeilisearchBackfillLease } from './meilisearch-backfill-lease.ts';
import { markAssetsVectorized } from './meilisearch-vector-coverage.ts';
import { composeSearchBlob } from './search-blob.ts';

const log = childLogger('enrichment:meilisearch-backfill');
const STATE_ID = 'assets';
const MAX_TRANSIENT_RETRIES = 5;

export interface BackfillState {
  _id: string;
  cursor: ObjectId | null;
  scanned: number;
  upserted: number;
  tombstoned?: number;
  skipped: number;
  errors: number;
  remaining?: number;
  retry_attempts?: number;
  retry_error?: string | null;
  blocked_at?: string | null;
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
  docs: Array<{ row: BackfillRow; doc: MeilisearchAssetDoc }>;
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
  /** True once transient writes exhausted the bounded retry budget. */
  blocked: boolean;
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

function freshState(now: string, remaining: number): BackfillState {
  return {
    _id: STATE_ID,
    cursor: null,
    scanned: 0,
    upserted: 0,
    tombstoned: 0,
    skipped: 0,
    errors: 0,
    remaining,
    retry_attempts: 0,
    retry_error: null,
    blocked_at: null,
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
  if (state) {
    if (typeof state.remaining !== 'number' && !state.completed_at) {
      state.remaining = await countRowsAfter(state.cursor);
      await states.updateOne({ _id: STATE_ID }, { $set: { remaining: state.remaining } });
    }
    return state;
  }
  const created = freshState(new Date().toISOString(), await countRowsAfter(null));
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
  if (typeof state?.remaining === 'number') return state.remaining;
  return countRowsAfter(state?.cursor ?? null);
}

async function hasRowsAfter(cursor: ObjectId | null): Promise<boolean> {
  const coll = await assetsCollection();
  return (
    (await coll.findOne(rowsAfter(cursor) as Parameters<typeof coll.findOne>[0], {
      projection: { _id: 1 },
    })) !== null
  );
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

function composeDocument(
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
  const namesById = await loadNamedPeople(rows.map((row) => row.faces));
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
      const people = peopleNamesForFaces(row.faces, namesById);
      prepared.docs.push({
        row,
        doc: composeDocument(row, mapleId, location.folderId, location.filename, people),
      });
    } catch (error) {
      prepared.errors += 1;
      await recordFailure(row, mapleId, error);
    }
  }
  return prepared;
}

function isPermanentDocumentFailure(error: unknown): boolean {
  return (
    error instanceof MeilisearchTaskError &&
    (error.code === 'missing_document_id' ||
      error.code === 'document_fields_limit_reached' ||
      error.code?.startsWith('invalid_document_') === true)
  );
}

async function writeDocuments(
  client: MeilisearchClient,
  entries: PreparedBatch['docs'],
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

async function commitBatch(
  client: MeilisearchClient,
  batch: PreparedBatch,
): Promise<{ upserted: number; errors: number; assetIds: ObjectId[] }> {
  const writes = await writeDocuments(client, batch.docs);

  if (client.tombstoneBatchOrThrow) await client.tombstoneBatchOrThrow(batch.tombstoneIds);
  else for (const id of batch.tombstoneIds) await client.tombstone(id);
  await markAssetsVectorized(writes.assetIds, client.semanticFingerprint?.());
  return writes;
}

async function saveProgress(
  states: Collection<BackfillState>,
  state: BackfillState,
  batch: PreparedBatch,
  writes: { upserted: number; errors: number; assetIds: ObjectId[] },
  complete: boolean,
): Promise<{ complete: boolean; updatedAt: string }> {
  const updatedAt = new Date().toISOString();
  await states.updateOne(
    { _id: STATE_ID },
    {
      $set: {
        cursor: batch.lastCursor,
        updated_at: updatedAt,
        completed_at: complete ? updatedAt : null,
        remaining: complete ? 0 : Math.max(0, (state.remaining ?? batch.scanned) - batch.scanned),
        retry_attempts: 0,
        retry_error: null,
        blocked_at: null,
      },
      $inc: {
        scanned: batch.scanned,
        upserted: writes.upserted,
        tombstoned: batch.tombstoneIds.length,
        skipped: batch.skipped,
        errors: batch.errors + writes.errors,
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
    blocked: false,
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

async function saveRetryFailure(
  states: Collection<BackfillState>,
  state: BackfillState,
  error: string,
): Promise<{ attempts: number; blocked: boolean; updatedAt: string }> {
  const attempts = (state.retry_attempts ?? 0) + 1;
  const blocked = attempts >= MAX_TRANSIENT_RETRIES;
  const updatedAt = new Date().toISOString();
  await states.updateOne(
    { _id: STATE_ID },
    {
      $set: {
        retry_attempts: attempts,
        retry_error: error,
        blocked_at: blocked ? updatedAt : null,
        updated_at: updatedAt,
      },
    },
  );
  return { attempts, blocked, updatedAt };
}

/** Clear only the retry circuit; the durable cursor and progress are preserved. */
export async function clearMeilisearchBackfillRetryState(): Promise<void> {
  const states = (await getDb()).collection<BackfillState>('meilisearch_backfill_state');
  await states.updateOne(
    { _id: STATE_ID },
    {
      $set: {
        retry_attempts: 0,
        retry_error: null,
        blocked_at: null,
        updated_at: new Date().toISOString(),
      },
    },
  );
}

/** Reset durable progress without racing an active admin or migration batch. */
export async function resetMeilisearchBackfillState(): Promise<void> {
  await withMeilisearchBackfillLease(async () => {
    const db = await getDb();
    await db.collection<BackfillState>('meilisearch_backfill_state').deleteOne({ _id: STATE_ID });
  });
}

function cumulativeResult(state: BackfillState | null): BackfillResult['cumulative'] {
  if (!state) return null;
  return {
    scanned: state.scanned,
    upserted: state.upserted,
    tombstoned: state.tombstoned ?? 0,
    skipped: state.skipped,
    errors: state.errors,
    startedAt: state.started_at,
    updatedAt: state.updated_at,
  };
}

async function handleCommitFailure(
  states: Collection<BackfillState>,
  state: BackfillState,
  batch: PreparedBatch,
  error: unknown,
): Promise<BackfillResult> {
  const retryableError = (error instanceof Error ? error.message : String(error))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 2000);
  const retry = await saveRetryFailure(states, state, retryableError);
  log.warn(
    {
      err: retryableError,
      batchSize: batch.docs.length + batch.tombstoneIds.length,
      attempt: retry.attempts,
      blocked: retry.blocked,
    },
    retry.blocked
      ? 'backfill retry budget exhausted; cursor retained and migration blocked'
      : 'backfill batch failed; cursor retained for retry',
  );
  return {
    scanned: batch.scanned,
    upserted: 0,
    tombstoned: 0,
    skipped: batch.skipped,
    errors: batch.errors + 1,
    retryable: true,
    retryableError,
    blocked: retry.blocked,
    complete: false,
    nextCursor: state.cursor?.toHexString() ?? null,
    cumulative: cumulativeResult(await states.findOne({ _id: STATE_ID })),
  };
}

async function finishCommittedBatch(
  states: Collection<BackfillState>,
  state: BackfillState,
  rows: BackfillRow[],
  batch: PreparedBatch,
  writes: { upserted: number; errors: number; assetIds: ObjectId[] },
  batchSize: number,
): Promise<BackfillResult> {
  // A short batch is final without another query. Exact-size batches use a
  // one-row existence check instead of repeatedly counting the whole suffix.
  const complete =
    rows.length < batchSize ||
    (batch.lastCursor !== null && !(await hasRowsAfter(batch.lastCursor)));
  await saveProgress(states, state, batch, writes, complete);
  return {
    scanned: batch.scanned,
    upserted: writes.upserted,
    tombstoned: batch.tombstoneIds.length,
    skipped: batch.skipped,
    errors: batch.errors + writes.errors,
    retryable: false,
    retryableError: null,
    blocked: false,
    complete,
    nextCursor: complete ? null : (batch.lastCursor?.toHexString() ?? null),
    cumulative: cumulativeResult(await states.findOne({ _id: STATE_ID })),
  };
}

async function runBackfillBatch(batchSize: number, reset: boolean): Promise<BackfillResult> {
  const client = meilisearchClient();
  if (!client.semanticConfigured()) {
    throw new Error(
      'Enable semantic search in Settings → Workers before running the vector backfill.',
    );
  }
  await client.ensureIndex();
  const states = (await getDb()).collection<BackfillState>('meilisearch_backfill_state');
  const state = await loadState(states, reset);
  if (state.completed_at) return completedResult(state);
  const rows = await loadRows(state, batchSize);
  const batch = await prepareBatch(rows, state.cursor);
  try {
    const writes = await commitBatch(client, batch);
    return finishCommittedBatch(states, state, rows, batch, writes, batchSize);
  } catch (error) {
    return handleCommitFailure(states, state, batch, error);
  }
}

export async function runMeilisearchBackfill(
  batchSize: number,
  reset: boolean,
): Promise<BackfillResult> {
  return withMeilisearchBackfillLease(() => runBackfillBatch(batchSize, reset));
}
