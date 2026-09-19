/**
 * The rows the `jobs` queries return, and the conversion from a row to the
 * document shape the routes, the runner and the handlers already consume.
 *
 * Three column-level disagreements between the document and the table, all
 * resolved here rather than in the repository:
 *
 *  - **The progress subdocument is two columns.** `progress.{current,total}`
 *    was a nested object; it is two plain INTEGER columns, because the runner
 *    writes them on every progress tick and a JSON blob would have to be read,
 *    parsed and rewritten to move one number. {@link toJobDoc} folds them back
 *    into the object the DTO declares.
 *  - **Two fields are named for what they hold rather than for what they were
 *    called.** `payload` is stored as `params` and `checkpoint` as `ledger`,
 *    matching the schema and the Mongo-to-SQLite importer's own mapping
 *    (`db/sqlite/import/plan/operations.ts`). Nothing outside this module and
 *    its statements ever sees the column names.
 *  - **Booleans are 0/1.** `cancel_requested` is
 *    `INTEGER CHECK (x IN (0, 1))`, so it comes back as a number.
 *
 * `checkpoint` and `batch_scopes` are optional on {@link JobDoc} and stay
 * optional here: a NULL column becomes an absent key rather than a `null` one,
 * so a job that never checkpointed serialises exactly as it did on Mongo.
 */

import type { JobKind, JobStatus, JobWithId } from '../schema.ts';
import { parseJson, toBool, toObjectId } from './values.ts';

/** The `jobs` columns, exactly as the table declares them. */
export interface JobRow {
  id: string;
  kind: JobKind;
  status: JobStatus;
  locked_by: string | null;
  lease_expires_at: string | null;
  cancel_requested: number;
  progress_current: number;
  progress_total: number;
  error: string | null;
  created_at: string;
  updated_at: string;
  params: string | null;
  result: string | null;
  ledger: string | null;
  batch_scopes: string | null;
}

/**
 * Snapshot returned by `claimJob` — enough for the runner to hand to a handler
 * without forcing the runner to re-query the row.
 */
export interface ClaimedJob {
  _id: ReturnType<typeof toObjectId>;
  kind: JobKind;
  payload: Record<string, unknown>;
  checkpoint?: Record<string, unknown>;
  progress: { current: number; total: number };
}

/** A JSON column as an object, or `undefined` when the column is NULL. */
function optionalObject(text: string | null): Record<string, unknown> | undefined {
  if (text === null) return undefined;
  return parseJson<Record<string, unknown>>(text, {});
}

/** A row as the document every existing consumer of the jobs repo expects. */
export function toJobDoc(row: JobRow): JobWithId {
  const checkpoint = optionalObject(row.ledger);
  const scopes = row.batch_scopes === null ? undefined : parseJson<string[]>(row.batch_scopes, []);
  return {
    _id: toObjectId(row.id),
    kind: row.kind,
    status: row.status,
    payload: row.params === null ? {} : parseJson<Record<string, unknown>>(row.params, {}),
    progress: { current: row.progress_current, total: row.progress_total },
    result:
      row.result === null ? null : parseJson<Record<string, unknown> | null>(row.result, null),
    error: row.error,
    locked_by: row.locked_by,
    lease_expires_at: row.lease_expires_at,
    cancel_requested: toBool(row.cancel_requested),
    created_at: row.created_at,
    updated_at: row.updated_at,
    ...(checkpoint === undefined ? {} : { checkpoint }),
    ...(scopes === undefined ? {} : { batch_scopes: scopes }),
  };
}

/** The claim snapshot, built from the row the compare-and-swap just won. */
export function toClaimedJob(row: JobRow): ClaimedJob {
  const checkpoint = optionalObject(row.ledger);
  return {
    _id: toObjectId(row.id),
    kind: row.kind,
    payload: row.params === null ? {} : parseJson<Record<string, unknown>>(row.params, {}),
    ...(checkpoint === undefined ? {} : { checkpoint }),
    progress: { current: row.progress_current, total: row.progress_total },
  };
}
