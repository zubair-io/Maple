/**
 * Person visibility toggles + id lists — the hide (#2124) and exclude
 * (#2894) domain, split out of people.repo.ts to keep it under the
 * file-size budget. people.repo.ts re-exports everything here, so existing
 * importers are unchanged.
 *
 * `hidden` removes a person from the People pages; their photos still
 * appear everywhere (search callers opt in to dropping them via
 * `excludeHiddenPeople=true`). `excluded` is strictly stronger: search,
 * timeline buckets, facets, and map clusters drop their photos
 * UNCONDITIONALLY, and the Meili stage stops indexing their name. Both
 * flags keep faces assigned and the row alive as a clustering seed, so
 * restoring brings back a fully-populated cluster.
 */

import type { ObjectId } from 'mongodb';
import { peopleCollection } from '../db/client.ts';
import { markAssetsForMeiliReindexBestEffort } from './people-search-reindex.ts';
import { listPeopleByFilter, type ListPeopleOptions, type PersonWithCount } from './people.repo.ts';
import { child as childLogger } from '../log.ts';

const log = childLogger('people:visibility');

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * List soft-hidden people (the Hidden page). Same projection/shape as
 * `listPeople` so the web reuses the `ApiPerson` type — face counts and
 * cover paths included.
 */
export async function listHiddenPeople(
  options: ListPeopleOptions = {},
): Promise<PersonWithCount[]> {
  return listPeopleByFilter({ merged_into: null, hidden: true, excluded: { $ne: true } }, options);
}

/**
 * List excluded people (#2894) — the recovery list. Same projection/shape
 * as `listPeople`. A person that is both hidden and excluded shows here
 * (exclusion is the stronger state), not on the Hidden page.
 */
export async function listExcludedPeople(
  options: ListPeopleOptions = {},
): Promise<PersonWithCount[]> {
  return listPeopleByFilter({ merged_into: null, excluded: true }, options);
}

/** Hex ids of every soft-hidden person, for search's `excludeHiddenPeople`
 * filter. Deliberately NOT scoped to `merged_into: null` — a face still
 * pointing at a merged-away hidden person should stay excluded too. Ids are
 * hex strings because `faces[].person_id` stores the person's hex id, not an
 * ObjectId. */
export async function hiddenPersonIds(): Promise<string[]> {
  const coll = await peopleCollection();
  const rows = await coll.find({ hidden: true }, { projection: { _id: 1 } }).toArray();
  return rows.map((row) => row._id.toHexString());
}

/** Hex ids of every EXCLUDED person (#2894), for search's always-on
 * exclusion filter. Same merged-row rationale as `hiddenPersonIds`. */
export async function excludedPersonIds(): Promise<string[]> {
  const coll = await peopleCollection();
  const rows = await coll.find({ excluded: true }, { projection: { _id: 1 } }).toArray();
  return rows.map((row) => row._id.toHexString());
}

/** Set one visibility flag + `updated_at`, then queue the Meili name-token
 * reindex for every asset carrying the person's faces. All four public
 * toggles are this one write with different arguments. */
async function setVisibilityFlag(
  id: ObjectId,
  patch: { hidden: boolean } | { excluded: boolean },
  verb: string,
): Promise<void> {
  await (
    await peopleCollection()
  ).updateOne({ _id: id }, { $set: { ...patch, updated_at: nowIso() } });
  markAssetsForMeiliReindexBestEffort([id]);
  log.info({ id: id.toHexString() }, verb);
}

/**
 * Soft-hide a person. Sets `hidden: true` on the row (idempotent).
 * Keeps it as a clustering seed so faces continue to group into it.
 */
export async function hidePerson(id: ObjectId): Promise<void> {
  await setVisibilityFlag(id, { hidden: true }, 'hid person');
}

/** Restore a hidden person — clears the `hidden` flag. */
export async function unhidePerson(id: ObjectId): Promise<void> {
  await setVisibilityFlag(id, { hidden: false }, 'unhid person');
}

/**
 * Exclude a person (#2894): their photos vanish from every non-file
 * listing API. Sets `excluded: true` (idempotent); the Meili reindex drops
 * their name tokens from the search blobs. Stays a clustering seed.
 */
export async function excludePerson(id: ObjectId): Promise<void> {
  await setVisibilityFlag(id, { excluded: true }, 'excluded person');
}

/**
 * Restore an excluded person — clears the `excluded` flag and reindexes
 * their name back into search.
 */
export async function unexcludePerson(id: ObjectId): Promise<void> {
  await setVisibilityFlag(id, { excluded: false }, 'unexcluded person');
}
