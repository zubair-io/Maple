/**
 * Jobs repository — the SQLite port of `job-runner/jobs.repo.ts` (#3787).
 *
 * The `jobs` collection is the one operational queue that never had a SQLite
 * twin written for it, although the schema has carried the table since the
 * initial migration (`db/sqlite/ddl/operations.ts`) and the Mongo-to-SQLite
 * importer has always populated it. This module is that twin: every function
 * the Mongo repo exports has an equivalent here with the same name, the same
 * parameters and the same return type, plus the optional trailing `dbOverride`
 * every module in this directory takes.
 *
 * ## Layout
 *
 *   - `jobs.sql.ts`   every statement, and the two predicates that must be
 *                     spelled identically in more than one of them
 *   - `jobs.rows.ts`  row shapes and row → document conversions
 *   - `jobs.repo.ts`  the verbs the routes, the runner and the handlers call
 *
 * ## The job row is the work queue
 *
 * Claim and lease live on the row, exactly as they did on the document, and
 * {@link claimJob} is the one place that needs care. A Mongo `findOneAndUpdate`
 * with a sort is a compare-and-swap only one caller can win; the SQLite pool has
 * no primitive that both writes and returns rows, so the same guarantee comes
 * from re-checking the claimable predicate in the `UPDATE`'s own `WHERE` and
 * reading the row count. This is the shape `imports.repo.ts` already uses.
 *
 * ## The active-batch fence has no index behind it any more
 *
 * `ensureBatchActiveLibraryIndex`, on MongoDB, created a
 * UNIQUE partial index over `batch_scopes` at first use, and "another settings
 * batch is active in this library" is that index rejecting a duplicate key. The
 * SQLite schema is frozen at the cutover and declares no such index, so the
 * fence moved into the statements themselves — see `jobs.sql.ts`. It is still
 * one statement, so it is still atomic; what changes is that a conflict arrives
 * as a row count of zero rather than as a driver error, which is why
 * {@link jobConflictMessage} no longer has to recognise one.
 */

import type { ObjectId } from 'mongodb';
import { isDeepStrictEqual } from 'node:util';
import type { JobKind, JobStatus, JobWithId } from '../../schema.ts';
import type { SqlValue } from '../protocol.ts';
import { newObjectIdHex } from '../object-id.ts';
import { sqliteDb, type SqliteDb } from './db-handle.ts';
import { toClaimedJob, toJobDoc, type ClaimedJob, type JobRow } from './jobs.rows.ts';
import {
  CLAIM_CANDIDATES_SQL,
  CLAIM_JOB_SQL,
  insertJobSql,
  JOB_BY_ID_SQL,
  listJobsSql,
  RESUME_BATCH_JOB_SQL,
  SAVE_LEDGER_ENTRY_SQL,
  SAVE_LEDGER_SQL,
} from './jobs.sql.ts';
import { toHex } from './values.ts';

export type { SqliteDb } from './db-handle.ts';
export type { ClaimedJob } from './jobs.rows.ts';

export interface CreateJobInput {
  kind: JobKind;
  payload: Record<string, unknown>;
  /** Optional caller-generated identity makes a lost creation response recoverable. */
  requestId?: string;
}

export interface ListJobsFilter {
  /** Match a single status (exact). Use `statuses` to match multiple. */
  status?: JobStatus;
  /** Match any of the given statuses. Takes precedence over `status` when both
   * are given. The pano concurrency guard uses it to block `queued` and
   * `running` in one query. */
  statuses?: JobStatus[];
  kind?: JobKind;
  limit?: number;
}

/** A caller reused an identity, or overlaps another active settings batch. */
export class JobConflictError extends Error {
  override name = 'JobConflictError';
}

/** What an operator is told when another settings batch holds the same library. */
const BATCH_ACTIVE_MESSAGE =
  'Another settings batch is active in this library. Wait for it or cancel it first.';

/**
 * The user-facing message for a conflict, or `undefined` when the error is
 * something else and must propagate.
 *
 * On Mongo this also had to recognise a duplicate-key error carrying the
 * `batch_scopes` key pattern, because the active-library fence was an index.
 * Here that fence is a `WHERE NOT EXISTS` whose failure {@link createJob} turns
 * into a {@link JobConflictError} itself, so there is one shape left to
 * recognise. The export stays because the routes branch on it.
 */
