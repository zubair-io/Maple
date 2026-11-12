/**
 * Every statement the ported jobs repository runs, in one place.
 *
 * Separated from the functions that call it for the reason `assets.sql.ts` and
 * `imports.sql.ts` give: the shape of these queries *is* the
 * correctness argument, and a reviewer should be able to read them together.
 *
 * **The active-batch fence is a `NOT EXISTS`, not an index.** On Mongo, "only
 * one settings batch may be active per library" is a UNIQUE partial index over
 * the multikey `batch_scopes` array, created lazily at first use
 * (a lazily-created MongoDB index, now deleted). The SQLite schema declares no such
 * index and is frozen for the cutover, so the fence moves into the statements:
 * {@link insertJobSql} inserts through a `WHERE NOT EXISTS` over the scopes of
 * every *active* batch, and {@link RESUME_BATCH_JOB_SQL} repeats it. Both are
 * single statements, so the check and the write cannot be separated by another
 * writer — which is the property the unique index was there to provide. A row
 * count of zero is the conflict, exactly as a duplicate-key error was.
 *
 * **A scope comparison is set intersection over two JSON arrays.** Mongo's
 * multikey index makes two active batches conflict when they share *any*
 * element; `os.value IN (SELECT value FROM json_each(?))` says the same thing.
 * `json_each` over a NULL column yields no rows rather than failing, so a job
 * with no scopes neither fences anything nor is fenced.
 */

import type { OperationKind } from '../schema.ts';
import { placeholders } from './values.ts';

/** Every `jobs` column, in declaration order. */
const JOB_COLUMNS = `
  id, kind, status, locked_by, lease_expires_at, cancel_requested,
  progress_current, progress_total, error, created_at, updated_at,
  params, result, ledger, batch_scopes`;

export const JOB_BY_ID_SQL = `SELECT ${JOB_COLUMNS} FROM jobs WHERE id = ?`;

/**
 * Scopes already locked by an active settings batch, as a correlated
 * `NOT EXISTS`. Binds the candidate's own scope array as its single parameter.
 */
const NO_ACTIVE_BATCH_OVERLAP = `
  NOT EXISTS (
    SELECT 1 FROM jobs o, json_each(o.batch_scopes) os
     WHERE o.kind = 'batch_adjustment_sync'
       AND o.status IN ('queued', 'running')
       AND os.value IN (SELECT value FROM json_each(json(?))))`;

/**
 * Any queued or running panorama stitch. A stitch holds the whole decode
 * memory budget for minutes, so one may be active at a time, and a preview is
 * not admitted beside it either.
 */
const NO_ACTIVE_PANO_STITCH = `
  NOT EXISTS (
    SELECT 1 FROM jobs o
     WHERE o.kind = 'pano_stitch'
       AND o.status IN ('queued', 'running'))`;

/**
 * The operator one-shots, which run on their own lane. A user job and an
 * operation never wait on each other, and no row is ever relayed by both lanes.
 */
const OPERATION_KIND_SET = {
  mirror_reconcile: true,
  people_cluster: true,
  folder_scan: true,
} as const satisfies Record<OperationKind, true>;

export const OPERATION_KINDS = Object.keys(OPERATION_KIND_SET) as readonly OperationKind[];

const OPERATION_KIND_LIST = OPERATION_KINDS.map((kind) => `'${kind}'`).join(', ');
const IS_OPERATION = `kind IN (${OPERATION_KIND_LIST})`;
const IS_USER_JOB = `kind NOT IN (${OPERATION_KIND_LIST})`;

/**
 * An active operation of the same kind on the same folder (none, for the kinds
 * that are not per folder). Binds the kind and the folder id, or null.
 */
const NO_ACTIVE_OPERATION = `
  NOT EXISTS (
    SELECT 1 FROM jobs o
     WHERE o.kind = ?
       AND o.status IN ('queued', 'running')
       AND json_extract(o.params, '$.folderId') IS ?)`;

/** Which admission rule an insert is checked against, in the same statement. */
export type JobInsertFence = 'none' | 'batch_scopes' | 'pano_stitch' | 'operation';

