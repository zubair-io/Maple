import type { AssetOwnerSummary } from '../assets.transform.ts';
import { sqliteDb, type SqliteDb } from './db-handle.ts';

/** One lookup per page, retaining email-free accounts and skipping absent owners. */
export async function ownerSummariesForIds(
  ownerIds: readonly (string | null | undefined)[],
  dbOverride?: SqliteDb,
): Promise<ReadonlyMap<string, AssetOwnerSummary>> {
  const ids = [...new Set(ownerIds.filter((id): id is string => id !== null && id !== undefined))];
  if (ids.length === 0) return new Map();
  const rows = await sqliteDb(dbOverride).read<AssetOwnerSummary>(
    `SELECT id, email FROM users WHERE id IN (${ids.map(() => '?').join(', ')})`,
    ids,
  );
  return new Map(rows.map((row) => [row.id, row]));
}
