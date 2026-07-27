/**
 * Dead-letter redrive for the Meilisearch backfill. `meilisearch-backfill.ts`
 * records a row to `meilisearch_backfill_failures` when it can't be composed
 * or written (see `recordFailure` in `meilisearch-backfill-compose.ts`), then
 * advances its cursor past it — a transient failure (a Mongo hiccup resolving
 * face names, a momentary Meilisearch timeout) must not stall the whole
 * migration. That collection had no reader before this module: a row landing
 * there stayed dead forever unless an operator noticed and fixed it by hand.
 *
 * This module re-attempts those rows: re-fetch the asset by `_id`, recompose,
 * and write it through the same path as the main pass. A row that succeeds
 * (or whose asset is now a tombstone/gone entirely) is cleared from the
 * dead-letter collection; a row that fails again stays, with its `attempts`
 * counter incremented by the shared `recordFailure`.
 */

import type { ObjectId } from 'mongodb';
import { assetsCollection, getDb } from '../db/client.ts';
import { child as childLogger } from '../log.ts';
import { loadNamedPeople, peopleNamesForFaces } from '../workers/stages/meili.ts';
import type { MeilisearchClient } from './meilisearch-client.ts';
import {
  ROW_PROJECTION,
  commitBatch,
  composeDocument,
  liveLocation,
  recordFailure,
  type BackfillFailure,
  type BackfillRow,
  type ComposedEntry,
} from './meilisearch-backfill-compose.ts';

const log = childLogger('enrichment:meilisearch-backfill-redrive');
const REDRIVE_SORT = { updated_at: 1 } as const;

export interface RedriveOutcome {
  /** Dead-letter rows picked up this pass (bounded by the caller's batch size). */
  retried: number;
  /** Rows resolved this pass — written, tombstoned, or found already gone —
   * and cleared from `meilisearch_backfill_failures`. */
  recovered: number;
  /** Rows that failed again and remain dead-lettered. */
  stillFailing: number;
}

/** Live count of dead-lettered rows — the Workers panel's redrivable backlog. */
export async function countMeilisearchBackfillFailures(): Promise<number> {
  const failures = (await getDb()).collection<BackfillFailure>('meilisearch_backfill_failures');
  return failures.countDocuments();
}

async function loadFailureBatch(batchSize: number): Promise<BackfillFailure[]> {
  const failures = (await getDb()).collection<BackfillFailure>('meilisearch_backfill_failures');
  return failures.find({}).sort(REDRIVE_SORT).limit(batchSize).toArray();
}

async function loadRowsByAssetId(ids: ObjectId[]): Promise<Map<string, BackfillRow>> {
  if (ids.length === 0) return new Map();
  const coll = await assetsCollection();
  const rows = (await coll
    .find({ _id: { $in: ids } } as Parameters<typeof coll.find>[0], { projection: ROW_PROJECTION })
    .toArray()) as unknown as BackfillRow[];
  return new Map(rows.map((row) => [row._id.toHexString(), row]));
}

interface RedrivePrep {
  docs: ComposedEntry[];
  tombstoneIds: string[];
  /** Asset ids resolved by tombstoning (parallel to `tombstoneIds`). */
  tombstoneRowIds: ObjectId[];
  /** Failure ids whose asset is hard-deleted or never got a `maple_id` —
   * nothing left to redrive; the dead letter is just stale. */
  goneIds: ObjectId[];
}

async function prepareRedriveBatch(
  failures: BackfillFailure[],
  rowsById: Map<string, BackfillRow>,
): Promise<RedrivePrep> {
  const namesById = await loadNamedPeople([...rowsById.values()].map((row) => row.faces));

  const docs: ComposedEntry[] = [];
  const tombstoneIds: string[] = [];
  const tombstoneRowIds: ObjectId[] = [];
  const goneIds: ObjectId[] = [];
  for (const failure of failures) {
    const row = rowsById.get(failure._id.toHexString());
    if (!row || !row.maple_id) {
      goneIds.push(failure._id);
      continue;
    }
    const location = liveLocation(row);
    if (!location) {
      tombstoneIds.push(row.maple_id);
      tombstoneRowIds.push(row._id);
      continue;
    }
    try {
      const people = peopleNamesForFaces(row.faces, namesById);
      docs.push({
        row,
        doc: composeDocument(row, row.maple_id, location.folderId, location.filename, people),
      });
    } catch (error) {
      await recordFailure(row, row.maple_id, error);
    }
  }
  return { docs, tombstoneIds, tombstoneRowIds, goneIds };
}

async function redriveBackfillFailures(
  client: MeilisearchClient,
  batchSize: number,
): Promise<RedriveOutcome> {
  const failures = await loadFailureBatch(batchSize);
  if (failures.length === 0) return { retried: 0, recovered: 0, stillFailing: 0 };

  const rowsById = await loadRowsByAssetId(failures.map((failure) => failure._id));
  const prep = await prepareRedriveBatch(failures, rowsById);
  const writes = await commitBatch(client, prep);

  const resolvedIds = [...prep.goneIds, ...writes.assetIds, ...prep.tombstoneRowIds];
  if (resolvedIds.length > 0) {
    const failuresColl = (await getDb()).collection<BackfillFailure>(
      'meilisearch_backfill_failures',
    );
    await failuresColl.deleteMany({ _id: { $in: resolvedIds } });
  }

  return {
    retried: failures.length,
    recovered: resolvedIds.length,
    stillFailing: failures.length - resolvedIds.length,
  };
}

/** Redrive dead-lettered rows, bounded to `batchSize` per call. Never throws:
 * a redrive failure (e.g. Meilisearch unreachable) is logged and leaves the
 * dead letters queued for the next completed run rather than failing the
 * backfill batch that just finished successfully. */
export async function redriveMeilisearchBackfillFailures(
  client: MeilisearchClient,
  batchSize: number,
): Promise<RedriveOutcome> {
  try {
    const outcome = await redriveBackfillFailures(client, batchSize);
    if (outcome.retried > 0) log.info(outcome, 'backfill dead-letter redrive pass complete');
    return outcome;
  } catch (error) {
    log.warn(
      { err: error instanceof Error ? error.message : String(error) },
      'backfill dead-letter redrive pass failed; dead letters remain queued for the next run',
    );
    return { retried: 0, recovered: 0, stillFailing: 0 };
  }
}
