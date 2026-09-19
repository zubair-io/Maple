/**
 * The three `meilisearch_backfill_*` tables: the vector backfill's resume
 * point, its single-runner lease, and the rows it could not index (#3787).
 *
 * One module for three tables because they are one mechanism — a run takes the
 * lease, advances the state, parks what it cannot write, and the redrive pass
 * reads the parked rows back under the same lease. Splitting them would put
 * three files in front of one workflow.
 *
 * ## The state row's counters are incremented, not rewritten
 *
 * `$inc` on Mongo; `scanned = scanned + ?` here. That is why the columns carry
 * `NOT NULL DEFAULT 0` rather than living in a JSON blob: an increment against a
 * missing key has to mean zero, and a read-modify-write in TypeScript would lose
 * a concurrent batch's progress. There is only one runner at a time, so the
 * window is narrow — but the statement costs nothing to get right.
 *
 * ## The lease is one statement, and its `WHERE` is the whole mechanism
 *
 * `findOneAndUpdate` with an upsert and an `$or` on Mongo, which needed a
 * duplicate-key catch alongside it because two racing upserts can both miss the
 * document and one then loses the insert. SQLite's upsert has a `WHERE` on its
 * conflict branch, so the same claim is a single atomic statement: insert if
 * nobody holds the row, take it over only if the existing lease has expired or
 * is already ours. `changes === 0` is the busy answer, and it has no second
 * failure mode to catch.
 *
 * Expiry is epoch milliseconds rather than the ISO text the rest of the schema
 * uses, matching the other leases in this database — a lease is arithmetic on a
 * clock, not a timestamp anyone reads.
 */

import { sqliteDb, type SqliteDb } from './db-handle.ts';
import { placeholders } from './values.ts';

export type { SqliteDb } from './db-handle.ts';

/** Both tables hold exactly one row for the asset index. */
const ROW_ID = 'assets';

// ── State ────────────────────────────────────────────────────────────────

/** The stored resume point, column for column. */
export interface BackfillStateRow {
  cursor: string | null;
  scanned: number;
  upserted: number;
  tombstoned: number;
  skipped: number;
  errors: number;
  remaining: number | null;
  retry_attempts: number;
  retry_error: string | null;
  blocked_at: string | null;
  started_at: string;
  updated_at: string;
  completed_at: string | null;
  doc_shape_version: number | null;
}

/** What a fresh generation is created with. */
export interface NewBackfillState {
  remaining: number;
  startedAt: string;
  docShapeVersion: number;
}

/** What one committed batch adds to the stored totals. */
export interface BackfillProgress {
  cursor: string | null;
  updatedAt: string;
  complete: boolean;
  remaining: number;
  scanned: number;
  upserted: number;
  tombstoned: number;
  skipped: number;
  errors: number;
}

const STATE_COLUMNS = `
  cursor, scanned, upserted, tombstoned, skipped, errors, remaining,
  retry_attempts, retry_error, blocked_at,
  started_at, updated_at, completed_at, doc_shape_version`;

/** The resume point, or `null` before the first run of a generation. */
export async function readBackfillState(dbOverride?: SqliteDb): Promise<BackfillStateRow | null> {
  const rows = await sqliteDb(dbOverride).read<BackfillStateRow>(
    `SELECT ${STATE_COLUMNS} FROM meilisearch_backfill_state WHERE id = ?`,
    [ROW_ID],
  );
  return rows[0] ?? null;
}

/** Start a generation. Replaces whatever was there, so a reset needs no delete. */
export async function insertBackfillState(
  state: NewBackfillState,
  dbOverride?: SqliteDb,
): Promise<void> {
  await sqliteDb(dbOverride).write(
    `INSERT INTO meilisearch_backfill_state
       (id, remaining, started_at, updated_at, doc_shape_version)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       cursor = NULL, scanned = 0, upserted = 0, tombstoned = 0, skipped = 0, errors = 0,
       remaining = excluded.remaining,
       retry_attempts = 0, retry_error = NULL, blocked_at = NULL,
       started_at = excluded.started_at, updated_at = excluded.updated_at,
       completed_at = NULL, doc_shape_version = excluded.doc_shape_version`,
    [ROW_ID, state.remaining, state.startedAt, state.startedAt, state.docShapeVersion],
  );
}

/** Drop the generation entirely — an operator reset, or a superseded doc shape. */
export async function deleteBackfillState(dbOverride?: SqliteDb): Promise<void> {
  await sqliteDb(dbOverride).write(`DELETE FROM meilisearch_backfill_state WHERE id = ?`, [ROW_ID]);
}

/** Backfill the `remaining` counter on a state row written before it existed. */
export async function setBackfillRemaining(
  remaining: number,
  dbOverride?: SqliteDb,
): Promise<void> {
  await sqliteDb(dbOverride).write(
    `UPDATE meilisearch_backfill_state SET remaining = ? WHERE id = ?`,
    [remaining, ROW_ID],
  );
}

/**
 * Advance the cursor and add one batch's totals, clearing the retry circuit.
 *
 * The retry fields are reset here rather than in a separate statement because a
 * batch that lands is proof the transport recovered — leaving a stale
 * `blocked_at` behind would keep the migration surface reporting a fault that
 * has already cleared.
 */
