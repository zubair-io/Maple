/**
 * `mirror_queue` — the SQLite port of `fs/mirror-queue.repo.ts` (#3751).
 *
 * The durable work queue between the detectors (the mirror-scan worker and the
 * inline `onMirrorFailure` sink) and the mirror copy worker. Detectors only
 * enqueue; the copy worker claims a row under a lease, copies the file, then
 * completes or retries it.
 *
 * ## Why the id is a number here
 *
 * `mirror_queue` is one of the tables `docs/sqlite-schema.md` gives an
 * `INTEGER PRIMARY KEY` rowid, because its identifiers never reach a client.
 * Checking that claim against the only consumer, `workers/mirror/copy.ts`: it
 * takes `entry._id` off a claimed row and hands it straight back to
 * {@link completeMirrorCopy} or {@link failMirrorCopy}. The id is never
 * serialised, compared, logged or stored — it is an opaque round trip inside
 * one function.
 *
 * So {@link MirrorQueueEntry} keeps the field name `_id` and changes only its
 * type, and the copy worker compiles unchanged at the cutover (#3752). Minting
 * a 24-character hex id for a row nobody outside this file can name would cost
 * an index twice the width for no reader.
 *
 * ## Why the claim is a compare-and-swap rather than `RETURNING`
 *
 * The Mongo claim is `findOneAndUpdate` with a sort: pick the oldest free or
 * lease-expired row and lease it, in one indivisible step, so two copy workers
 * can never be handed the same row. The obvious SQLite translation is
 * `UPDATE … RETURNING`, and it cannot be expressed through this pool: `read()`
 * is dispatched to a reader worker holding a `readonly` connection, and
 * `write()` / `transaction()` run on the writer but report only row counts, so
 * a `RETURNING` clause's rows are discarded.
 *
 * {@link claimNextMirrorCopy} therefore reads a short list of candidates and
 * then issues a conditional `UPDATE … WHERE id = ? AND dead = 0 AND (claimed_at
 * IS NULL OR claimed_at < ?)`. The row count is what establishes the winner:
 * `changes === 1` means this caller moved the row out of the free set, and a
 * rival that raced in between gets `changes === 0` and moves to the next
 * candidate. That is the same guarantee `findOneAndUpdate` gives, arrived at
 * from the write rather than from the read — the candidate list is a hint, and
 * nothing is trusted from it.
 */

import type { MirrorQueueDoc } from '../../schema.ts';
import { sqliteDb, type SqliteDb } from './db-handle.ts';
import { toBool } from './values.ts';

export type { SqliteDb } from './db-handle.ts';

/** A queued copy as the worker sees it. See the module comment on `_id`. */
export interface MirrorQueueEntry extends MirrorQueueDoc {
  _id: number;
}

/**
 * Candidates fetched per claim. Enough that a burst of workers competing for
 * the head of the queue still make progress on the first call, small enough
 * that a lost race costs one more conditional write rather than a scan.
 */
const CLAIM_CANDIDATES = 8;

const ENQUEUE_SQL = `
  INSERT INTO mirror_queue
    (primary_path, mirror_path, reason, claimed_at, attempts, last_error, dead, enqueued_at)
  VALUES (?, ?, ?, NULL, 0, NULL, 0, ?)
  ON CONFLICT (mirror_path) DO UPDATE SET
    primary_path = excluded.primary_path,
    reason = excluded.reason`;

/** Free or lease-expired, not dead, oldest first — the Mongo `sort` verbatim. */
const CLAIM_CANDIDATES_SQL = `
  SELECT id FROM mirror_queue
   WHERE dead = 0 AND (claimed_at IS NULL OR claimed_at < ?)
   ORDER BY enqueued_at, id
   LIMIT ${CLAIM_CANDIDATES}`;

const CLAIM_SQL = `
  UPDATE mirror_queue SET claimed_at = ?
   WHERE id = ? AND dead = 0 AND (claimed_at IS NULL OR claimed_at < ?)`;

const SELECT_COLUMNS = `
  id, primary_path, mirror_path, reason, claimed_at, attempts, last_error, dead, enqueued_at`;

/**
 * Bump the attempt count and derive the dead flag from the new value, in one
 * statement.
 *
 * The Mongo version needs a two-stage aggregation pipeline to do this, because
 * `$set` sees the stored `attempts`, not the one the same update is writing.
 * SQL evaluates the whole `SET` list against the old row, so `attempts + 1`
 * appears on both sides and the flag is derived from the new count with no
 * second stage. Simpler, not different — the outcome is identical.
 */
const FAIL_SQL = `
  UPDATE mirror_queue
     SET attempts = attempts + 1,
         last_error = ?,
         claimed_at = NULL,
         dead = CASE WHEN attempts + 1 >= ? THEN 1 ELSE 0 END
   WHERE id = ?`;