export function jobConflictMessage(error: unknown): string | undefined {
  return error instanceof JobConflictError ? error.message : undefined;
}

/** One job row, or `null`. */
async function readJobRow(db: SqliteDb, hex: string): Promise<JobRow | null> {
  const rows = await db.read<JobRow>(JOB_BY_ID_SQL, [hex]);
  return rows[0] ?? null;
}

/**
 * The two instants every lease-renewing write needs together, derived from one
 * reading of the clock.
 *
 * Stamping `updated_at` from one reading and `lease_expires_at` from another
 * would make the lease differ from `leaseMs` by however long the statement took
 * to build — drift that only ever shows up as a rare mid-run reclaim.
 */
function leaseStamps(leaseMs: number, now: () => Date): { nowIso: string; leaseIso: string } {
  const at = now();
  return { nowIso: at.toISOString(), leaseIso: new Date(at.getTime() + leaseMs).toISOString() };
}

/** The 15 bound values of a fresh job row, in column order. */
function insertParams(
  id: string,
  input: CreateJobInput,
  scopes: string[] | undefined,
  nowIso: string,
): SqlValue[] {
  return [
    id,
    input.kind,
    'queued',
    null,
    null,
    0,
    0,
    0,
    null,
    nowIso,
    nowIso,
    JSON.stringify(input.payload),
    null,
    null,
    scopes === undefined ? null : JSON.stringify(scopes),
  ];
}

/**
 * Insert a queued job and return it with all its defaults.
 *
 * `scopes` is the caller's already-resolved list of registered library roots the
 * job locks, supplied only for `batch_adjustment_sync`. The Mongo repo computed
 * it here by calling `batchScopes`; that stays out of this module, because
 * resolving a root touches the filesystem and the library cache and this layer
 * takes no dependency on either. `job-runner/jobs.repo.ts` keeps that call and
 * hands the result down.
 *
 * Two distinct conflicts share one row count of zero, and are told apart by
 * reading the row back rather than by the count:
 *
 *  - **The request id already exists.** `ON CONFLICT (id) DO NOTHING` leaves the
 *    stored job alone, and the read finds it. A replay of the *same* request is
 *    honest and returns that job; a different kind or payload under the same id
 *    is a caller error.
 *  - **Another settings batch holds one of these roots.** The fence blocked the
 *    insert, so no row with this id exists.
 */
export async function createJob(
  input: CreateJobInput,
  now: () => Date = () => new Date(),
  scopes?: string[],
  dbOverride?: SqliteDb,
): Promise<JobWithId> {
  const db = sqliteDb(dbOverride);
  const id = input.requestId ?? newObjectIdHex();
  const fenced = scopes !== undefined && scopes.length > 0;
  const params = insertParams(id, input, scopes, now().toISOString());
  await db.write(insertJobSql(fenced), fenced ? [...params, JSON.stringify(scopes)] : params);

  const row = await readJobRow(db, id);
  if (row === null) throw new JobConflictError(BATCH_ACTIVE_MESSAGE);
  const doc = toJobDoc(row);
  if (doc.kind !== input.kind || !isDeepStrictEqual(doc.payload, input.payload)) {
    throw new JobConflictError('The request id already belongs to a different job');
  }
  return doc;
}

/** Fetch a single job by id. Returns null if no match. */
export async function getJob(id: ObjectId, dbOverride?: SqliteDb): Promise<JobWithId | null> {
  const row = await readJobRow(sqliteDb(dbOverride), toHex(id));
  return row === null ? null : toJobDoc(row);
}

/** List jobs filtered by status and/or kind, newest first. Hard-capped at 200. */
export async function listJobs(
  filter: ListJobsFilter,
  dbOverride?: SqliteDb,
): Promise<JobWithId[]> {
  const statuses = filter.statuses?.length ? filter.statuses : filter.status ? [filter.status] : [];
  const limit = Math.max(1, Math.min(200, filter.limit ?? 50));
  const rows = await sqliteDb(dbOverride).read<JobRow>(
    listJobsSql(statuses.length, filter.kind !== undefined),
    [...statuses, ...(filter.kind === undefined ? [] : [filter.kind]), limit],
  );
  return rows.map(toJobDoc);
}

