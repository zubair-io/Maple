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
 * The `$set` fields that re-arm the meili stage on one or more assets in a
 * MongoDB update: reset the stage version below `meiliStage.targetVersion` so
 * `buildClaimQuery` (`workers/run-stage.ts`) reclaims the doc on its next poll
 * tick, and clear the dead-letter/attempt/processed-at bookkeeping so a row
 * that previously dead-lettered isn't permanently skipped and Settings →
 * Workers doesn't keep showing a stale last-processed timestamp for a stage
 * that's about to be retried clean.
 *
 * Kept as a plain constant — it performs no query of its own — for the call
 * sites outside this tier that still fold it into their own Mongo update
 * (`db/assets.trash.ts`, `library/relocate-*.ts`, `workers/discover/*`,
 * `workers/migration/move-backup-asset.ts`). Each of those moves to
 * `meiliRearmStatement` in `db/sqlite/repos/assets.stage-rearm.ts` as its own
 * tier is cut over; this constant goes away with the last one.
 */
export const MEILI_REARM_SET: Record<string, unknown> = {
  'stages.meili.version': 0,
  'stages.meili.dead': false,
  'stages.meili.attempts': 0,
  'stages.meili.last_error': null,
  'stages.meili.processed_at': null,
};