interface MirrorQueueRow {
  id: number;
  primary_path: string;
  mirror_path: string;
  reason: MirrorQueueDoc['reason'];
  claimed_at: number | null;
  attempts: number;
  last_error: string | null;
  dead: number;
  enqueued_at: number;
}

function toEntry(row: MirrorQueueRow): MirrorQueueEntry {
  return {
    _id: row.id,
    primary_path: row.primary_path,
    mirror_path: row.mirror_path,
    reason: row.reason,
    claimed_at: row.claimed_at,
    attempts: row.attempts,
    last_error: row.last_error,
    dead: toBool(row.dead),
    enqueued_at: row.enqueued_at,
  };
}

/**
 * Enqueue (or refresh) a pending copy.
 *
 * Idempotent on `mirror_path`: a row that already exists keeps its
 * `enqueued_at`, `attempts` and `dead` state and has only its source path and
 * reason refreshed, so re-detection and repeated failures coalesce onto one row
 * instead of flooding the queue.
 *
 * The Mongo version wraps this in a try/catch that swallows duplicate-key
 * errors, because two writers racing the same `mirror_path` can both miss the
 * row and both attempt an insert. `ON CONFLICT DO UPDATE` resolves that race
 * inside the statement, so there is nothing left to swallow.
 */
export async function enqueueMirrorCopy(
  primaryPath: string,
  mirrorPath: string,
  reason: MirrorQueueDoc['reason'],
  dbOverride?: SqliteDb,
): Promise<void> {
  await sqliteDb(dbOverride).write(ENQUEUE_SQL, [primaryPath, mirrorPath, reason, Date.now()]);
}

/**
 * Atomically claim the oldest free (or lease-expired), non-dead row, or `null`
 * when there is nothing claimable.
 *
 * Losing every candidate to concurrent workers returns `null` rather than
 * retrying forever; the caller is a polling loop and the next pass sees a fresh
 * queue.
 */
export async function claimNextMirrorCopy(
  leaseMs: number,
  dbOverride?: SqliteDb,
): Promise<MirrorQueueEntry | null> {
  const db = sqliteDb(dbOverride);
  const now = Date.now();
  const candidates = await db.read<{ id: number }>(CLAIM_CANDIDATES_SQL, [now]);

  for (const candidate of candidates) {
    const result = await db.write(CLAIM_SQL, [now + leaseMs, candidate.id, now]);
    // A rival claimed this row between the candidate read and here.
    if (result.changes === 0) continue;
    const rows = await db.read<MirrorQueueRow>(
      `SELECT ${SELECT_COLUMNS} FROM mirror_queue WHERE id = ?`,
      [candidate.id],
    );
    const row = rows[0];
    return row === undefined ? null : toEntry(row);
  }
  return null;
}

/** Remove a finished row. */
export async function completeMirrorCopy(id: number, dbOverride?: SqliteDb): Promise<void> {
  await sqliteDb(dbOverride).write(`DELETE FROM mirror_queue WHERE id = ?`, [id]);
}

/**
 * Record a failed copy: bump `attempts`, store the error, release the claim,
 * and dead-letter once `attempts` reaches `maxAttempts`.
 */
export async function failMirrorCopy(
  id: number,
  errorMessage: string,
  maxAttempts: number,
  dbOverride?: SqliteDb,
): Promise<void> {
  await sqliteDb(dbOverride).write(FAIL_SQL, [errorMessage, maxAttempts, id]);
}

/**
 * Queue depth counts for status and diagnostics.
 *
 * One statement rather than the Mongo version's two `countDocuments` calls, so
 * the pair cannot be read across a concurrent dead-letter and disagree.
 */
export async function mirrorQueueCounts(
  dbOverride?: SqliteDb,
): Promise<{ pending: number; dead: number }> {
  const rows = await sqliteDb(dbOverride).read<{ pending: number; dead: number }>(
    `SELECT COUNT(*) FILTER (WHERE dead = 0) AS pending,
            COUNT(*) FILTER (WHERE dead = 1) AS dead
       FROM mirror_queue`,
  );
  return rows[0] ?? { pending: 0, dead: 0 };
}

/** Clear the dead flag and attempt count on every dead-lettered row — the
 * operator's "retry" button. Returns how many rows were revived. */
export async function retryDeadMirrorCopies(dbOverride?: SqliteDb): Promise<number> {
  const result = await sqliteDb(dbOverride).write(
    `UPDATE mirror_queue
        SET dead = 0, attempts = 0, last_error = NULL, claimed_at = NULL
      WHERE dead = 1`,
  );
  return result.changes;
}
