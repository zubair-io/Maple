/**
 * The reads the search child (#4463) keeps its engine current with: every vector once at boot,
 * then whatever the `embed` stage wrote since, then the full id list when the counts disagree.
 *
 * Only vectors of the engine's dimension written by the configured embedding model are read. The
 * query vector comes from bge-m3, so a row from any other model would rank by a meaningless
 * cosine; those rows are left out and counted instead (Settings → AI shows how many). The model is
 * compared without Ollama's implicit `:latest` (the stage records `bge-m3:latest` where the setting
 * may say `bge-m3`); the endpoint is not compared, since the 2026-10-09 audit found Ollama's and
 * fastembed's bge-m3 vectors identical.
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

const LATEST_TAG = ':latest';

/** A model name without Ollama's implicit `:latest` tag, so `bge-m3` and `bge-m3:latest` are one model. */
export function normalisedModel(model: string): string {
  const trimmed = model.trim();
  return trimmed.endsWith(LATEST_TAG) ? trimmed.slice(0, -LATEST_TAG.length) : trimmed;
}

/** Every `model` value a row of `model` may carry: the bare name and its `:latest` tag. */
export function modelSpellings(model: string): [string, string] {
  const name = normalisedModel(model);
  return [name, `${name}${LATEST_TAG}`];
}

const SEARCHABLE = `dims = ${SEARCH_VECTOR_DIMS} AND model IN (?, ?)`;

export async function countSearchVectors(model: string, dbOverride?: SqliteDb): Promise<number> {
  const rows = await sqliteDb(dbOverride).read<{ n: number }>(
    `SELECT COUNT(*) AS n FROM asset_vectors WHERE ${SEARCHABLE}`,
    [...modelSpellings(model)],
  );
  return rows[0]?.n ?? 0;
}

/** Vectors the engine will not load: another model's, or another dimension's. */
export async function countSkippedVectors(model: string, dbOverride?: SqliteDb): Promise<number> {
  const rows = await sqliteDb(dbOverride).read<{ n: number }>(
    `SELECT COUNT(*) AS n FROM asset_vectors WHERE NOT (${SEARCHABLE})`,
    [...modelSpellings(model)],
  );
  return rows[0]?.n ?? 0;
}

/** The next `limit` vectors after `cursor` in `maple_id` order; `null` starts from the top. */
export async function searchVectorsAfter(
  model: string,
  cursor: string | null,
  limit: number,
  dbOverride?: SqliteDb,
): Promise<StoredVectorRow[]> {
  return sqliteDb(dbOverride).read<StoredVectorRow>(
    `SELECT maple_id, vector, embedded_at FROM asset_vectors
      WHERE ${SEARCHABLE} AND maple_id > ?
      ORDER BY maple_id
      LIMIT ?`,
    [...modelSpellings(model), cursor ?? '', limit],
  );
}

/** Ids and stamps of vectors written after `since`, oldest first, resuming after `after`. */
export async function searchVectorChangesSince(
  model: string,
  since: string,
  after: VectorChangeRow | null,
  limit: number,
  dbOverride?: SqliteDb,
): Promise<VectorChangeRow[]> {
  const resume = after ?? { embedded_at: since, maple_id: '' };
  return sqliteDb(dbOverride).read<VectorChangeRow>(
    `SELECT maple_id, embedded_at FROM asset_vectors
      WHERE embedded_at > ? AND ${SEARCHABLE} AND (embedded_at, maple_id) > (?, ?)
      ORDER BY embedded_at, maple_id
      LIMIT ?`,
    [since, ...modelSpellings(model), resume.embedded_at, resume.maple_id, limit],
  );
}

export async function searchVectorsFor(
  model: string,
  mapleIds: readonly string[],
  dbOverride?: SqliteDb,
): Promise<StoredVectorRow[]> {
  if (mapleIds.length === 0) return [];
  return sqliteDb(dbOverride).read<StoredVectorRow>(
    `SELECT maple_id, vector, embedded_at FROM asset_vectors
      WHERE ${SEARCHABLE} AND maple_id IN (${placeholders(mapleIds.length)})`,
    [...modelSpellings(model), ...mapleIds],
  );
}

export async function allSearchVectorIds(model: string, dbOverride?: SqliteDb): Promise<string[]> {
  const rows = await sqliteDb(dbOverride).read<{ maple_id: string }>(
    `SELECT maple_id FROM asset_vectors WHERE ${SEARCHABLE}`,
    [...modelSpellings(model)],
  );
  return rows.map((row) => row.maple_id);
}
