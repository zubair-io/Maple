/**
 * Every statement the ported jobs repository runs, in one place.
 *
 * Separated from the functions that call it for the reason `assets.sql.ts` and
 * `imports.sql.ts` give: the shape of three of these queries *is* the
 * correctness argument, and a reviewer should be able to read them together.
 *
 * **The claimable predicate is written once.** {@link CLAIMABLE_PREDICATE}
 * appears in the candidate query and again in the compare-and-swap that decides
 * the winner. If those drifted, a worker could claim a job the candidate query
 * never considered claimable — the failure Mongo's `findOneAndUpdate` made
 * impossible by construction.
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
export function insertJobSql(fenced: boolean): string {
  return `
    INSERT INTO jobs (${JOB_COLUMNS})
    SELECT ${placeholders(15)}
     WHERE ${fenced ? NO_ACTIVE_BATCH_OVERLAP : '1 = 1'}
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
export function listJobsSql(statusCount: number, byKind: boolean): string {
  const clauses = [
    ...(statusCount > 0 ? [`status IN (${placeholders(statusCount)})`] : []),
    ...(byKind ? ['kind = ?'] : []),
  ];
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  return `SELECT ${JOB_COLUMNS} FROM jobs ${where} ORDER BY created_at DESC, id DESC LIMIT ?`;
}

/**
 * Free or lease-expired: a `queued` job nobody holds, or a `running` one whose
 * holder's lease ran out mid-run.
 *
 * `lease_expires_at < ?` never matches a NULL lease, in SQLite as in MongoDB,
 * so a running job that somehow lost its expiry is not silently stolen.
 */
const CLAIMABLE_PREDICATE = `
  (status = 'queued' AND locked_by IS NULL)
  OR (status = 'running' AND lease_expires_at < ?)`;

/**
 * Oldest claimable jobs first — the order `findOneAndUpdate`'s
 * `sort: { created_at: 1, _id: 1 }` imposed.
 *
 * Several rather than one: the compare-and-swap below can lose to a sibling
 * runner, and re-reading after every loss would cost a round trip per
 * contended claim.
 */
export const CLAIM_CANDIDATES_SQL = `
  SELECT id FROM jobs WHERE ${CLAIMABLE_PREDICATE} ORDER BY created_at, id LIMIT 8`;

/**
 * Take one candidate, repeating the claimable predicate in the `WHERE`.
 *
 * That repetition is the whole mechanism: the row may have been claimed between
 * the candidate read and this write, and re-testing the predicate inside the
 * `UPDATE` is what makes exactly one caller see a row count of one.
 */
export const CLAIM_JOB_SQL = `
  UPDATE jobs
     SET status = 'running', locked_by = ?, lease_expires_at = ?, updated_at = ?
   WHERE id = ? AND (${CLAIMABLE_PREDICATE})`;

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
