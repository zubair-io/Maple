/**
 * Operator visibility markers: hide, exclude, and the two recovery listings
 * they feed (#3749).
 *
 * `hidden` and `excluded` are both soft markers that leave a person's faces
 * assigned and the row a clustering seed, so newly detected matching faces keep
 * flowing into the marked person instead of spawning a fresh visible cluster.
 * `excluded` is strictly the stronger of the two (#2894): it drops the person's
 * photos from every non-file listing unconditionally, while `hidden` only takes
 * effect when a caller opts in.
 */

import type { ObjectId } from 'mongodb';
import { peopleDb, type SqliteDb } from './db-handle.ts';
import {
  listPeopleByFilter,
  LIVE_EXCLUDED_PREDICATE,
  LIVE_HIDDEN_PREDICATE,
  type ListPeopleOptions,
  type PersonWithCount,
} from './people.list.ts';
import { markAssetsForMeiliReindexBestEffort } from './people.search-reindex.ts';
import { flaggedPersonIdsSql, setVisibilitySql } from './people.sql.ts';

/**
 * Soft-hidden people, for the Hidden recovery page.
 *
 * Excluded people are left out even when they are also hidden, because the
 * exclusion listing is where they are recovered from — a person in both states
 * appears once, on the stronger page.
 */
export function listHiddenPeople(
  options: ListPeopleOptions = {},
  dbOverride?: SqliteDb,
): Promise<PersonWithCount[]> {
  return listPeopleByFilter(LIVE_HIDDEN_PREDICATE, options, dbOverride);
}

/** Excluded people, for the exclusion recovery page. */
export function listExcludedPeople(
  options: ListPeopleOptions = {},
  dbOverride?: SqliteDb,
): Promise<PersonWithCount[]> {
  return listPeopleByFilter(LIVE_EXCLUDED_PREDICATE, options, dbOverride);
}

/**
 * Hex ids whose photos must be dropped from a search-shaped result: every
 * excluded person always, plus every hidden person when the caller opted in by
 * passing the literal string `'true'`.
 *
 * Deliberately not scoped to live rows. A merged-away person's id can still be
 * sitting in a cached client filter, and dropping it costs nothing.
 */
export async function personIdsToDrop(
  excludeHiddenPeople: string | undefined,
  dbOverride?: SqliteDb,
): Promise<string[]> {
  const db = peopleDb(dbOverride);
  const wantHidden = excludeHiddenPeople === 'true';
  const [excluded, hidden] = await Promise.all([
    db.read<{ id: string }>(flaggedPersonIdsSql('excluded')),
    wantHidden ? db.read<{ id: string }>(flaggedPersonIdsSql('hidden')) : Promise.resolve([]),
  ]);
  return [...new Set([...excluded, ...hidden].map((row) => row.id))];
}

/**
 * Set one visibility flag and re-index the person's assets.
 *
 * Idempotent, and deliberately silent about a missing person: the Mongo
 * original reports nothing either, and the routes treat hide/unhide as a
 * best-effort toggle rather than something that can 404.
 */
async function setVisibilityFlag(
  id: ObjectId,
  column: 'hidden' | 'excluded',
  value: boolean,
  dbOverride?: SqliteDb,
): Promise<void> {
  const db = peopleDb(dbOverride);
  await db.write(setVisibilitySql(column), [
    value ? 1 : 0,
    new Date().toISOString(),
    id.toHexString(),
  ]);
  markAssetsForMeiliReindexBestEffort([id], dbOverride);
}

export function hidePerson(id: ObjectId, dbOverride?: SqliteDb): Promise<void> {
  return setVisibilityFlag(id, 'hidden', true, dbOverride);
}

export function unhidePerson(id: ObjectId, dbOverride?: SqliteDb): Promise<void> {
  return setVisibilityFlag(id, 'hidden', false, dbOverride);
}

export function excludePerson(id: ObjectId, dbOverride?: SqliteDb): Promise<void> {
  return setVisibilityFlag(id, 'excluded', true, dbOverride);
}

export function unexcludePerson(id: ObjectId, dbOverride?: SqliteDb): Promise<void> {
  return setVisibilityFlag(id, 'excluded', false, dbOverride);
}
