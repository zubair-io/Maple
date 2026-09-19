/**
 * Name ↔ id resolution for the unified-search `people` filter (#2864).
 * Its own module rather than part of `people.repo.ts` for the file-size budget
 * (CONTRIBUTING.md § "File-size budget") — these two helpers serve only the
 * `/api/search*` routes and share nothing with the CRUD/merge machinery there.
 *
 * The implementation lives in `db/sqlite/repos/people.search-filter.ts`, where
 * the case-insensitive name match is a Unicode case fold (`name_key`) rather
 * than a Mongo collation.
 */

export { namesForPersonIds, personIdsForNames } from '../db/sqlite/repos/people.search-filter.ts';
