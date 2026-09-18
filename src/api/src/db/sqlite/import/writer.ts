/**
 * Writing one batch of mapped documents, with per-document isolation only when
 * something actually goes wrong.
 *
 * The common path is the whole batch through cached prepared statements inside
 * one transaction: on a third of a million assets, anything per-row that is not
 * a bound `INSERT` shows up in the operator's downtime.
 *
 * The uncommon path is what makes a long import survivable. Eight years of
 * accumulated documents will contain a few the schema refuses — a duplicate
 * name where the case-insensitive unique index sees a collision, an enum value
 * a newer server wrote, a subdocument that is not the shape its type claims.
 * Aborting a six-hour import on one of those out of 335,000 is the wrong answer
 * and tells the operator nothing useful, so the batch is replayed one document
 * at a time inside a `SAVEPOINT` and the offenders are recorded with their
 * source id and the reason. Verification then treats a non-empty reject list as
 * a failure, which is how "it finished" stays separable from "it is correct".
 *
 * A document is the unit because its rows are: an asset that reaches the faces
 * table and then fails on a stage row must leave nothing behind, or the counts
 * stop meaning anything.
 */

import type { Database, Statement } from 'bun:sqlite';
import type { Row, TableRows } from './types.ts';
import { insertSql } from './plan/shared.ts';

/** One mapped document: its source id and the rows it became. */
export interface MappedDocument {
  sourceId: string;
  batches: TableRows[];
}

/** A document the writer could not commit, and why. */
export interface WriteFailure {
  sourceId: string;
  reason: string;
}

/**
 * `bun:sqlite` declares `Statement.run` variadically over its own binding
 * union. Our rows are already that union as an array, so the spread is correct
 * at runtime and only the declaration disagrees.
 */
type RunStatement = (...bindings: Row) => void;

/** Caches one prepared `INSERT` per (table, column list). */
export class RowWriter {
  private readonly statements = new Map<string, Statement>();

  constructor(private readonly db: Database) {}

  private statementFor(batch: TableRows): Statement {
    const key = `${batch.table}(${batch.columns.join(',')})`;
    const cached = this.statements.get(key);
    if (cached !== undefined) return cached;
    const prepared = this.db.prepare(insertSql(batch.table, batch.columns));
    this.statements.set(key, prepared);
    return prepared;
  }

  /** Inserts every row of one document. Throws on the first refusal. */
  writeDocument(document: MappedDocument): void {
    for (const batch of document.batches) {
      if (batch.rows.length === 0) continue;
      const statement = this.statementFor(batch);
      const run = statement.run.bind(statement) as RunStatement;
      for (const row of batch.rows) {
        run(...row);
      }
    }
  }

  /** Releases the cached statements. */
  finalize(): void {
    for (const statement of this.statements.values()) statement.finalize();
    this.statements.clear();
  }
}

/**
 * Writes a batch inside `commit`'s transaction, falling back to per-document
 * savepoints when any row is refused. Returns the documents that could not be
 * committed; every other document in the batch is committed.
 *
 * `beforeCommit` runs inside the same transaction as the rows — it is where the
 * checkpoint is written, which is the whole reason resumption is exact.
 */
export function writeBatch(
  db: Database,
  writer: RowWriter,
  documents: readonly MappedDocument[],
  beforeCommit: (failures: WriteFailure[]) => void,
): WriteFailure[] {
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const document of documents) writer.writeDocument(document);
    beforeCommit([]);
    db.exec('COMMIT');
    return [];
  } catch {
    rollbackQuietly(db);
  }

  const failures: WriteFailure[] = [];
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const document of documents) {
      db.exec('SAVEPOINT doc');
      try {
        writer.writeDocument(document);
        db.exec('RELEASE doc');
      } catch (err) {
        db.exec('ROLLBACK TO doc');
        db.exec('RELEASE doc');
        failures.push({ sourceId: document.sourceId, reason: errorMessage(err) });
      }
    }
    beforeCommit(failures);
    db.exec('COMMIT');
  } catch (err) {
    rollbackQuietly(db);
    throw err;
  }
  return failures;
}

function rollbackQuietly(db: Database): void {
  try {
    db.exec('ROLLBACK');
  } catch {
    // SQLite auto-rolls-back on some errors; the transaction is already gone.
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