export async function advanceBackfillState(
  progress: BackfillProgress,
  dbOverride?: SqliteDb,
): Promise<void> {
  await sqliteDb(dbOverride).write(
    `UPDATE meilisearch_backfill_state
        SET cursor = ?, updated_at = ?, completed_at = ?, remaining = ?,
            retry_attempts = 0, retry_error = NULL, blocked_at = NULL,
            scanned = scanned + ?, upserted = upserted + ?, tombstoned = tombstoned + ?,
            skipped = skipped + ?, errors = errors + ?
      WHERE id = ?`,
    [
      progress.cursor,
      progress.updatedAt,
      progress.complete ? progress.updatedAt : null,
      progress.remaining,
      progress.scanned,
      progress.upserted,
      progress.tombstoned,
      progress.skipped,
      progress.errors,
      ROW_ID,
    ],
  );
}

/** Record a failed write attempt against the bounded retry budget. */
export async function recordBackfillRetry(
  input: { attempts: number; error: string; blockedAt: string | null; updatedAt: string },
  dbOverride?: SqliteDb,
): Promise<void> {
  await sqliteDb(dbOverride).write(
    `UPDATE meilisearch_backfill_state
        SET retry_attempts = ?, retry_error = ?, blocked_at = ?, updated_at = ?
      WHERE id = ?`,
    [input.attempts, input.error, input.blockedAt, input.updatedAt, ROW_ID],
  );
}

/** Clear only the retry circuit; the cursor and progress totals are preserved. */
export async function clearBackfillRetry(updatedAt: string, dbOverride?: SqliteDb): Promise<void> {
  await sqliteDb(dbOverride).write(
    `UPDATE meilisearch_backfill_state
        SET retry_attempts = 0, retry_error = NULL, blocked_at = NULL, updated_at = ?
      WHERE id = ?`,
    [updatedAt, ROW_ID],
  );
}

// ── Lease ────────────────────────────────────────────────────────────────

/**
 * Take the runner lease, or report that somebody else holds a live one.
 *
 * Re-entrant for the same owner, which is what lets a heartbeat and a renewed
 * claim from the same call use one statement.
 */
export async function acquireBackfillLease(
  owner: string,
  expiresAtMs: number,
  nowMs: number,
  dbOverride?: SqliteDb,
): Promise<boolean> {
  const result = await sqliteDb(dbOverride).write(
    `INSERT INTO meilisearch_backfill_leases (id, owner, expires_at) VALUES (?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at
      WHERE meilisearch_backfill_leases.expires_at <= ?
         OR meilisearch_backfill_leases.owner = excluded.owner`,
    [ROW_ID, owner, expiresAtMs, nowMs],
  );
  return result.changes > 0;
}

/** Push the expiry out while the holder is still working. */
export async function renewBackfillLease(
  owner: string,
  expiresAtMs: number,
  dbOverride?: SqliteDb,
): Promise<void> {
  await sqliteDb(dbOverride).write(
    `UPDATE meilisearch_backfill_leases SET expires_at = ? WHERE id = ? AND owner = ?`,
    [expiresAtMs, ROW_ID, owner],
  );
}

/** Give the lease up. Scoped to the owner so a late release cannot free someone else's. */
export async function releaseBackfillLease(owner: string, dbOverride?: SqliteDb): Promise<void> {
  await sqliteDb(dbOverride).write(
    `DELETE FROM meilisearch_backfill_leases WHERE id = ? AND owner = ?`,
    [ROW_ID, owner],
  );
}

// ── Failures ─────────────────────────────────────────────────────────────

/** One parked row of the redrive work list. */
export interface BackfillFailureRow {
  asset_id: string;
  maple_id: string;
  error: string;
  attempts: number;
  updated_at: string;
}

/**
 * Park a row that could not be composed or written, keyed on its asset id so a
 * repeat failure increments `attempts` on the same row instead of piling up
 * duplicates — the redrive pass tells a first-time failure from a repeat that
 * way.
 */
export async function recordBackfillFailure(
  input: { assetId: string; mapleId: string; error: string; updatedAt: string },
  dbOverride?: SqliteDb,
): Promise<void> {
  await sqliteDb(dbOverride).write(
    `INSERT INTO meilisearch_backfill_failures (asset_id, maple_id, error, attempts, updated_at)
     VALUES (?, ?, ?, 1, ?)
     ON CONFLICT (asset_id) DO UPDATE SET
       maple_id = excluded.maple_id,
       error = excluded.error,
       attempts = meilisearch_backfill_failures.attempts + 1,
       updated_at = excluded.updated_at`,
    [input.assetId, input.mapleId, input.error, input.updatedAt],
  );
}

/** The redrivable backlog, for the Workers panel. */
export async function countBackfillFailures(dbOverride?: SqliteDb): Promise<number> {
  const rows = await sqliteDb(dbOverride).read<{ n: number }>(
    `SELECT COUNT(*) AS n FROM meilisearch_backfill_failures`,
  );
  return rows[0]?.n ?? 0;
}

/**
 * The oldest parked rows first, which is what makes the redrive loop terminate:
 * a row that fails again is rewritten with a fresh `updated_at` and goes to the
 * back of the queue.
 */
export async function listOldestBackfillFailures(
  limit: number,
  dbOverride?: SqliteDb,
): Promise<BackfillFailureRow[]> {
  return sqliteDb(dbOverride).read<BackfillFailureRow>(
    `SELECT asset_id, maple_id, error, attempts, updated_at
       FROM meilisearch_backfill_failures
      ORDER BY updated_at
      LIMIT ?`,
    [limit],
  );
}

/** Clear the rows a redrive pass resolved. */
export async function deleteBackfillFailures(
  assetIds: readonly string[],
  dbOverride?: SqliteDb,
): Promise<void> {
  if (assetIds.length === 0) return;
  await sqliteDb(dbOverride).write(
    `DELETE FROM meilisearch_backfill_failures
      WHERE asset_id IN (${placeholders(assetIds.length)})`,
    [...assetIds],
  );
}