const FENCE_PREDICATES: Record<JobInsertFence, string> = {
  none: '1 = 1',
  batch_scopes: NO_ACTIVE_BATCH_OVERLAP,
  pano_stitch: NO_ACTIVE_PANO_STITCH,
  operation: NO_ACTIVE_OPERATION,
};

/**
 * Insert one queued job.
 *
 * `INSERT … SELECT … WHERE` rather than `INSERT … VALUES`, because the fence
 * above has to be part of the same statement. `ON CONFLICT (id) DO NOTHING`
 * reproduces `$setOnInsert`: a caller replaying a request id that already
 * exists leaves the stored job exactly as it is, and the repository reads the
 * row back to decide whether the replay was honest.
 *
 * Both a blocked fence and a re-used id report zero rows changed, which is why
 * the repository distinguishes them by reading rather than by the count.
 */
export function insertJobSql(fence: JobInsertFence): string {
  return `
    INSERT INTO jobs (${JOB_COLUMNS})
    SELECT ${placeholders(15)}
     WHERE ${FENCE_PREDICATES[fence]}
    ON CONFLICT (id) DO NOTHING`;
}

/**
 * The jobs list, newest first, optionally narrowed by status and/or kind.
 *
 * The statement text varies with which filters are present rather than carrying
 * `(? IS NULL OR …)` residuals: the residual form defeats the `jobs_list` index,
 * because the planner cannot know at prepare time whether a filter is bound.
 * There are at most a handful of shapes, all well inside the worker's
 * prepared-statement cache.
 */
export function listJobsSql(statusCount: number, byKind: boolean, excludeCount: number): string {
  const clauses = [
    ...(statusCount > 0 ? [`status IN (${placeholders(statusCount)})`] : []),
    ...(byKind ? ['kind = ?'] : []),
    ...(excludeCount > 0 ? [`kind NOT IN (${placeholders(excludeCount)})`] : []),
  ];
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  return `SELECT ${JOB_COLUMNS} FROM jobs ${where} ORDER BY created_at DESC, id DESC LIMIT ?`;
}

/** What the relay writes into `locked_by` once Temporal holds a queued job. */
export const DISPATCHED_MARKER = 'temporal';

/**
 * A job Temporal holds: running, or queued with its workflow already started.
 * At most one user job is held at a time, because {@link NEXT_JOB_SQL} waits for it.
 */
const HELD = `(status = 'running' OR (status = 'queued' AND locked_by IS NOT NULL))`;

/**
 * The oldest queued user job, but only once no other user job is held.
 *
 * Handing Temporal one job at a time is what keeps jobs in the order they were
 * created: several workflows waiting on one task queue are started in no
 * particular order. `locked_by IS NULL` separates a fresh or resumed job from a
 * held one; every statement that puts a job back into `queued` clears it.
 * Operations are left to their own lane and never hold a user job back.
 */
export const NEXT_JOB_SQL = `
  SELECT id FROM jobs
   WHERE status = 'queued' AND locked_by IS NULL AND ${IS_USER_JOB}
     AND NOT EXISTS (SELECT 1 FROM jobs WHERE ${IS_USER_JOB} AND ${HELD})
   ORDER BY created_at, id LIMIT 1`;

export const HELD_JOBS_SQL = `
  SELECT id FROM jobs WHERE ${IS_USER_JOB} AND ${HELD} ORDER BY created_at, id`;

/**
 * The oldest queued operation not yet handed to Temporal. Operations run side
 * by side: the insert fence already keeps two of a kind (or two scans of one
 * folder) from being active together, so nothing here has to wait.
 */
export const NEXT_OPERATION_SQL = `
  SELECT id FROM jobs
   WHERE status = 'queued' AND locked_by IS NULL AND ${IS_OPERATION}
   ORDER BY created_at, id LIMIT 1`;

export const HELD_OPERATIONS_SQL = `
  SELECT id FROM jobs WHERE ${IS_OPERATION} AND ${HELD} ORDER BY created_at, id`;

