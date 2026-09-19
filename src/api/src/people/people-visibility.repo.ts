/**
 * Person visibility toggles + id lists — the hide (#2124) and exclude
 * (#2894) domain. people.repo.ts re-exports everything here, so existing
 * importers are unchanged.
 *
 * `hidden` removes a person from the People pages; their photos still
 * appear everywhere (search callers opt in to dropping them via
 * `excludeHiddenPeople=true`). `excluded` is strictly stronger: search,
 * timeline buckets, facets, and map clusters drop their photos
 * UNCONDITIONALLY, and the Meili stage stops indexing their name. Both
 * flags keep faces assigned and the row alive as a clustering seed, so
 * restoring brings back a fully-populated cluster.
 *
 * The implementation lives in `db/repos/people.visibility.ts`.
 */

export {
  excludePerson,
  hidePerson,
  listExcludedPeople,
  listHiddenPeople,
  personIdsToDrop,
  unexcludePerson,
  unhidePerson,
} from '../db/repos/people.visibility.ts';
