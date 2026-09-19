/**
 * The Meilisearch vector backfill's cursor pass.
 *
 * Storage lives in two repository modules —
 * `db/repos/meilisearch-backfill.repo.ts` for the resume state, and
 * `db/repos/assets.meilisearch.ts` for the asset scan — so everything
 * here is the policy around them: which generation is current, what a batch
 * does with the rows, and how a failed write is retried.
 *
 * The cursor is the asset's hex id, and the scan is a keyed range over it. The
 * `remaining` counter is maintained rather than recounted, which is what keeps
 * a batch from paying for a full count of the library on every tick.
 */

import { child as childLogger } from '../log.ts';
import {
  advanceBackfillState,
  deleteBackfillState,
  insertBackfillState,
  readBackfillState,
  recordBackfillRetry,
  setBackfillRemaining,
  clearBackfillRetry,
  type BackfillStateRow,
} from '../db/repos/meilisearch-backfill.repo.ts';
import {
  countMeiliAssetsAfter,
  hasMeiliAssetsAfter,
  loadMeiliAssetsAfter,
} from '../db/repos/assets.meilisearch.ts';
import { loadNamedPeople, peopleNamesForFaces } from '../workers/stages/meili.ts';
import { meilisearchClient } from './meilisearch-client.ts';
import { ASSET_DOC_SHAPE_VERSION } from './meilisearch-embedder-template.ts';
import { withMeilisearchBackfillLease } from './meilisearch-backfill-lease.ts';
import {
  commitBatch,
  composeDocument,
  liveLocation,
  recordFailure,
  toBackfillRows,
  type BackfillRow,
  type ComposedEntry,
  type WriteOutcome,
} from './meilisearch-backfill-compose.ts';
import { redriveMeilisearchBackfillFailures } from './meilisearch-backfill-redrive.ts';
import { withEmbedderPolicyGate } from './meilisearch-embedding-gate.ts';

const log = childLogger('enrichment:meilisearch-backfill');
const MAX_TRANSIENT_RETRIES = 5;

/**
 * The stored resume point as the rest of the codebase reads it.
 *
 * Structurally the table's row: the admin status route renders the counters and
 * the timestamps, and nothing outside this module looks at the cursor.
 */
export type BackfillState = BackfillStateRow;

interface PreparedBatch {
  scanned: number;
  skipped: number;
  errors: number;
  docs: ComposedEntry[];
  tombstoneIds: string[];
  lastCursor: string | null;
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
function generationIsCurrent(state: BackfillState | null): boolean {
  return state !== null && state.doc_shape_version === ASSET_DOC_SHAPE_VERSION;
}

/** Drop a stored generation belonging to a superseded document shape. Returns
 * the state to resume, or `null` when a fresh generation must be started. */
async function currentGeneration(): Promise<BackfillState | null> {
  const stored = await readBackfillState();
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
    await deleteBackfillState();
  }
  return null;
}

async function loadState(reset: boolean): Promise<BackfillState> {
  if (reset) await deleteBackfillState();
  const state = await currentGeneration();
  if (state) {
    if (state.remaining === null && !state.completed_at) {
      state.remaining = await countMeiliAssetsAfter(state.cursor);
      await setBackfillRemaining(state.remaining);
    }
    return state;
  }
  await insertBackfillState({
    remaining: await countMeiliAssetsAfter(null),
    startedAt: new Date().toISOString(),
    docShapeVersion: ASSET_DOC_SHAPE_VERSION,
  });
  const created = await readBackfillState();
  if (created === null) throw new Error('meilisearch backfill: state row vanished after insert');
  return created;
}

/** Remaining cursor work for the generic migration progress surface. */
export async function countMeilisearchBackfillRemaining(): Promise<number> {
  const state = await readBackfillState();
  if (state?.completed_at) return 0;
  if (state !== null && state.remaining !== null) return state.remaining;
  return countMeiliAssetsAfter(state?.cursor ?? null);
}

