import type { Collection, ObjectId } from 'mongodb';
import { assetsCollection, getDb } from '../db/client.ts';
import { child as childLogger } from '../log.ts';
import { loadNamedPeople, peopleNamesForFaces } from '../workers/stages/meili.ts';
import { meilisearchClient } from './meilisearch-client.ts';
import { ASSET_DOC_SHAPE_VERSION } from './meilisearch-embedder-template.ts';
import { withMeilisearchBackfillLease } from './meilisearch-backfill-lease.ts';
import {
  ROW_PROJECTION,
  commitBatch,
  composeDocument,
  liveLocation,
  recordFailure,
  type BackfillRow,
  type ComposedEntry,
} from './meilisearch-backfill-compose.ts';
import { redriveMeilisearchBackfillFailures } from './meilisearch-backfill-redrive.ts';

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
  /** `ASSET_DOC_SHAPE_VERSION` this generation's documents were written for.
   * A completed run only means "the index is current" for the shape it ran
   * under; see `loadState`. Absent on states written before #2384. */
  doc_shape_version?: number;
}

interface PreparedBatch {
  scanned: number;
  skipped: number;
  errors: number;
  docs: ComposedEntry[];
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
    doc_shape_version: ASSET_DOC_SHAPE_VERSION,
  };
}

/**
 * Whether a stored generation still describes the documents we would write.
 *
 * `runBackfillBatch` short-circuits on `completed_at`, so a state left over
 * from an earlier document shape would report "complete" and re-upsert
 * nothing — the index silently keeps serving the old shape while the operator
 * sees a finished migration. A shape bump therefore starts a new generation
 * automatically, rather than depending on someone passing `reset=true` (#2384).
 *
 * Only the DOCUMENT shape matters here, not the full vector fingerprint: a
 * model or embedder-URL change is re-embedded by Meilisearch from the
 * documents already in its index and needs no re-upsert. Same distinction
 * `documentShapeOf` draws in `meilisearch-vector-coverage.ts`.
 */
function generationIsCurrent(state: BackfillState | null): state is BackfillState {
  return state !== null && state.doc_shape_version === ASSET_DOC_SHAPE_VERSION;
}

/** Drop a stored generation belonging to a superseded document shape. Returns
 * the state to resume, or `null` when a fresh generation must be started. */
async function currentGeneration(states: Collection<BackfillState>): Promise<BackfillState | null> {
  const stored = await states.findOne({ _id: STATE_ID });
  if (generationIsCurrent(stored)) return stored;
  if (stored) {
    log.info(
      {
        storedShape: stored.doc_shape_version ?? null,
        currentShape: ASSET_DOC_SHAPE_VERSION,
        discardedScanned: stored.scanned,
      },
      'meilisearch backfill: document shape changed — starting a new generation',
    );
    await states.deleteOne({ _id: STATE_ID });
  }
  return null;
}

async function loadState(
  states: Collection<BackfillState>,
  reset: boolean,
): Promise<BackfillState> {
  if (reset) await states.deleteOne({ _id: STATE_ID });
  const state = await currentGeneration(states);
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
      projection: ROW_PROJECTION,
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
    // Advance past this row unconditionally, including on a compose/write
    // failure below — a durable cursor that never revisits a dead-lettered
    // row is what keeps one bad row from stalling the whole migration. This
    // is safe because the end-of-run redrive pass (`redriveMeilisearchBackfillFailures`,
    // triggered once the cursor pass completes) re-attempts every row parked
    // in `meilisearch_backfill_failures` regardless of where the cursor is.
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
    const result = await finishCommittedBatch(states, state, rows, batch, writes, batchSize);
    // The cursor pass just reached the end of the library — redrive every row
    // parked in `meilisearch_backfill_failures` (paging `batchSize` rows at a
    // time until the collection drains or a page makes no progress) while
    // still holding this call's backfill lease, so a transient failure gets a
    // same-run retry instead of sitting silently until an operator notices.
    // Best-effort: a redrive failure never turns this already-successful batch
    // into a retryable/blocked one — unresolved rows just stay queued for the
    // next completed run (e.g. an operator re-enabling the migration).
    if (result.complete) await redriveMeilisearchBackfillFailures(client, batchSize);
    return result;
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

/** Test-only: exercise generation selection without a live Meilisearch. */
export async function loadBackfillStateForTests(reset: boolean): Promise<BackfillState> {
  const states = (await getDb()).collection<BackfillState>('meilisearch_backfill_state');
  return loadState(states, reset);
}
