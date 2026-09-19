/**
 * The importer's own tables, which live in the destination database next to
 * the library.
 *
 * Resumption is the reason they exist. A run over 335,000 assets will be
 * interrupted — a laptop sleeps, a container is restarted, an operator loses
 * patience — and starting again from zero is not an acceptable answer, so the
 * importer has to be able to say exactly where it stopped.
 *
 * It can, because the checkpoint commits in the SAME transaction as the rows
 * that batch produced. There is no window in which rows exist without the
 * checkpoint that describes them, or a checkpoint ahead of its rows: SQLite
 * either commits both or neither. That is what makes "resume from the last
 * recorded `_id`" exactly correct rather than approximately correct, and it is
 * the whole reason batches are keyed on `_id` ascending instead of on a skip
 * offset, which would silently shift under a concurrent write.
 *
 * `import_rejects` is the second half of honesty about a run. A document the
 * importer cannot turn into rows is recorded with its source id and the reason,
 * and the run continues; the alternative — aborting a six-hour import on one
 * malformed row out of a third of a million — is worse for the operator and
 * teaches them nothing. Verification then treats a non-empty reject list as a
 * failure, so "the import finished" and "the import is correct" stay the two
 * different claims the ticket asks for.
 *
 * These tables are deliberately NOT part of the schema migration. They describe
 * one migration event, not the library, and an operator who wants them gone
 * after a successful cutover can drop all three without touching anything the
 * server reads.
 */

import type { Database } from 'bun:sqlite';
import { ObjectId } from 'mongodb';
import type { IdKind, ImportReject } from './types.ts';

const BOOKKEEPING_DDL = `
CREATE TABLE IF NOT EXISTS import_checkpoint (
  source      TEXT NOT NULL PRIMARY KEY,
  -- Highest source _id committed so far, rendered per id_kind. NULL before the
  -- first batch.
  last_id     TEXT,
  id_kind     TEXT NOT NULL CHECK (id_kind IN ('objectid', 'string')),
  documents   INTEGER NOT NULL DEFAULT 0,
  rejected    INTEGER NOT NULL DEFAULT 0,
  elapsed_ms  INTEGER NOT NULL DEFAULT 0,
  completed   INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0, 1)),
  updated_at  TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS import_rejects (
  id        INTEGER PRIMARY KEY,
  source    TEXT NOT NULL,
  source_id TEXT NOT NULL,
  reason    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS import_meta (
  key   TEXT NOT NULL PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;
`;

/**
 * `import_meta` key saying whether the derived triggers are currently in place.
 *
 * The bulk load drops them and puts them back at the end, so between those two
 * points the file is not one a server may be pointed at: it opens cleanly and
 * answers queries, and quietly maintains neither the FTS5 index nor
 * `assets.live_location_count`. A killed run leaves it that way, which is why
 * the state is written down rather than inferred — verification refuses a
 * database that is still marked dropped, and re-running restores it.
 */
export const DERIVED_STATE_KEY = 'derived';
export const DERIVED_DROPPED = 'dropped';
export const DERIVED_RESTORED = 'restored';

/** True when the derived triggers and indexes are in place. */
export function derivedRestored(db: Database): boolean {
  return readMeta(db, DERIVED_STATE_KEY) === DERIVED_RESTORED;
}

/** Where one collection's import stopped. */
export interface Checkpoint {
  source: string;
  lastId: unknown;
  documents: number;
  rejected: number;
  elapsedMs: number;
  completed: boolean;
}

interface CheckpointRow {
  source: string;
  last_id: string | null;
  id_kind: IdKind;
  documents: number;
  rejected: number;
  elapsed_ms: number;
  completed: number;
}

/** Creates the bookkeeping tables when they are absent. */
export function ensureBookkeeping(db: Database): void {
  db.exec(BOOKKEEPING_DDL);
}

/** Forgets every recorded checkpoint, for a `--restart` run. */
export function clearBookkeeping(db: Database): void {
  db.exec(`DELETE FROM import_checkpoint; DELETE FROM import_rejects; DELETE FROM import_meta;`);
}

/** Renders a source `_id` for storage in the checkpoint. */
function renderId(value: unknown): string {
  return value instanceof ObjectId ? value.toHexString() : String(value);
}

/** Reads a stored `_id` back into the type the source collection sorts on. */
function parseId(value: string, kind: IdKind): unknown {
  return kind === 'objectid' ? new ObjectId(value) : value;
}

/** Where `source` stopped, or null when it has never run. */
export function readCheckpoint(db: Database, source: string): Checkpoint | null {
  const row = db
    .query(
      `SELECT source, last_id, id_kind, documents, rejected, elapsed_ms, completed
         FROM import_checkpoint WHERE source = ?`,
    )
    .get(source) as CheckpointRow | null;
  if (row === null) return null;
  return {
    source: row.source,
    lastId: row.last_id === null ? null : parseId(row.last_id, row.id_kind),
    documents: row.documents,
    rejected: row.rejected,
    elapsedMs: row.elapsed_ms,
    completed: row.completed === 1,
  };
}

/**
 * Records progress. Called INSIDE the batch's transaction, which is the entire
 * point — see the module comment.
 */
export function writeCheckpoint(
  db: Database,
  source: string,
  idKind: IdKind,
  state: {
    lastId: unknown;
    documents: number;
    rejected: number;
    elapsedMs: number;
    completed: boolean;
  },
): void {
  db.run(
    `INSERT INTO import_checkpoint
       (source, last_id, id_kind, documents, rejected, elapsed_ms, completed, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (source) DO UPDATE SET
       last_id    = excluded.last_id,
       documents  = excluded.documents,
       rejected   = excluded.rejected,
       elapsed_ms = excluded.elapsed_ms,
       completed  = excluded.completed,
       updated_at = excluded.updated_at`,
    [
      source,
      state.lastId === null || state.lastId === undefined ? null : renderId(state.lastId),
      idKind,
      state.documents,
      state.rejected,
      state.elapsedMs,
      state.completed ? 1 : 0,
      new Date().toISOString(),
    ],
  );
}

/** Records a document that could not be turned into rows. */
export function writeReject(db: Database, reject: ImportReject): void {
  db.run(`INSERT INTO import_rejects (source, source_id, reason) VALUES (?, ?, ?)`, [
    reject.source,
    reject.sourceId,
    reject.reason,
  ]);
}

/** Every rejected document, oldest first. */
export function readRejects(db: Database): ImportReject[] {
  const rows = db
    .query(`SELECT source, source_id, reason FROM import_rejects ORDER BY id`)
    .all() as Array<{ source: string; source_id: string; reason: string }>;
  return rows.map((row) => ({
    source: row.source,
    sourceId: row.source_id,
    reason: row.reason,
  }));
}

/** Reads a durable importer setting, or null. */
export function readMeta(db: Database, key: string): string | null {
  const row = db.query(`SELECT value FROM import_meta WHERE key = ?`).get(key) as {
    value: string;
  } | null;
  return row?.value ?? null;
}

/** Writes a durable importer setting. */
export function writeMeta(db: Database, key: string, value: string): void {
  db.run(
    `INSERT INTO import_meta (key, value) VALUES (?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    [key, value],
  );
}
