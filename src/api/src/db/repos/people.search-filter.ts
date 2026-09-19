/**
 * The two person lookups the search layer needs: names in, ids out for
 * filtering; ids in, names out for the facet picker (#3749).
 */

import { safeObjectId } from '../object-id.ts';
import { caseFoldKey } from '../sqlite/case-fold.ts';
import { peopleDb, type SqliteDb } from './db-handle.ts';
import {
  INDEXABLE_ROSTER_NAMES_SQL,
  indexableNamesByIdsSql,
  livePersonIdsForNamesSql,
  personNamesByIdsSql,
} from './people.sql.ts';

/**
 * Hex ids of the live, non-hidden people holding these exact names, matched
 * case-insensitively.
 *
 * Returns `null` — not an empty array — for an empty name list, because callers
 * pass the result straight into the filter builder and `null` is what it reads
 * as "no person constraint at all". An empty array would mean "match nobody".
 *
 * Excluded people are deliberately included: exclusion is applied later, by
 * `personIdsToDrop`, against the assembled result.
 */
export async function personIdsForNames(
  names: string[],
  dbOverride?: SqliteDb,
): Promise<string[] | null> {
  if (names.length === 0) return null;
  const db = peopleDb(dbOverride);
  const rows = await db.read<{ id: string }>(
    livePersonIdsForNamesSql(names.length),
    names.map(caseFoldKey),
  );
  return rows.map((row) => row.id);
}

/**
 * The shared body of the two name lookups below: canonicalise the ids, run the
 * given statement over them, and key the answer by the same lowercase hex the
 * callers hold.
 *
 * The visibility rule is the only thing that separates those two lookups, and
 * it lives entirely in SQL — so what varies here is the statement, not a flag.
 * Everything around it stays identical because both callers hand over ids they
 * read out of the database themselves: the facet buckets' keys on one side, the
 * person ids on an asset's faces on the other. So an id that does not parse is
 * a stale row rather than a bad request and is dropped instead of rejected, an
 * empty batch answers without a round trip, and a person the statement withheld
 * is simply absent from the map — which every caller already treats as "no name
 * to show".
 */
async function namesByIds(
  hexIds: readonly string[],
  statement: (count: number) => string,
  dbOverride?: SqliteDb,
): Promise<Map<string, string>> {
  const valid = hexIds
    .map((hex) => safeObjectId(hex))
    .filter((id): id is NonNullable<typeof id> => id !== null)
    .map((id) => id.toHexString());
  if (valid.length === 0) return new Map();
  const rows = await peopleDb(dbOverride).read<{ id: string; name: string }>(
    statement(valid.length),
    valid,
  );
  return new Map(rows.map((row) => [row.id, row.name] as const));
}

/**
 * Display names for a batch of person ids, keyed by canonical lowercase hex.
 *
 * Auto-generated "Person 12" names are filtered out in SQL so they never reach
 * the facet picker — an operator picking faces by name has no use for a cluster
 * nobody has named yet.
 */
export function namesForPersonIds(
  hexIds: string[],
  dbOverride?: SqliteDb,
): Promise<Map<string, string>> {
  return namesByIds(hexIds, personNamesByIdsSql, dbOverride);
}

/**
 * Display names for a batch of person ids, keyed by canonical lowercase hex,
 * for the surfaces that put a name into an *index* rather than a picker.
 *
 * {@link namesForPersonIds} with one predicate more: an excluded person is left
 * out (#2894). The search-index stage folds these names into `search_blob` and
 * into the Meilisearch document's `people` attribute, so including an excluded
 * person there would make their name a search term — the one thing exclusion
 * means. The facet picker keeps the looser rule because exclusion is applied to
 * its results afterwards.
 */
export function indexableNamesForPersonIds(
  hexIds: readonly string[],
  dbOverride?: SqliteDb,
): Promise<Map<string, string>> {
  return namesByIds(hexIds, indexableNamesByIdsSql, dbOverride);
}

/**
 * Every name the generated-search prompt may use.
 *
 * The same visibility rule as {@link indexableNamesForPersonIds}, applied to the
 * whole roster instead of a batch. Withholding beats post-filtering here: a name
 * the model never sees is one it cannot build a themed collection around and put
 * on an unattended screen.
 */
export async function indexableRosterNames(dbOverride?: SqliteDb): Promise<string[]> {
  const rows = await peopleDb(dbOverride).read<{ name: string }>(INDEXABLE_ROSTER_NAMES_SQL);
  return rows.map((row) => row.name);
}
