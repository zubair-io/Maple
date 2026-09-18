/**
 * The shared people-list body: one visibility-scoped, name-sorted page with its
 * face counts and cover thumbnails (#3749).
 *
 * Its own module for the same reason `people-list-core.ts` is on the Mongo
 * side — the visibility repo needs it and the main repo re-exports the
 * visibility repo, so putting it in either would close a cycle.
 *
 * Two queries regardless of how many people come back: one for the rows, one
 * for every cover asset's primary location. The face counts ride along in a
 * third, and that third query is the whole point of this slice — see
 * `people.face-count.ts`.
 */

import path from 'node:path';
import { peopleDb, type SqliteDb } from './db-handle.ts';
import { faceCountByPerson } from './people.face-count.ts';
import { toPerson, type PersonRow } from './people.rows.ts';
import { primaryLocationsSql, listPeopleSql } from './people.sql.ts';
import type { PersonWithId } from '../../schema.ts';

/**
 * One row of the people grid.
 *
 * Imported shape-for-shape from what the Mongo repo returns, including the
 * distinction between `coverAbsPath` (kept for backward compatibility) and
 * `coverAddress` (the `slug:relPath` form `/api/thumb/:slug/*` wants).
 */
export interface PersonWithCount {
  person: PersonWithId;
  faceCount: number;
  coverAbsPath: string | null;
  /** slug:relPath address of the cover asset. Null if the cover is missing
   * or the library has no slug (pre-M1 install). */
  coverAddress: string | null;
}

/** Options shared by the list endpoints. */
export interface ListPeopleOptions {
  /** When true, include a `faceCount` per person. Default true. */
  withCounts?: boolean;
}

/** The visibility predicates the three listings differ by, and nothing else. */
export const LIVE_VISIBLE_PREDICATE = 'merged_into IS NULL AND hidden = 0 AND excluded = 0';
export const LIVE_HIDDEN_PREDICATE = 'merged_into IS NULL AND hidden = 1 AND excluded = 0';
export const LIVE_EXCLUDED_PREDICATE = 'merged_into IS NULL AND excluded = 1';

interface CoverRow {
  asset_id: string;
  path: string;
  filename: string;
  root: string;
  slug: string;
}

interface CoverInfo {
  absPath: string | null;
  address: string | null;
}

/**
 * Shared list body. Callers differ only in their visibility predicate;
 * everything downstream — cover resolution, face counts, sort — is identical.
 *
 * `predicate` is a SQL fragment, and every caller passes one of the three
 * constants above. It is never built from request input, which is why it can be
 * interpolated at all.
 */
export async function listPeopleByFilter(
  predicate: string,
  options: ListPeopleOptions = {},
  dbOverride?: SqliteDb,
): Promise<PersonWithCount[]> {
  const { withCounts = true } = options;
  const db = peopleDb(dbOverride);
  const rows = await db.read<PersonRow>(listPeopleSql(predicate));
  if (rows.length === 0) return [];

  const people = rows.map(toPerson);
  const [covers, counts] = await Promise.all([
    coverInfoByPerson(db, people),
    withCounts ? faceCountByPerson(db) : Promise.resolve(new Map<string, number>()),
  ]);

  return people.map((person) => {
    const hex = person._id.toHexString();
    return {
      person,
      faceCount: counts.get(hex) ?? 0,
      coverAbsPath: covers.get(hex)?.absPath ?? null,
      coverAddress: covers.get(hex)?.address ?? null,
    };
  });
}

/**
 * Resolve every person's `cover_asset_id` to a filesystem path and a public
 * address, in one keyed query.
 *
 * People whose cover is unset, malformed, or points at an asset that no longer
 * exists are simply absent from the map — the caller maps absence to `null`,
 * exactly as the Mongo version does.
 */
async function coverInfoByPerson(
  db: SqliteDb,
  people: readonly PersonWithId[],
): Promise<Map<string, CoverInfo>> {
  const personByCover = new Map<string, string>();
  for (const person of people) {
    const cover = person.cover_asset_id;
    if (!cover) continue;
    // Mongo accepts mixed-case hex in a string field while `_id`s round-trip
    // lowercase, so both sides of the join are normalised through the same
    // lowercasing the ids already carry.
    personByCover.set(cover.toLowerCase(), person._id.toHexString());
  }
  if (personByCover.size === 0) return new Map();

  const coverIds = [...personByCover.keys()];
  const rows = await db.read<CoverRow>(primaryLocationsSql(coverIds.length), coverIds);
  const out = new Map<string, CoverInfo>();
  for (const row of rows) {
    const personHex = personByCover.get(row.asset_id);
    if (!personHex) continue;
    const segments = row.path === '' ? [] : row.path.split('/');
    const relPath = row.path === '' ? row.filename : `${row.path}/${row.filename}`;
    out.set(personHex, {
      absPath: row.root ? path.join(row.root, ...segments, row.filename) : null,
      address: row.slug ? `${row.slug}:${relPath}` : null,
    });
  }
  return out;
}
