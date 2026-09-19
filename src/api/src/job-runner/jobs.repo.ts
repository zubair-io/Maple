/**
 * Accessor for the `jobs` table. Mirrors the geocode worker's claim-and-lease
 * shape (`docs/indexer-enrichment.md` §3.1) but at job granularity rather than
 * per-stage state.
 *
 * Every operation now lives in `db/sqlite/repos/jobs.repo.ts` (#3787), and this
 * module is the seam the runner, the HTTP routes and the handlers keep
 * importing. Two things stay here rather than moving down:
 *
 *  - **Resolving a settings batch's scopes.** `batchScopes` walks the registered
 *    library roots on disk and authorises every target path, so it depends on
 *    the filesystem and the library cache. The repository layer takes no
 *    dependency on either, so the scopes are resolved here and handed down as
 *    data — which is also what makes them testable without a filesystem.
 *  - **The kind check that decides whether to resolve them at all.** Only
 *    `batch_adjustment_sync` holds a library exclusively.
 *
 * `ensureBatchActiveLibraryIndex` is gone with the module that held it. It
 * created, lazily and fail-closed, the UNIQUE partial index that made "only one
 * settings batch per library" true on MongoDB; the SQLite fence is part of the
 * insert statement itself and cannot be absent, and the only caller of the
 * lazy creator was the MongoDB client this change deletes.
 */

import { batchScopes } from './batch-scope.ts';
import type { JobWithId } from '../db/schema.ts';
import { createJob as createJobRow, type CreateJobInput } from '../db/sqlite/repos/jobs.repo.ts';

export {
  claimJob,
  completeJob,
  failJob,
  getJob,
  isCancelRequested,
  JobConflictError,
  jobConflictMessage,
  listJobs,
  markCancelled,
  requestCancel,
  resumeBatchJob,
  saveJobCheckpoint,
  updateProgress,
} from '../db/sqlite/repos/jobs.repo.ts';
export type { CreateJobInput } from '../db/sqlite/repos/jobs.repo.ts';

/**
 * Insert a queued job. Returns the new row with all defaults.
 *
 * A settings batch carries the registered library roots it locks, resolved
 * before the insert so the fence that refuses an overlapping batch is evaluated
 * in the same statement that writes the row.
 */
export async function createJob(
  input: CreateJobInput,
  now: () => Date = () => new Date(),
): Promise<JobWithId> {
  const scopes =
    input.kind === 'batch_adjustment_sync' ? await batchScopes(input.payload) : undefined;
  return createJobRow(input, now, scopes);
}