/**
 * Atomic claim: a `queued` job nobody holds, or a `running` one whose lease
 * expired because the previous worker died mid-run.
 *
 * The exclusivity comes from the `UPDATE`'s own `WHERE`, not from the read above
 * it — see `jobs.sql.ts`. A row count of one means this caller won; zero means a
 * sibling runner took it in between, and the next candidate is tried, which is
 * why the read asks for several rather than one.
 */
export async function claimJob(
  workerId: string,
  leaseMs: number,
  now: () => Date = () => new Date(),
  dbOverride?: SqliteDb,
): Promise<ClaimedJob | null> {
  const db = sqliteDb(dbOverride);
  const { nowIso, leaseIso } = leaseStamps(leaseMs, now);

  const candidates = await db.read<{ id: string }>(CLAIM_CANDIDATES_SQL, [nowIso]);
  for (const candidate of candidates) {
    const result = await db.write(CLAIM_JOB_SQL, [
      workerId,
      leaseIso,
      nowIso,
      candidate.id,
      nowIso,
    ]);
    if (result.changes === 0) continue;
    const row = await readJobRow(db, candidate.id);
    if (row !== null) return toClaimedJob(row);
  }
  return null;
}

/**
 * Patch progress counters on an in-flight claim, renewing the lease so a long
 * handler that is making progress does not get reaped.
 *
 * `workerId` makes the write a fenced one: it matches only while this worker
 * still holds a running claim, and a miss is the signal that the job was
 * reclaimed and this worker must stop. Without it the write is unfenced, which
 * is what the runner's own bookkeeping calls do.
 */
export async function updateProgress(
  id: ObjectId,
  progress: { current: number; total: number },
  leaseMs: number,
  now: () => Date = () => new Date(),
  workerId?: string,
  dbOverride?: SqliteDb,
): Promise<void> {
  const { nowIso, leaseIso } = leaseStamps(leaseMs, now);
  const fence = workerId === undefined ? '' : ` AND locked_by = ? AND status = 'running'`;
  const result = await sqliteDb(dbOverride).write(
    `UPDATE jobs SET progress_current = ?, progress_total = ?, lease_expires_at = ?, updated_at = ?
      WHERE id = ?${fence}`,
    [
      progress.current,
      progress.total,
      leaseIso,
      nowIso,
      toHex(id),
      ...(workerId === undefined ? [] : [workerId]),
    ],
  );
  if (workerId !== undefined && result.changes !== 1) {
    throw new Error('The job lease was claimed by another worker');
  }
}

/** Apply a terminal state under the same lease fence used for progress writes. */
async function finishJob(
  id: ObjectId,
  assignments: string,
  params: SqlValue[],
  now: () => Date,
  workerId: string | undefined,
  dbOverride: SqliteDb | undefined,
): Promise<void> {
  const fence = workerId === undefined ? '' : ` AND locked_by = ? AND status = 'running'`;
  await sqliteDb(dbOverride).write(
    `UPDATE jobs SET ${assignments}, locked_by = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE id = ?${fence}`,
    [...params, now().toISOString(), toHex(id), ...(workerId === undefined ? [] : [workerId])],
  );
}

/** Mark a job done with its result payload. Releases the lock. */
export async function completeJob(
  id: ObjectId,
  result: Record<string, unknown>,
  now: () => Date = () => new Date(),
  workerId?: string,
  dbOverride?: SqliteDb,
): Promise<void> {
  await finishJob(
    id,
    `status = 'done', result = json(?), error = NULL`,
    [JSON.stringify(result)],
    now,
    workerId,
    dbOverride,
  );
}

/** Mark a job failed with an error message. Releases the lock. */
export async function failJob(
  id: ObjectId,
  error: string,
  now: () => Date = () => new Date(),
  workerId?: string,
  dbOverride?: SqliteDb,
): Promise<void> {
  await finishJob(id, `status = 'failed', error = ?`, [error], now, workerId, dbOverride);
}

/** Mark a job cancelled, retaining any supplied partial result. Releases the lock. */
export async function markCancelled(
  id: ObjectId,
  result: Record<string, unknown> | null = null,
  now: () => Date = () => new Date(),
  workerId?: string,
  dbOverride?: SqliteDb,
): Promise<void> {
  await finishJob(
    id,
    `status = 'cancelled', result = json(?)`,
    [result === null ? 'null' : JSON.stringify(result)],
    now,
    workerId,
    dbOverride,
  );
}