async function prepareBatch(rows: BackfillRow[], cursor: string | null): Promise<PreparedBatch> {
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
    prepared.lastCursor = row.id;
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
  state: BackfillState,
  batch: PreparedBatch,
  writes: WriteOutcome,
  complete: boolean,
): Promise<void> {
  await advanceBackfillState({
    cursor: batch.lastCursor,
    updatedAt: new Date().toISOString(),
    complete,
    remaining: complete ? 0 : Math.max(0, (state.remaining ?? batch.scanned) - batch.scanned),
    scanned: batch.scanned,
    upserted: writes.upserted,
    tombstoned: batch.tombstoneIds.length,
    skipped: batch.skipped,
    errors: batch.errors + writes.errors,
  });
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
    cumulative: cumulativeResult(state),
  };
}

async function saveRetryFailure(
  state: BackfillState,
  error: string,
): Promise<{ attempts: number; blocked: boolean }> {
  const attempts = state.retry_attempts + 1;
  const blocked = attempts >= MAX_TRANSIENT_RETRIES;
  const updatedAt = new Date().toISOString();
  await recordBackfillRetry({
    attempts,
    error,
    blockedAt: blocked ? updatedAt : null,
    updatedAt,
  });
  return { attempts, blocked };
}

/** Clear only the retry circuit; the durable cursor and progress are preserved. */
export async function clearMeilisearchBackfillRetryState(): Promise<void> {
  await clearBackfillRetry(new Date().toISOString());
}

/** Reset durable progress without racing an active admin or migration batch. */
export async function resetMeilisearchBackfillState(): Promise<void> {
  await withMeilisearchBackfillLease(() => deleteBackfillState());
}

function cumulativeResult(state: BackfillState | null): BackfillResult['cumulative'] {
  if (!state) return null;
  return {
    scanned: state.scanned,
    upserted: state.upserted,
    tombstoned: state.tombstoned,
    skipped: state.skipped,
    errors: state.errors,
    startedAt: state.started_at,
    updatedAt: state.updated_at,
  };
}

async function handleCommitFailure(
  state: BackfillState,
  batch: PreparedBatch,
  error: unknown,
): Promise<BackfillResult> {
  const retryableError = (error instanceof Error ? error.message : String(error))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 2000);
  const retry = await saveRetryFailure(state, retryableError);
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
    nextCursor: state.cursor,
    cumulative: cumulativeResult(await readBackfillState()),
  };
}

async function finishCommittedBatch(
  state: BackfillState,
  rowCount: number,
  batch: PreparedBatch,
  writes: WriteOutcome,
  batchSize: number,
): Promise<BackfillResult> {
  // A short batch is final without another query. Exact-size batches use a
  // one-row existence check instead of repeatedly counting the whole suffix.
  const complete =
    rowCount < batchSize ||
    (batch.lastCursor !== null && !(await hasMeiliAssetsAfter(batch.lastCursor)));
  await saveProgress(state, batch, writes, complete);
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
    nextCursor: complete ? null : batch.lastCursor,
    cumulative: cumulativeResult(await readBackfillState()),
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
  const state = await loadState(reset);
  if (state.completed_at) return completedResult(state);
  const rows = toBackfillRows(await loadMeiliAssetsAfter(state.cursor, batchSize));
  const batch = await prepareBatch(rows, state.cursor);
  try {
    // Embedder admission gate (#3315): a policy-rejected embedder pauses the
    // `meili` stage and throws before the batch is submitted, so the failure
    // lands in `handleCommitFailure` — cursor retained, migration retry
    // circuit engaged — instead of holding Meilisearch's task queue for the
    // minutes it takes to fail the batch on its own.
    const writes = await withEmbedderPolicyGate(client, () => commitBatch(client, batch));
    const result = await finishCommittedBatch(state, rows.length, batch, writes, batchSize);
    // The cursor pass just reached the end of the library — redrive every row
    // parked in `meilisearch_backfill_failures` (paging `batchSize` rows at a
    // time until the list drains or a page makes no progress) while
    // still holding this call's backfill lease, so a transient failure gets a
    // same-run retry instead of sitting silently until an operator notices.
    // Best-effort: a redrive failure never turns this already-successful batch
    // into a retryable/blocked one — unresolved rows just stay queued for the
    // next completed run (e.g. an operator re-enabling the migration).
    if (result.complete) await redriveMeilisearchBackfillFailures(client, batchSize);
    return result;
  } catch (error) {
    return handleCommitFailure(state, batch, error);
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
  return loadState(reset);
}
