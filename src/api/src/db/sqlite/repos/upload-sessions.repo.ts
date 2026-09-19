/**
 * `upload_sessions` — the SQLite port of `backup/upload-session.ts` (#3751).
 *
 * One row per in-flight or resumable chunked upload from a device. The resume
 * key is the natural compound key `(library_id, device_id, phasset_local_id)`,
 * all three of which the device knows at enqueue, so it can resume without
 * remembering an opaque session id. It is UNIQUE across every state, which is
 * why a closed session is reopened in place rather than replaced.
 *
 * The exported shape is the Mongo module's, method for method, so the cutover
 * (#3752) swaps the import path in `routes/backup-ingest.ts`,
 * `routes/backup-rendered.ts` and `index.ts` and nothing else. `dbOverride` is
 * the tests' seam and no route passes it.
 *
 * ## Layout
 *
 *   - `upload-sessions.rows.ts`  the row shape, its statements, row → document
 *   - `upload-sessions.open.ts`  `openOrResume`, the one verb with branching
 *   - `upload-sessions.repo.ts`  the verbs the backup routes call (this file)
 *
 * `openOrResume` keeps its public types, its `BusyElsewhereError` and the
 * cross-device window beside its implementation and they are re-exported here,
 * so a caller still imports the whole upload-session surface from this module.
 *
 * ## The TTL index becomes a column
 *
 * Mongo swept these rows with a 7-day TTL index on `updated_at`. SQLite has no
 * TTL monitor, so the table carries an `expires_at` column and an index over it
 * for a periodic `DELETE` to range scan (`docs/sqlite-schema.md` § "TTL indexes
 * become a sweep"). Every write that touches `updated_at` sets `expires_at`
 * with it — that is what {@link stamps} returning a pair enforces — so the two
 * can never disagree about when a row stops mattering. Nothing gets less safe:
 * the rows were already fully readable between TTL passes, which is why
 * {@link uploadSessions.gcAbandoned} exists and is what the routes rely on.
 */

import type { ObjectId } from '../../object-id.ts';
import type { UploadSessionDoc } from '../../schema.ts';
import { sqliteDb, type SqliteDb } from './db-handle.ts';
import {
  openOrResumeSession,
  readSessionRow,
  type OpenOrResumeArgs,
  type OpenOrResumeResult,
} from './upload-sessions.open.ts';
import { stamps, toUploadSession } from './upload-sessions.rows.ts';
import { toHex } from './values.ts';

export {
  BusyElsewhereError,
  CROSS_DEVICE_BUSY_WINDOW_MS,
  type OpenOrResumeArgs,
  type OpenOrResumeResult,
} from './upload-sessions.open.ts';

export const uploadSessions = {
  /**
   * Open a session for this upload, or hand back the one a previous attempt
   * left behind. The decision tree, and why each branch exists, is documented
   * on {@link openOrResumeSession}.
   */
  async openOrResume(args: OpenOrResumeArgs, dbOverride?: SqliteDb): Promise<OpenOrResumeResult> {
    return openOrResumeSession(sqliteDb(dbOverride), args);
  },

  async recordChunk(
    args: { sessionId: ObjectId; bytesReceived: number },
    dbOverride?: SqliteDb,
  ): Promise<void> {
    if (args.bytesReceived < 0) {
      throw new Error('uploadSessions.recordChunk: bytesReceived must be >= 0');
    }
    const [updatedAt, expiresAt] = stamps();
    await sqliteDb(dbOverride).write(
      `UPDATE upload_sessions
          SET received_bytes = received_bytes + ?, updated_at = ?, expires_at = ?
        WHERE id = ?`,
      [args.bytesReceived, updatedAt, expiresAt, toHex(args.sessionId)],
    );
  },

  async complete(
    args: {
      sessionId: ObjectId;
      mapleId: string;
      /**
       * The path the bytes actually landed at. Persisted only when it differs
       * from the session's device-computed `target_rel_path` (a disambiguated
       * collision), so the `alreadyComplete` short-circuit can hand a retrying
       * device the real location.
       */
      resolvedRelPath?: string;
    },
    dbOverride?: SqliteDb,
  ): Promise<void> {
    const db = sqliteDb(dbOverride);
    const hex = toHex(args.sessionId);
    const [updatedAt, expiresAt] = stamps();

    if (args.resolvedRelPath === undefined) {
      await db.write(
        `UPDATE upload_sessions
            SET state = 'completed', maple_id = ?, updated_at = ?, expires_at = ?
          WHERE id = ?`,
        [args.mapleId, updatedAt, expiresAt, hex],
      );
      return;
    }

    // Only store a divergent resolved path; a session whose bytes landed at the
    // computed path keeps `resolved_rel_path` unset, and any stale value from a
    // prior differently-resolved attempt on the same key is cleared.
    const existing = await readSessionRow(db, hex);
    const resolved =
      existing !== null && args.resolvedRelPath !== existing.target_rel_path
        ? args.resolvedRelPath
        : null;
    await db.write(
      `UPDATE upload_sessions
          SET state = 'completed', maple_id = ?, resolved_rel_path = ?,
              updated_at = ?, expires_at = ?
        WHERE id = ?`,
      [args.mapleId, resolved, updatedAt, expiresAt, hex],
    );
  },

  async findById(id: ObjectId, dbOverride?: SqliteDb): Promise<UploadSessionDoc | null> {
    const row = await readSessionRow(sqliteDb(dbOverride), toHex(id));
    return row === null ? null : toUploadSession(row);
  },

  /**
   * Reset `received_bytes` to 0 when disk and database are out of sync (the tmp
   * file was deleted). The client must restart from offset 0.
   */
  async resetForRestart(sessionId: ObjectId, dbOverride?: SqliteDb): Promise<void> {
    const [updatedAt, expiresAt] = stamps();
    await sqliteDb(dbOverride).write(
      `UPDATE upload_sessions SET received_bytes = 0, updated_at = ?, expires_at = ?
        WHERE id = ?`,
      [updatedAt, expiresAt, toHex(sessionId)],
    );
  },

  /**
   * Bulk-zero `received_bytes` on every open row that claims progress. Paired
   * with `clearBackupChunkDir()` at API startup: the on-disk `.part` files were
   * just deleted, so a row that still believes its bytes are on disk is now
   * lying — a client retry would hit the `start !== received_bytes` 409 path
   * and, with `received_bytes == total`, fall out of the client's upload loop.
   *
   * Returns the number of rows reset, for logging.
   */
  async resetAllInProgressBytes(dbOverride?: SqliteDb): Promise<number> {
    const [updatedAt, expiresAt] = stamps();
    const result = await sqliteDb(dbOverride).write(
      `UPDATE upload_sessions SET received_bytes = 0, updated_at = ?, expires_at = ?
        WHERE state = 'open' AND received_bytes > 0`,
      [updatedAt, expiresAt],
    );
    return result.changes;
  },

  /**
   * Mark open sessions whose `updated_at` is older than `cutoff` as abandoned.
   * Returns the number of rows updated. Called by a periodic job / at startup.
   *
   * `updated_at` is ISO 8601 in UTC, which sorts lexically, so the comparison
   * against `cutoff.toISOString()` is the same range scan the Mongo `$lt` was.
   */
  async gcAbandoned(cutoff: Date, dbOverride?: SqliteDb): Promise<number> {
    const result = await sqliteDb(dbOverride).write(
      `UPDATE upload_sessions SET state = 'abandoned'
        WHERE state = 'open' AND updated_at < ?`,
      [cutoff.toISOString()],
    );
    return result.changes;
  },
};
