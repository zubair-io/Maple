/**
 * Name ↔ id resolution for the unified-search `people` filter (#2864).
 * Split from `people.repo.ts` for the file-size budget (CONTRIBUTING.md
 * § "File-size budget") — these two helpers serve only the `/api/search*`
 * routes and share nothing with the CRUD/merge machinery there.
 */

import { ObjectId } from 'mongodb';
import { peopleCollection } from '../db/client.ts';
import { AUTO_PERSON_NAME } from './auto-person-name.ts';

/** Hex ids for the display names in search's `people` filter.
 * Case-insensitive under the same collation as the unique name index.
 * Merged-away and hidden persons resolve to nothing — matching their
 * absence from the facet picker — so a name that resolves to no live
 * person contributes no id and `buildFilter`'s empty-`$in` matches
 * nothing rather than everything. `null` when no names were requested,
 * so callers can pass the result straight through to `buildFilter`. */
export async function personIdsForNames(names: string[]): Promise<string[] | null> {
  if (names.length === 0) return null;
  const coll = await peopleCollection();
  const rows = await coll
    .find(
      { name: { $in: names }, merged_into: null, hidden: { $ne: true } },
      { projection: { _id: 1 } },
    )
    .collation({ locale: 'en', strength: 2 })
    .toArray();
  return rows.map((row) => row._id.toHexString());
}

/** Hex id → display name for live, visible, genuinely-named persons — the
 * join half of the facets `people` bucket: the faces aggregation groups by
 * `person_id` and this maps the surviving ids to names. Hidden and
 * merged-away persons are omitted so they drop out of the picker, and so
 * are clustering placeholders (`Person N`, #2879): a cluster the operator
 * hasn't named yet has no label worth showing and nothing a user could
 * mean by picking it. The Meili `people` attribute already excludes them
 * (`workers/stages/meili.ts`), so this also makes the two agree. Keys are
 * canonical `toHexString()` output (lowercase) — callers must canonicalize
 * their lookup keys the same way. */
export async function namesForPersonIds(hexIds: string[]): Promise<Map<string, string>> {
  const valid = hexIds.filter((id) => ObjectId.isValid(id));
  if (valid.length === 0) return new Map();
  const coll = await peopleCollection();
  const rows = await coll
    .find(
      {
        _id: { $in: valid.map((id) => new ObjectId(id)) },
        merged_into: null,
        hidden: { $ne: true },
        name: { $not: AUTO_PERSON_NAME },
      },
      { projection: { _id: 1, name: 1 } },
    )
    .toArray();
  return new Map(rows.map((row) => [row._id.toHexString(), row.name]));
}
