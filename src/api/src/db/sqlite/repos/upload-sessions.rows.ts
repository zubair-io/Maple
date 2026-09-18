/**
 * The `upload_sessions` row shape, the statements that read it, and the
 * conversion to the document the backup routes carry.
 *
 * Split out of `upload-sessions.repo.ts` so that file stays comfortably inside
 * the 600-line ceiling rather than a few lines under it — the headroom gate
 * (#2311) exists precisely because "just under" becomes the next author's
 * problem.
 *
 * Two conversions live here and nowhere else:
 *
 *  - **Cleared fields.** `maple_id`, `resolved_rel_path` and
 *    `phasset_cloud_id` are optional on `UploadSessionDoc` and NULLable
 *    columns here. {@link toUploadSession} emits an *absent key* for a NULL,
 *    not `undefined`, because both the routes and `openOrResume` branch on
 *    `=== undefined` and `JSON.stringify` drops an absent key exactly the way
 *    it dropped a missing Mongo field.
 *  - **Expiry.** The document's `created_at` / `updated_at` are BSON `Date`s
 *    because a Mongo TTL index swept them, and the TTL monitor ignores
 *    strings. The columns are ISO TEXT like every other timestamp in this
 *    schema, so the DTO converts on the way out, and {@link stamps} produces
 *    the `updated_at` / `expires_at` pair every write needs together.
 */

import type { UploadSessionDoc } from '../../schema.ts';
import { toDate, toObjectId } from './values.ts';

/**
 * How long a session stays sweepable after its last chunk. The Mongo TTL index
 * on `updated_at` declared `expireAfterSeconds: 7 * 24 * 3600`; the
 * `expires_at` column carries the same 7 days forward, because SQLite has no
 * TTL monitor and the sweep is an explicit periodic `DELETE`
 * (`docs/sqlite-schema.md` § "TTL indexes become a sweep").
 */
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;

/** The `upload_sessions` columns the DTO is built from. */
export interface UploadSessionRow {
  id: string;
  library_id: string;
  device_id: string;
  phasset_local_id: string;
  phasset_cloud_id: string | null;
  target_rel_path: string;
  resolved_rel_path: string | null;
  total_bytes: number;
  received_bytes: number;
  chunk_size: number;
  state: 'open' | 'completed' | 'abandoned';
  maple_id: string | null;
  created_at: string;
  updated_at: string;
}

const SESSION_COLUMNS = `
  id, library_id, device_id, phasset_local_id, phasset_cloud_id,
  target_rel_path, resolved_rel_path, total_bytes, received_bytes, chunk_size,
  state, maple_id, created_at, updated_at`;

export const BY_ID_SQL = `SELECT ${SESSION_COLUMNS} FROM upload_sessions WHERE id = ?`;

export const BY_RESUME_KEY_SQL = `
  SELECT ${SESSION_COLUMNS} FROM upload_sessions
   WHERE library_id = ? AND device_id = ? AND phasset_local_id = ?`;

/**
 * Another device's open session for the same iCloud photo.
 *
 * `phasset_cloud_id IS NOT NULL` is spelled out beside the equality so the
 * query's predicate textually implies the partial index's
 * (`WHERE state = 'open' AND phasset_cloud_id IS NOT NULL`); SQLite will not
 * use a partial index otherwise, and a bound `= ?` does not prove non-null.
 */
const PEER_FILTER = `
  library_id = ? AND phasset_cloud_id = ? AND phasset_cloud_id IS NOT NULL
  AND state = 'open' AND (device_id <> ? OR phasset_local_id <> ?)`;

export const NEWEST_PEER_SQL = `
  SELECT ${SESSION_COLUMNS} FROM upload_sessions
   WHERE ${PEER_FILTER} ORDER BY updated_at DESC LIMIT 1`;

export const ABANDON_PEERS_SQL = `
  UPDATE upload_sessions SET state = 'abandoned', updated_at = ?, expires_at = ?
   WHERE ${PEER_FILTER}`;

/** One row as the document the routes carry. */
export function toUploadSession(row: UploadSessionRow): UploadSessionDoc {
  return {
    _id: toObjectId(row.id),
    library_id: toObjectId(row.library_id),
    device_id: row.device_id,
    phasset_local_id: row.phasset_local_id,
    target_rel_path: row.target_rel_path,
    total_bytes: row.total_bytes,
    received_bytes: row.received_bytes,
    chunk_size: row.chunk_size,
    state: row.state,
    created_at: toDate(row.created_at),
    updated_at: toDate(row.updated_at),
    ...(row.resolved_rel_path === null ? {} : { resolved_rel_path: row.resolved_rel_path }),
    ...(row.maple_id === null ? {} : { maple_id: row.maple_id }),
    ...(row.phasset_cloud_id === null ? {} : { phasset_cloud_id: row.phasset_cloud_id }),
  };
}

/**
 * `updated_at` and the `expires_at` derived from it, as the columns store them.
 * Returned as a pair so no write can set one and forget the other.
 */
export function stamps(at: Date = new Date()): [string, string] {
  return [at.toISOString(), new Date(at.getTime() + SESSION_TTL_MS).toISOString()];
}
