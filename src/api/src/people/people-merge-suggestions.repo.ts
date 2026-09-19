/**
 * DB-backed dismiss action for a person-page merge suggestion — the ONE
 * write path for "not the same person," permanently suppressing a pair via
 * `person_merge_dismissals` (checked by `computeMergeSuggestions` on every
 * subsequent clustering run) and advancing both docs to their next ranked
 * candidate immediately so the UI doesn't wait for the next run.
 *
 * The implementation lives in `db/sqlite/repos/people.merge-suggestions.ts`.
 */

export { dismissMergeSuggestion } from '../db/sqlite/repos/people.merge-suggestions.ts';
