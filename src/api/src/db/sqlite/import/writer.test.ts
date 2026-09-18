/**
 * What the writer is allowed to call a rejected document (#3744).
 *
 * The per-document replay exists so one stale document out of a third of a
 * million cannot end a six-hour import. It is the wrong answer for anything
 * that is not a verdict on a document: the replay would record five hundred
 * identical rejects, the checkpoint would move past all five hundred, and a
 * resumed run reads `_id > last_id` and never looks at them again. Nothing
 * re-reads the reject list, so those documents would be lost — while the real
 * error, a full disk or a lock that never cleared, appears nowhere.
 *
 * These run against an in-memory database and need no MongoDB.
 */

import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { RowWriter, writeBatch, type MappedDocument } from './writer.ts';

/** A destination with one CHECK a single row can fail on its own. */
function openDatabase(): Database {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE t (id TEXT PRIMARY KEY, n INTEGER NOT NULL CHECK (n > 0))`);
  return db;
}

function document(id: string, n: number): MappedDocument {
  return { sourceId: id, batches: [{ table: 't', columns: ['id', 'n'], rows: [[id, n]] }] };
}

function rowCount(db: Database, table: string): number {
  return (db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

describe('writeBatch', () => {
  it('commits the whole batch in one transaction when nothing is refused', () => {
    const db = openDatabase();
    const writer = new RowWriter(db);
    const committedWith: number[] = [];

    const failures = writeBatch(db, writer, [document('a', 1), document('b', 2)], (list) => {
      committedWith.push(list.length);
    });

    expect(failures).toEqual([]);
    expect(committedWith).toEqual([0]);
    expect(rowCount(db, 't')).toBe(2);
    writer.finalize();
    db.close();
  });

  it('isolates the one document a CHECK refuses and commits the rest', () => {
    const db = openDatabase();
    const writer = new RowWriter(db);
    let reported: string[] = [];

    const failures = writeBatch(
      db,
      writer,
      [document('a', 1), document('bad', -1), document('c', 3)],
      (list) => {
        reported = list.map((entry) => entry.sourceId);
      },
    );

    expect(failures.map((entry) => entry.sourceId)).toEqual(['bad']);
    expect(reported).toEqual(['bad']);
    expect(failures[0]?.reason).toContain('CHECK constraint failed');
    expect(rowCount(db, 't')).toBe(2);
    writer.finalize();
    db.close();
  });

  /**
   * The regression: a fault that is not about the document must reach the
   * caller, so the run stops with the real error and the checkpoint — written
   * by `beforeCommit` — never runs.
   */
  it('re-throws a fault that is not a verdict on the document, and checkpoints nothing', () => {
    const db = new Database(':memory:');
    const writer = new RowWriter(db);
    let checkpointed = false;

    expect(() =>
      writeBatch(db, writer, [document('a', 1), document('b', 2)], () => {
        checkpointed = true;
      }),
    ).toThrow('no such table: t');

    expect(checkpointed).toBe(false);
    writer.finalize();
    db.close();
  });
});