/**
 * Flip the `cancel_requested` flag. The runner observes it between progress
 * steps and exits cleanly. Returns true if the job exists.
 */
export async function requestCancel(
  id: ObjectId,
  now: () => Date = () => new Date(),
  dbOverride?: SqliteDb,
): Promise<boolean> {
  const result = await sqliteDb(dbOverride).write(
    `UPDATE jobs SET cancel_requested = 1, updated_at = ? WHERE id = ?`,
    [now().toISOString(), toHex(id)],
  );
  return result.changes > 0;
}

/** Read just the cancel flag. Used by handlers between progress steps. */
export async function isCancelRequested(id: ObjectId, dbOverride?: SqliteDb): Promise<boolean> {
  const rows = await sqliteDb(dbOverride).read<{ cancel_requested: number }>(
    `SELECT cancel_requested FROM jobs WHERE id = ?`,
    [toHex(id)],
  );
  return rows[0]?.cancel_requested === 1;
}

/** A ledger field as JSON text, with an absent value written as JSON null. */
function ledgerField(checkpoint: Record<string, unknown>, key: string): string {
  return JSON.stringify(checkpoint[key] ?? null);
}

/**
 * Fence checkpoint writes to the lease owner so a reclaimed job cannot be
 * overwritten by the former worker. Renew before each sidecar commit.
 *
 * `entryIndex` narrows the write to one entry of `ledger.entries` plus the three
 * summary counters, which is what keeps a 2,000-photo batch from resending every
 * frozen patch twice per photo. The validation it carries is the Mongo version's
 * verbatim: an index has to be a real position in the caller's own array, or the
 * call is a programming error rather than a partial write.
 */
export async function saveJobCheckpoint(
  id: ObjectId,
  workerId: string,
  checkpoint: Record<string, unknown>,
  leaseMs: number,
  now: () => Date = () => new Date(),
  entryIndex?: number,
  dbOverride?: SqliteDb,
): Promise<void> {
  const { nowIso, leaseIso } = leaseStamps(leaseMs, now);
  const hex = toHex(id);
  const whole = JSON.stringify(checkpoint);
  const db = sqliteDb(dbOverride);

  const result =
    entryIndex === undefined
      ? await db.write(SAVE_LEDGER_SQL, [whole, nowIso, leaseIso, hex, workerId])
      : await db.write(SAVE_LEDGER_ENTRY_SQL, [
          entryIndex,
          entryIndex,
          JSON.stringify(entryAt(checkpoint, entryIndex)),
          ledgerField(checkpoint, 'applied'),
          ledgerField(checkpoint, 'failed'),
          ledgerField(checkpoint, 'remaining'),
          whole,
          nowIso,
          leaseIso,
          hex,
          workerId,
        ]);

  if (result.changes !== 1) throw new Error('The job lease was claimed by another worker');
}

/** The entry `entryIndex` names, or a throw when it names nothing. */
function entryAt(checkpoint: Record<string, unknown>, entryIndex: number): unknown {
  const entries = checkpoint['entries'];
  if (
    !Number.isSafeInteger(entryIndex) ||
    entryIndex < 0 ||
    !Array.isArray(entries) ||
    entryIndex >= entries.length
  ) {
    throw new Error('Invalid batch checkpoint entry');
  }
  return entries[entryIndex];
}

/**
 * Resume only the unfinished entries of an interrupted batch; the saved ledger
 * is retained.
 *
 * Returns false when the job is not a resumable batch, is not in a terminal
 * state, or would collide with a settings batch that is already active in one of
 * its libraries. The Mongo version reached that last answer by catching the
 * unique index's duplicate-key error; here the fence is in the statement and the
 * answer is simply a row count of zero.
 */
export async function resumeBatchJob(id: ObjectId, dbOverride?: SqliteDb): Promise<boolean> {
  const result = await sqliteDb(dbOverride).write(RESUME_BATCH_JOB_SQL, [
    new Date().toISOString(),
    toHex(id),
  ]);
  return result.changes === 1;
}
