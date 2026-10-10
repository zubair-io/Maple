/**
 * The reads the search child (#4463) keeps its engine current with: every vector once at boot,
 * then whatever the `embed` stage wrote since, then the full id list when the counts disagree.
 *
 * Only vectors of the engine's dimension are read. A model of another size cannot be compared
 * with the bge-m3 query vector at all, so its rows are left out rather than failing the load.
 */

import { sqliteDb, type SqliteDb } from './db-handle.ts';
import { placeholders } from './values.ts';

export const SEARCH_VECTOR_DIMS = 1024;

export interface StoredVectorRow {
  maple_id: string;
  vector: Uint8Array;
  embedded_at: string;
}

export interface VectorChangeRow {
  maple_id: string;
  embedded_at: string;
}

export async function countSearchVectors(dbOverride?: SqliteDb): Promise<number> {
  const rows = await sqliteDb(dbOverride).read<{ n: number }>(
    `SELECT COUNT(*) AS n FROM asset_vectors WHERE dims = ?`,
    [SEARCH_VECTOR_DIMS],
  );
  return rows[0]?.n ?? 0;
}

/** The next `limit` vectors after `cursor` in `maple_id` order; `null` starts from the top. */
export async function searchVectorsAfter(
  cursor: string | null,
  limit: number,
  dbOverride?: SqliteDb,
): Promise<StoredVectorRow[]> {
  return sqliteDb(dbOverride).read<StoredVectorRow>(
    `SELECT maple_id, vector, embedded_at FROM asset_vectors
      WHERE dims = ? AND maple_id > ?
      ORDER BY maple_id
      LIMIT ?`,
    [SEARCH_VECTOR_DIMS, cursor ?? '', limit],
  );
}

/** Ids and stamps of vectors written after `since`, oldest first, resuming after `after`. */
export async function searchVectorChangesSince(
  since: string,
  after: VectorChangeRow | null,
  limit: number,
  dbOverride?: SqliteDb,
): Promise<VectorChangeRow[]> {
  const resume = after ?? { embedded_at: since, maple_id: '' };
  return sqliteDb(dbOverride).read<VectorChangeRow>(
    `SELECT maple_id, embedded_at FROM asset_vectors
      WHERE embedded_at > ? AND dims = ? AND (embedded_at, maple_id) > (?, ?)
      ORDER BY embedded_at, maple_id
      LIMIT ?`,
    [since, SEARCH_VECTOR_DIMS, resume.embedded_at, resume.maple_id, limit],
  );
}

export async function searchVectorsFor(
  mapleIds: readonly string[],
  dbOverride?: SqliteDb,
): Promise<StoredVectorRow[]> {
  if (mapleIds.length === 0) return [];
  return sqliteDb(dbOverride).read<StoredVectorRow>(
    `SELECT maple_id, vector, embedded_at FROM asset_vectors
      WHERE dims = ? AND maple_id IN (${placeholders(mapleIds.length)})`,
    [SEARCH_VECTOR_DIMS, ...mapleIds],
  );
}

export async function allSearchVectorIds(dbOverride?: SqliteDb): Promise<string[]> {
  const rows = await sqliteDb(dbOverride).read<{ maple_id: string }>(
    `SELECT maple_id FROM asset_vectors WHERE dims = ?`,
    [SEARCH_VECTOR_DIMS],
  );
  return rows.map((row) => row.maple_id);
}
