/**
 * Explicit multi-source merge — folds one or more source people into a chosen
 * target (the target always survives), plus the `mergeInto` primitive the
 * rename-on-collision path in `people.repo.ts` shares with it, so the
 * repoint / tombstone logic lives in exactly one place.
 *
 * The implementation lives in `db/sqlite/repos/people.merge.ts`, where one
 * merge is four statements in a single transaction rather than four successive
 * round trips. The survivor's face count is no longer recomputed as part of the
 * merge — there is no stored count to recompute; see
 * `db/sqlite/repos/people.face-count.ts`.
 */

export { mergePeopleInto } from '../db/sqlite/repos/people.merge.ts';
export type { MergePeopleResult } from '../db/sqlite/repos/people.merge.ts';
