/**
 * People repository — CRUD + merge semantics for face-cluster identities.
 *
 * Naming rule: a person's `name` is unique case-insensitively. Tagging two
 * clusters with the same name MERGES them: the destination keeps the survivor
 * row, the source is marked `merged_into = survivor` (audit trail; hidden from
 * listings), and every face pointing at the source is repointed at the
 * survivor. The unique index on the folded name key is the safety net — the
 * merge logic is what the route calls.
 *
 * The implementation lives in `db/sqlite/repos/people.repo.ts`, with the
 * visibility toggles in `people.visibility.ts` and the listing body in
 * `people.list.ts`. Everything is re-exported by name here so the routes,
 * workers and the clustering job keep importing from the same place they
 * always have.
 */

export {
  assignFaceToPerson,
  createPerson,
  FACE_DETAIL_LIMIT,
  getPerson,
  hideFace,
  listPeople,
  readFaces,
  renamePerson,
} from '../db/sqlite/repos/people.repo.ts';
export type {
  PersonDetail,
  PersonDetailFace,
  RenameResult,
} from '../db/sqlite/repos/people.repo.ts';

export type { ListPeopleOptions, PersonWithCount } from './people-list-core.ts';

// Visibility toggles + id lists (hide #2124, exclude #2894) live in
// people-visibility.repo.ts; re-exported here so importers are unchanged.
export {
  excludePerson,
  hidePerson,
  listExcludedPeople,
  listHiddenPeople,
  personIdsToDrop,
  unexcludePerson,
  unhidePerson,
} from './people-visibility.repo.ts';
