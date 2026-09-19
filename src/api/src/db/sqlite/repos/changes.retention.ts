/**
 * Retention pruning for `asset_changes` (#3741, ported in #3787).
 *
 * The journal is the File Provider push channel and it has no natural bound —
 * on production MongoDB it reached 176 million rows and 83% of all index bytes.
 * The sweep that drains it is here rather than in the worker for the rule the
 * cutover exists to enforce: the worker decides *when* and *how much*, and every
 * statement lives beside the table it touches.
 *
 * ## Pruning is safe because the counter is not in the journal
 *
 * `asset_changes.cursor` is an `INTEGER PRIMARY KEY` — a rowid alias — and the
 * value is handed out by the `asset_changes_cursor` row of `server_state`. The
 * counter survives pruning by design, so a swept journal still knows how far
 * history went: `isChangeCursorTooOld` (`./changes.repo.ts`) compares a client's
 * saved cursor against the surviving floor and answers 409, which is what makes
 * the client re-enumerate rather than silently skip everything the sweep
 * removed. A sweep that reset the counter would turn that 409 into a 200 over an
 * empty stream.
 *
 * One consequence for tests: there is no `allocateCursor` to call. Allocation is
 * part of the insert — the counter bump and the row go in one `BEGIN IMMEDIATE`
 * batch and the insert's `lastInsertRowid` *is* the cursor — so a test makes
 * journal rows with `recordAssetChange` / `recordAssetChangeRow`. (What Mongo
 * called `currentAllocatedCursor` is `allocatedCursor` here, which is a
 * reader, not an allocator.)
 *
 * ## Why the cutoff is a binary search
 *
 * The sweep deletes by cursor, so it needs the highest cursor older than the
 * retention window. There is no index on `at`, and adding one to a table this
 * size to serve a once-a-day query would cost more than it saves. Cursors are
 * allocated in time order, so `at` is non-decreasing along the primary key and
 * the boundary is findable by bisection: about 28 primary-key seeks on a
 * 176-million-row journal, against a scan of the whole table.
 */

import { sqliteDb, type SqliteDb } from './db-handle.ts';

/** A journal row reduced to the two columns the retention sweep compares. */
interface ChangeBoundary {
  cursor: number;
  at: string;
}

const OLDEST_SQL = `SELECT cursor, at FROM asset_changes ORDER BY cursor LIMIT 1`;
const NEWEST_SQL = `SELECT cursor, at FROM asset_changes ORDER BY cursor DESC LIMIT 1`;

/**
 * The first row at or after `cursor`.
 *
 * The bisection's probe. `cursor >= ?` on a rowid alias is a seek to the
 * b-tree position and `LIMIT 1` stops there, so a probe costs one page read
 * whether the gap above `cursor` is one row or a million — and after a previous
 * sweep the gaps are large.
 */
const FROM_CURSOR_SQL = `
  SELECT cursor, at FROM asset_changes WHERE cursor >= ? ORDER BY cursor LIMIT 1`;

const COUNT_SQL = `SELECT COUNT(*) AS n FROM asset_changes`;

/**
 * One bounded batch, oldest first. Deleting by a `(min, max)` range rather than
 * by an id list keeps the statement text constant across batches, so the
 * worker's prepared-statement cache holds one copy of it.
 */
const BATCH_BOUNDS_SQL = `
  SELECT MIN(cursor) AS low, MAX(cursor) AS high
    FROM (SELECT cursor FROM asset_changes WHERE cursor <= ? ORDER BY cursor LIMIT ?)`;

const DELETE_RANGE_SQL = `DELETE FROM asset_changes WHERE cursor >= ? AND cursor <= ?`;

async function boundary(
  db: SqliteDb,
  sql: string,
  params?: readonly number[],
): Promise<ChangeBoundary | null> {
  const rows = await db.read<ChangeBoundary>(sql, params === undefined ? undefined : [...params]);
  return rows[0] ?? null;
}

/**
 * The highest cursor whose row is older than `cutoff`, or `null` when nothing
 * has aged out yet.
 *
 * Bisection over the primary key, as the module note explains. The two
 * endpoints are read first because they answer the common cases outright: an
 * empty journal, a journal entirely inside the window, and a journal entirely
 * outside it.
 */
export async function findRetentionCutoffCursor(
  cutoff: Date,
  dbOverride?: SqliteDb,
): Promise<number | null> {
  const db = sqliteDb(dbOverride);
  const cutoffIso = cutoff.toISOString();
  const oldest = await boundary(db, OLDEST_SQL);
  if (oldest === null || oldest.at >= cutoffIso) return null;
  const newest = await boundary(db, NEWEST_SQL);
  if (newest === null) return null;
  if (newest.at < cutoffIso) return newest.cursor;

  let low = oldest.cursor;
  let high = newest.cursor;
  let best = oldest.cursor;
  while (low <= high) {
    const mid = Math.floor(low + (high - low) / 2);
    const probe = await boundary(db, FROM_CURSOR_SQL, [mid]);
    if (probe === null || probe.cursor > high) {
      high = mid - 1;
      continue;
    }
    if (probe.at < cutoffIso) {
      best = Math.max(best, probe.cursor);
      low = probe.cursor + 1;
    } else {
      high = probe.cursor - 1;
    }
  }
  return best;
}

/** What one delete batch removed, and how far up the journal it reached. */
export interface PrunedBatch {
  deleted: number;
  /** Highest cursor this batch removed, or 0 when it removed nothing. */
  prunedThrough: number;
}

/**
 * Delete up to `batchSize` rows at or below `cutoffCursor`, oldest first.
 *
 * Bounded, and the bound is the point: the sweep yields to the event loop
 * between batches so HTTP traffic is never starved, and the single SQLite
 * writer is never held for more than one batch. A whole-sweep transaction would
 * lock out the API process's writer for the length of the backlog drain.
 */
export async function pruneChangesBatch(
  cutoffCursor: number,
  batchSize: number,
  dbOverride?: SqliteDb,
): Promise<PrunedBatch> {
  const db = sqliteDb(dbOverride);
  const bounds = await db.read<{ low: number | null; high: number | null }>(BATCH_BOUNDS_SQL, [
    cutoffCursor,
    batchSize,
  ]);
  const low = bounds[0]?.low ?? null;
  const high = bounds[0]?.high ?? null;
  if (low === null || high === null) return { deleted: 0, prunedThrough: 0 };
  const result = await db.write(DELETE_RANGE_SQL, [low, high]);
  return { deleted: result.changes, prunedThrough: result.changes > 0 ? high : 0 };
}

/**
 * How many rows the journal still holds.
 *
 * An exact count, where the Mongo sweep reported `estimatedDocumentCount()`.
 * The two differ in cost for the reason the whole migration exists: the
 * estimate was cheap because the exact count was a five-second collection scan,
 * and here `COUNT(*)` over a rowid table is a b-tree walk that the sweep runs
 * once per pass.
 */
export async function countChanges(dbOverride?: SqliteDb): Promise<number> {
  const rows = await sqliteDb(dbOverride).read<{ n: number }>(COUNT_SQL);
  return rows[0]?.n ?? 0;
}
