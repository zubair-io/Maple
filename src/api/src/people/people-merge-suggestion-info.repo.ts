/**
 * Resolves a person's stored merge candidates into display info for the
 * person-page merge-suggestion banner.
 *
 * The implementation lives in `db/sqlite/repos/people.merge-suggestions.ts`
 * alongside the dismiss write path, since both walk the same ranked list and
 * the same dismissal set. `loadSuggestedMergeInfo`'s first argument is now the
 * database handle rather than a Mongo collection; everything else about the
 * call is unchanged.
 */

export { loadSuggestedMergeInfo } from '../db/sqlite/repos/people.merge-suggestions.ts';
export type { SuggestedMergeInfo } from '../db/sqlite/repos/people.merge-suggestions.ts';
