/**
 * `generated_searches` — the SQLite port of `workers/generated-search/repo.ts`
 * (#3751).
 *
 * The daily themed collections the generated-search worker invents, and the
 * contract between it and its three consumers: Settings → Workers, the Maple TV
 * shelf and the Apple widget.
 *
 * The stored `query` stays an opaque JSON parameter bag rather than becoming
 * columns, for the reason the Mongo module gives: it is replayed through the
 * same `buildFilter` as `/api/search` on every read, so the server-forced
 * constraints are applied at execution time and can never be stale in stored
 * data. Nothing filters into it, so there is nothing to index.
 *
 * Timestamps here are already ISO strings on both sides — `generated_at` is
 * written as one by the worker and compared lexically by the retention sweep,
 * which is correct for constant-width ISO 8601 — so this is the one ported
 * table with no `Date` conversion at the boundary.
 */

import type { ObjectId } from 'mongodb';
import type {
  GeneratedSearchDoc,
  GeneratedSearchInput,
} from '../../../workers/generated-search/repo.ts';
import type { GeneratedQuery } from '../../../workers/generated-search/validate.ts';
import { newObjectIdHex } from '../object-id.ts';
import { sqliteDb, type SqliteDb } from './db-handle.ts';
import { parseJson, toObjectId } from './values.ts';

export type { SqliteDb } from './db-handle.ts';
export type { GeneratedSearchDoc, GeneratedSearchInput };

const DAY_MS = 86_400_000;

const INSERT_SQL = `
  INSERT INTO generated_searches
    (id, library_id, generated_for, generated_at, model, attempts,
     theme, title, subtitle, query, result_count, cover_asset_id)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const SELECT_COLUMNS = `
  id, library_id, generated_for, generated_at, model, attempts,
  theme, title, subtitle, query, result_count, cover_asset_id`;

/** The most recent day this library produced anything for. */
const LATEST_DAY_SQL = `
  SELECT generated_for FROM generated_searches
   WHERE library_id = ? ORDER BY generated_for DESC LIMIT 1`;

interface GeneratedSearchRow {
  id: string;
  library_id: string;
  generated_for: string;
  generated_at: string;
  model: string;
  attempts: number;
  theme: string;
  title: string;
  subtitle: string | null;
  query: string;
  result_count: number;
  cover_asset_id: string | null;
}

function toDoc(row: GeneratedSearchRow): GeneratedSearchDoc {
  return {
    _id: toObjectId(row.id),
    library_id: row.library_id,
    generated_for: row.generated_for,
    generated_at: row.generated_at,
    model: row.model,
    attempts: row.attempts,
    theme: row.theme,
    title: row.title,
    subtitle: row.subtitle,
    query: parseJson<GeneratedQuery>(row.query, {}),
    result_count: row.result_count,
    cover_asset_id: row.cover_asset_id,
  };
}

/**
 * Persist one run's surviving collections.
 *
 * A no-op on an empty list: a run where every proposal missed the result floor
 * is a legitimate outcome, not an error. The batch goes in as one transaction
 * so a consumer reading mid-write sees either the whole day or none of it,
 * which is what `insertMany` gave by default.
 */
export async function saveGeneratedSearches(
  docs: readonly GeneratedSearchInput[],
  dbOverride?: SqliteDb,
): Promise<void> {
  if (docs.length === 0) return;
  await sqliteDb(dbOverride).transaction(
    docs.map((doc) => ({
      sql: INSERT_SQL,
      params: [
        newObjectIdHex(),
        doc.library_id,
        doc.generated_for,
        doc.generated_at,
        doc.model,
        doc.attempts,
        doc.theme,
        doc.title,
        doc.subtitle,
        JSON.stringify(doc.query),
        doc.result_count,
        doc.cover_asset_id,
      ],
    })),
  );
}

/**
 * One day's collections for a library.
 *
 * Omit `generatedFor` to get the most recent day that produced anything, which
 * is what every consumer wants by default: it keeps the widget and the TV shelf
 * showing yesterday's set when a run is late or a day came up empty, rather
 * than showing nothing. A library that has never produced a collection answers
 * with an empty list.
 */
export async function listGeneratedSearches(
  libraryId: string,
  generatedFor?: string,
  dbOverride?: SqliteDb,
): Promise<GeneratedSearchDoc[]> {
  const db = sqliteDb(dbOverride);
  const latest =
    generatedFor ??
    (await db.read<{ generated_for: string }>(LATEST_DAY_SQL, [libraryId]))[0]?.generated_for;
  if (latest === undefined) return [];

  const rows = await db.read<GeneratedSearchRow>(
    `SELECT ${SELECT_COLUMNS} FROM generated_searches
      WHERE library_id = ? AND generated_for = ?`,
    [libraryId, latest],
  );
  return rows.map(toDoc);
}

/**
 * One collection by its id, for `GET /api/generated-searches/:id/assets`.
 *
 * That route reads the collection inline through `getDb()` today rather than
 * through the repo module; it is the table's remaining read, so it is ported
 * here and the route loses its direct database access at the cutover.
 */
export async function findGeneratedSearchById(
  id: ObjectId,
  dbOverride?: SqliteDb,
): Promise<GeneratedSearchDoc | null> {
  const rows = await sqliteDb(dbOverride).read<GeneratedSearchRow>(
    `SELECT ${SELECT_COLUMNS} FROM generated_searches WHERE id = ?`,
    [id.toHexString()],
  );
  const row = rows[0];
  return row === undefined ? null : toDoc(row);
}

/**
 * Themes this library produced on or after `sinceIso`, so the next run's prompt
 * can be told not to repeat itself.
 *
 * Themes only — the prompt never sees the rest of the row, and reading the whole
 * document to use one field is what the narrow projections in this schema exist
 * to avoid. `generated_at` is an ISO string with constant-width fields, so the
 * range is a lexicographic compare, the same one `pruneGeneratedSearches` makes
 * at the other end of the window.
 */
export async function recentGeneratedSearchThemes(
  libraryId: string,
  sinceIso: string,
  dbOverride?: SqliteDb,
): Promise<string[]> {
  const rows = await sqliteDb(dbOverride).read<{ theme: string }>(
    `SELECT theme FROM generated_searches
      WHERE library_id = ? AND generated_at >= ? AND theme <> ''`,
    [libraryId, sinceIso],
  );
  return rows.map((row) => row.theme);
}

/**
 * Drop collections older than the retention window, returning how many rows
 * went. `now` is injected so the test can pin it rather than sleep.
 *
 * The count matters: the worker logs it and Settings → Workers shows it, so a
 * sweep that silently removed nothing is distinguishable from one that has
 * never run.
 */
export async function pruneGeneratedSearches(
  retentionDays: number,
  now: Date = new Date(),
  dbOverride?: SqliteDb,
): Promise<number> {
  const cutoffIso = new Date(now.getTime() - retentionDays * DAY_MS).toISOString();
  const result = await sqliteDb(dbOverride).write(
    `DELETE FROM generated_searches WHERE generated_at < ?`,
    [cutoffIso],
  );
  return result.changes;
}
