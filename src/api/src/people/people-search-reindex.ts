/**
 * Re-index trigger for person-name search.
 *
 * The meili stage folds each asset's named people into its search_blob and
 * the Meilisearch document. Those tokens go stale the moment a person is
 * renamed, merged, (re)assigned, or hidden. Rather than duplicate the
 * stage's upsert logic, we reset the affected assets' `stages.meili.version`
 * to 0 — the worker claim query matches `stages.meili.version <
 * targetVersion` (see `run-stage.ts:buildClaimQuery`), so the runtime
 * re-queues each touched asset through `meiliHandler` on its next tick and
 * repopulates everything from the live row state.
 *
 * Callers invoke this fire-and-forget (logged on error) — a failed reset
 * must never break a rename/merge/assign/hide write.
 */

import type { ObjectId } from 'mongodb';
import { assetsCollection } from '../db/client.ts';
import { child as childLogger } from '../log.ts';

const log = childLogger('people:search-reindex');

/**
 * Reset `stages.meili.version` (and clear the dead-letter bookkeeping) on
 * every asset that carries a face assigned to one of `personIds`, so the
 * meili stage re-processes them. Person ids are matched as hex strings —
 * `faces[].person_id` is stored as a hex string, not an ObjectId.
 *
 * No-op when `personIds` is empty. Returns the number of assets reset.
 */
export async function markAssetsForMeiliReindex(
  personIds: Array<ObjectId | string>,
): Promise<number> {
  const hexIds = Array.from(
    new Set(
      personIds
        .map((id) => (typeof id === 'string' ? id : id.toHexString()))
        .filter((id) => id.length > 0),
    ),
  );
  if (hexIds.length === 0) return 0;
  const assets = await assetsCollection();
  const result = await assets.updateMany(
    { 'faces.person_id': { $in: hexIds } },
    {
      $set: {
        'stages.meili.version': 0,
        'stages.meili.dead': false,
        'stages.meili.attempts': 0,
        'stages.meili.last_error': null,
      },
    },
  );
  return result.modifiedCount;
}

/**
 * Fire-and-forget wrapper: schedules the reindex reset and logs (never
 * throws) on failure. Callers use this so a search-index hiccup can't fail
 * the originating people mutation.
 */
export function markAssetsForMeiliReindexBestEffort(personIds: Array<ObjectId | string>): void {
  void markAssetsForMeiliReindex(personIds).catch((err) => {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'failed to mark assets for meili reindex',
    );
  });
}