/** The active operation the insert fence measured a new one against. */
export const ACTIVE_OPERATION_SQL = `
  SELECT id FROM jobs
   WHERE kind = ? AND status IN ('queued', 'running')
     AND json_extract(params, '$.folderId') IS ?
   ORDER BY created_at DESC LIMIT 1`;

/** Guarded so a job its activity has already claimed keeps that claim. */
export const MARK_DISPATCHED_SQL = `
  UPDATE jobs SET locked_by = ? WHERE id = ? AND status = 'queued' AND locked_by IS NULL`;

/**
 * Hand one job to the activity attempt Temporal just delivered.
 *
 * A `running` row is taken over, not skipped: Temporal only delivers another
 * attempt after the previous one missed its heartbeat deadline, so the holder
 * named in `locked_by` is gone. Whatever that holder still tries to write is
 * refused by the `locked_by` fence on the progress, ledger and finish writes.
 * A finished job matches nothing, which is how a redelivery becomes a no-op.
 */
export const CLAIM_JOB_SQL = `
  UPDATE jobs
     SET status = 'running', locked_by = ?, lease_expires_at = ?, updated_at = ?
   WHERE id = ? AND status IN ('queued', 'running')`;

/**
 * Re-queue a terminal batch job so a worker re-claims it.
 *
 * The kind and status guards are the Mongo filter verbatim. The third guard is
 * the active-batch fence: putting this job back into `queued` makes it active,
 * so it must not overlap a batch that already is. `o.id <> jobs.id` keeps the
 * job from fencing itself out — it is `failed` or `cancelled` at this point and
 * therefore not active, but the exclusion states the intent rather than relying
 * on that.
 */
export const RESUME_BATCH_JOB_SQL = `
  UPDATE jobs
     SET status = 'queued', locked_by = NULL, lease_expires_at = NULL,
         cancel_requested = 0, error = NULL, result = NULL, updated_at = ?
   WHERE id = ?
     AND kind IN ('batch_adjustment_sync', 'batch_recipe_export', 'batch_jpeg_export')
     AND status IN ('failed', 'cancelled')
     AND NOT EXISTS (
       SELECT 1 FROM jobs o, json_each(o.batch_scopes) os
        WHERE o.id <> jobs.id
          AND o.kind = 'batch_adjustment_sync'
          AND o.status IN ('queued', 'running')
          AND os.value IN (SELECT value FROM json_each(jobs.batch_scopes)))`;

/**
 * Save a whole recovery ledger and renew the lease, fenced to the lease holder.
 *
 * The fence is the `locked_by`/`status` pair in the `WHERE`: a job reclaimed by
 * another worker matches nothing, the row count is zero, and the repository
 * turns that into the throw the former worker needs to stop writing.
 */
export const SAVE_LEDGER_SQL = `
  UPDATE jobs SET ledger = json(?), updated_at = ?, lease_expires_at = ?
   WHERE id = ? AND locked_by = ? AND status = 'running'`;

/**
 * Save one entry of a ledger plus its three summary counters, leaving the other
 * entries in the stored array untouched.
 *
 * This is the SQLite form of the dotted `checkpoint.entries.N` `$set`, and it
 * exists for the same reason: a batch of 2,000 photos must not resend every
 * frozen patch twice per photo. `json_set` replaces an existing array element
 * in place, but silently does nothing past the end of the array, so the `CASE`
 * falls back to writing the caller's whole ledger whenever the stored array is
 * too short — including the first save, when there is no stored ledger at all
 * and `json_array_length` is NULL. Either branch leaves the same value at the
 * same path; only the number of bytes written differs.
 */
export const SAVE_LEDGER_ENTRY_SQL = `
  UPDATE jobs
     SET ledger = CASE
           WHEN json_array_length(json_extract(ledger, '$.entries')) > ?
             THEN json_set(ledger,
                    '$.entries[' || ? || ']', json(?),
                    '$.applied',   json(?),
                    '$.failed',    json(?),
                    '$.remaining', json(?))
           ELSE json(?)
         END,
         updated_at = ?, lease_expires_at = ?
   WHERE id = ? AND locked_by = ? AND status = 'running'`;
