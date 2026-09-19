/**
 * "This location row is absent — is that because another entry won its
 * address, and did that entry earn it?"
 *
 * The importer releases an entry whose address a better claim holds (see
 * `plan/contested-locations.ts`), so a mapped location row the destination does
 * not hold can be exactly right. Verification therefore has to tell a released
 * row from a lost one, and the cheap way to do it would be to hand the
 * verifier the same released set the importer used — which would make the check
 * agree with the importer by construction and catch nothing.
 *
 * So the question is re-asked against the destination instead. The row that
 * holds the address is right there, the ranking is a pure function of values
 * both rows carry, and re-running it says something the importer's own
 * bookkeeping cannot: not merely that the address is taken, but that it is
 * taken by the entry the rule says should have it. An importer that released
 * the live entry and kept the tombstone — the defect this whole change exists
 * to fix — fails here rather than reporting a clean migration.
 */

import type { Database } from 'bun:sqlite';
import { compareClaims, type ContestRule, type LocationClaim } from './plan/contested-locations.ts';

/** The entry a verifier expected to find a row for. */
export interface LocationEntry {
  assetId: string;
  ordinal: number;
  libraryId: string;
  path: string;
  filename: string;
  deletedAt: string | null;
  missingSince: string | null;
}

interface HolderRow {
  asset_id: string;
  ordinal: number;
  deleted_at: string | null;
  missing_since: string | null;
}

interface AssetRow {
  deleted_at: string | null;
  indexed_at: string;
}

const HOLDER_SQL = `
SELECT asset_id, ordinal, deleted_at, missing_since
  FROM asset_locations
 WHERE library_id = ? AND path = ? AND filename = ?`;

const ASSET_SQL = `SELECT deleted_at, indexed_at FROM assets WHERE id = ?`;

/** The asset-level half of a claim, read back from the destination. */
function assetOf(sqlite: Database, assetId: string): AssetRow | null {
  return sqlite.query(ASSET_SQL).get(assetId) as AssetRow | null;
}

/** A claim assembled from what the destination holds, or null when it cannot be. */
function claimOf(
  sqlite: Database,
  entry: {
    assetId: string;
    ordinal: number;
    deletedAt: string | null;
    missingSince: string | null;
  },
): LocationClaim | null {
  const asset = assetOf(sqlite, entry.assetId);
  if (asset === null) return null;
  return {
    assetId: entry.assetId,
    ordinal: entry.ordinal,
    deletedAt: entry.deletedAt,
    missingSince: entry.missingSince,
    assetDeletedAt: asset.deleted_at,
    indexedAt: asset.indexed_at,
  };
}

/** Why the row for `entry` is legitimately absent, or null when it should be there. */
export function releasedTo(sqlite: Database, entry: LocationEntry): string | null {
  const holder = sqlite
    .query(HOLDER_SQL)
    .get(entry.libraryId, entry.path, entry.filename) as HolderRow | null;
  // Nobody holds the address, or this entry does: either way the row's absence
  // has nothing to do with a contest.
  if (holder === null) return null;
  if (holder.asset_id === entry.assetId && holder.ordinal === entry.ordinal) return null;

  const loser = claimOf(sqlite, entry);
  const winner = claimOf(sqlite, {
    assetId: holder.asset_id,
    ordinal: holder.ordinal,
    deletedAt: holder.deleted_at,
    missingSince: holder.missing_since,
  });
  if (loser === null || winner === null) return null;

  const { order, rule } = compareClaims(winner, loser);
  return order < 0 ? describe(holder, rule) : null;
}

function describe(holder: HolderRow, rule: ContestRule): string {
  return `released: ${holder.asset_id}[${holder.ordinal}] holds this address (${rule})`;
}
