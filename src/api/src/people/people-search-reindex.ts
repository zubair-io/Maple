/**
 * Re-index trigger for person-name search.
 *
 * The meili stage folds each asset's named people into its search document, so
 * those tokens go stale the moment a person is renamed, merged, (re)assigned or
 * hidden. Rather than duplicate the stage's upsert logic, the affected assets'
 * `meili` stage version is reset below the stage's target so the worker
 * re-claims them on its next poll tick and repopulates everything from the live
 * row state.
 *
 * The four re-arm functions now live in `db/sqlite/repos/people.search-reindex.ts`
 * and are re-exported here by name, so every existing importer is unchanged.
 * They are still fire-and-forget at the call sites that use the `BestEffort`
 * wrappers: a failed re-index must never break a rename/merge/assign/hide write.
 */

export {
  markAssetIdsForMeiliReindex,
  markAssetIdsForMeiliReindexBestEffort,
  markAssetsForMeiliReindex,
  markAssetsForMeiliReindexBestEffort,
} from '../db/sqlite/repos/people.search-reindex.ts';

/**
 * The field/value pairs that re-arm the meili stage on an asset: reset the
 * stage version below `meiliStage.targetVersion` so `buildClaimQuery`
 * (`workers/run-stage.ts`) reclaims the row on its next poll tick, and clear
 * the dead-letter/attempt/processed-at bookkeeping so a row that previously
 * dead-lettered isn't permanently skipped and Settings → Workers doesn't keep
 * showing a stale last-processed timestamp for a stage that's about to be
 * retried clean.
 *
 * It was a plain constant so the call sites outside this tier could fold it
 * into their own update statement. They now use `meiliRearmStatement`
 * (`db/sqlite/repos/assets.stage-rearm.ts`) instead, and nothing in the tree
 * reads this constant any more — it is the shape, kept as documentation of
 * what re-arming means, not a live dependency.
 */
export const MEILI_REARM_SET: Record<string, unknown> = {
  'stages.meili.version': 0,
  'stages.meili.dead': false,
  'stages.meili.attempts': 0,
  'stages.meili.last_error': null,
  'stages.meili.processed_at': null,
};
