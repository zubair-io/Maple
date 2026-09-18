/**
 * The two person lookups the search layer needs: names in, ids out for
 * filtering; ids in, names out for the facet picker (#3749).
 */

import { safeObjectId } from '../../safe-object-id.ts';
import { caseFoldKey } from '../case-fold.ts';
import { peopleDb, type SqliteDb } from './db-handle.ts';
import { livePersonIdsForNamesSql, personNamesByIdsSql } from './people.sql.ts';

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
 * Display names for a batch of person ids, keyed by canonical lowercase hex.
 *
 * Auto-generated "Person 12" names are filtered out in SQL so they never reach
 * the facet picker — an operator picking faces by name has no use for a cluster
 * nobody has named yet.
 */
export async function namesForPersonIds(
  hexIds: string[],
  dbOverride?: SqliteDb,
): Promise<Map<string, string>> {
  const valid = hexIds
    .map((hex) => safeObjectId(hex))
    .filter((id): id is NonNullable<typeof id> => id !== null)
    .map((id) => id.toHexString());
  if (valid.length === 0) return new Map();
  const db = peopleDb(dbOverride);
  const rows = await db.read<{ id: string; name: string }>(
    personNamesByIdsSql(valid.length),
    valid,
  );
  return new Map(rows.map((row) => [row.id, row.name] as const));
}
