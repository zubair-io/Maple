/**
 * Dead-letter redrive for the Meilisearch backfill. `meilisearch-backfill.ts`
 * records a row to `meilisearch_backfill_failures` when it can't be composed
 * or written (see `recordFailure` in `meilisearch-backfill-compose.ts`), then
 * advances its cursor past it — a transient failure (a hiccup resolving face
 * names, a momentary Meilisearch timeout) must not stall the whole migration.
 * That work list had no reader before this module: a row landing there stayed
 * dead forever unless an operator noticed and fixed it by hand.
 *
 * This module re-attempts those rows: re-fetch the asset by id, recompose,
 * and write it through the same path as the main pass. A row that succeeds
 * (or whose asset is now a tombstone/gone entirely) is cleared from the
 * dead-letter list; a row that fails again stays, with its `attempts`
 * counter incremented by the shared `recordFailure`.
 *
 * `redriveMeilisearchBackfillFailures` loops one `batchSize` page at a time
 * until the list is drained or a page recovers nothing — see its
 * doc comment for why that termination condition is safe.
 */

import {
  countBackfillFailures,
  deleteBackfillFailures,
  listOldestBackfillFailures,
  type BackfillFailureRow,
} from '../db/sqlite/repos/meilisearch-backfill.repo.ts';
import { loadMeiliAssetsByIds } from '../db/sqlite/repos/assets.meilisearch.ts';
import { child as childLogger } from '../log.ts';
import { loadNamedPeople, peopleNamesForFaces } from '../workers/stages/meili.ts';
import type { MeilisearchClient } from './meilisearch-client.ts';
import {
  commitBatch,
  composeDocument,
  liveLocation,
  recordFailure,
  toBackfillRows,
  type BackfillRow,
  type ComposedEntry,
} from './meilisearch-backfill-compose.ts';
import { withEmbedderPolicyGate } from './meilisearch-embedding-gate.ts';

const log = childLogger('enrichment:meilisearch-backfill-redrive');

export interface RedriveOutcome {
  /** Dead-letter rows picked up across every page of this drain run (each
   * page reads up to the caller's batch size). */
  retried: number;
  /** Rows resolved across the whole run — written, tombstoned, or found
   * already gone — and cleared from `meilisearch_backfill_failures`. */
  recovered: number;
  /** Rows still dead-lettered once the run stopped. */
  stillFailing: number;
}

/** Live count of dead-lettered rows — the Workers panel's redrivable backlog. */
export async function countMeilisearchBackfillFailures(): Promise<number> {
  return countBackfillFailures();
}

async function loadRowsByAssetId(ids: readonly string[]): Promise<Map<string, BackfillRow>> {
  if (ids.length === 0) return new Map();
  const rows = toBackfillRows(await loadMeiliAssetsByIds(ids));
  return new Map(rows.map((row) => [row.id, row]));
}

interface RedrivePrep {
  docs: ComposedEntry[];
  tombstoneIds: string[];
  /** Asset ids resolved by tombstoning (parallel to `tombstoneIds`). */
  tombstoneRowIds: string[];
  /** Failure ids whose asset is hard-deleted or never got a `maple_id` —
   * nothing left to redrive; the dead letter is just stale. */
  goneIds: string[];
}

async function prepareRedriveBatch(
  failures: readonly BackfillFailureRow[],
  rowsById: ReadonlyMap<string, BackfillRow>,
): Promise<RedrivePrep> {
  const namesById = await loadNamedPeople([...rowsById.values()].map((row) => row.faces));

  const docs: ComposedEntry[] = [];
  const tombstoneIds: string[] = [];
  const tombstoneRowIds: string[] = [];
  const goneIds: string[] = [];
  for (const failure of failures) {
    const row = rowsById.get(failure.asset_id);
    if (!row || !row.maple_id) {
      goneIds.push(failure.asset_id);
      continue;
    }
    const location = liveLocation(row);
    if (!location) {
      tombstoneIds.push(row.maple_id);
      tombstoneRowIds.push(row.id);
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

/** One page: read up to `batchSize` dead letters, re-attempt, and clear
 * whatever resolved. `redriveMeilisearchBackfillFailures` below drives this
 * in a loop so a backlog bigger than `batchSize` still fully drains. */
async function redriveFailurePage(
  client: MeilisearchClient,
  batchSize: number,
): Promise<RedriveOutcome> {
  const failures = await listOldestBackfillFailures(batchSize);
  if (failures.length === 0) return { retried: 0, recovered: 0, stillFailing: 0 };

  const rowsById = await loadRowsByAssetId(failures.map((failure) => failure.asset_id));
  const prep = await prepareRedriveBatch(failures, rowsById);
  const writes = await withEmbedderPolicyGate(client, () => commitBatch(client, prep));

  const resolvedIds = [...prep.goneIds, ...writes.assetIds, ...prep.tombstoneRowIds];
  await deleteBackfillFailures(resolvedIds);

  return {
    retried: failures.length,
    recovered: resolvedIds.length,
    stillFailing: failures.length - resolvedIds.length,
  };
}

/** Redrive dead-lettered rows, looping one `batchSize` page at a time until
 * the failures list is drained or a page recovers nothing.
 *
 * `listOldestBackfillFailures` sorts oldest-`updated_at`-first, and
 * `recordFailure` bumps `updated_at` on every repeat failure — so a row that
 * fails again within a page is pushed to the back of the queue rather than
 * re-read next page. That's what makes a zero-progress page a safe stop: once a
 * page's rows all fail, they've all just been bumped behind everything else
 * still in the list, so a following page could only be more of the same
 * already-failing rows (or, if the list is smaller than `batchSize`,
 * exactly the same rows) — looping again could not recover anything either.
 * Stopping there also bounds the loop against a batch of permanently-bad
 * rows that would otherwise spin forever. A page that *does* recover
 * something is proof of forward progress, so the loop keeps paging through
 * the rest of the backlog. Runs inside the caller's
 * `withMeilisearchBackfillLease` scope for as long as the drain takes — the
 * lease's heartbeat keeps it held.
 *
 * Never throws: a redrive failure (e.g. Meilisearch unreachable) is logged
 * and leaves whatever's left in the dead-letter list queued for the
 * next completed run rather than failing the backfill batch that just
 * finished successfully. */
export async function redriveMeilisearchBackfillFailures(
  client: MeilisearchClient,
  batchSize: number,
): Promise<RedriveOutcome> {
  const totals = { retried: 0, recovered: 0 };
  try {
    for (;;) {
      const page = await redriveFailurePage(client, batchSize);
      totals.retried += page.retried;
      totals.recovered += page.recovered;
      if (page.recovered === 0) break;
    }
  } catch (error) {
    log.warn(
      { err: error instanceof Error ? error.message : String(error) },
      'backfill dead-letter redrive pass failed; dead letters remain queued for the next run',
    );
    return { retried: 0, recovered: 0, stillFailing: 0 };
  }
  const outcome = { ...totals, stillFailing: await countMeilisearchBackfillFailures() };
  if (outcome.retried > 0) log.info(outcome, 'backfill dead-letter redrive pass complete');
  return outcome;
}
