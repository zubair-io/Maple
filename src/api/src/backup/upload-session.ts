/**
 * upload_sessions repository.
 *
 * One row per in-flight or resumable chunked upload from a device. The resume
 * key is the natural compound key (library_id, device_id, phasset_local_id) —
 * all three are known to the device at enqueue, so the device can resume
 * without remembering an opaque session id. It is UNIQUE across every state,
 * which is why a closed session is reopened in place rather than replaced.
 *
 * Sessions expire: abandoned uploads older than 7d are swept and their state
 * flips to "abandoned". A subsequent retry starts fresh because `openOrResume`
 * filters for state "open".
 *
 * `openOrResume` is self-healing on same-key metadata mismatch — when the
 * device retries with a different total_bytes or target_rel_path (e.g. the
 * user edited the photo between attempts), the existing row is reset in
 * place instead of throwing.
 *
 * Cross-device coordination uses `phasset_cloud_id`: when two devices on the
 * same iCloud library both try to upload the same photo, the second one is
 * told to back off if the first is actively progressing (last chunk
 * received < CROSS_DEVICE_BUSY_WINDOW_MS ago). If the first is stale, it's
 * marked abandoned and the second takes over.
 *
 * Spec: .archived-plans/specs/2026-05-09-photokit-backup-design.md §16, §20.
 *
 * ## Where the queries went (#3787)
 *
 * The whole surface moved to `db/sqlite/repos/upload-sessions.repo.ts`, split
 * across that module, `upload-sessions.open.ts` (the decision tree behind
 * `openOrResume`) and `upload-sessions.rows.ts` (the row shape). This file is
 * the import path `routes/backup-ingest.ts`, `routes/backup-rendered.ts` and
 * `index.ts` already use, re-exported name by name so a changed signature is a
 * compile error rather than a silent substitution.
 *
 * Mongo's 7-day TTL index on `updated_at` has no SQLite equivalent, so the
 * table carries an `expires_at` column that every write touching `updated_at`
 * sets alongside it, for a periodic sweep to range scan. Nothing about the
 * rows' readability changed — `gcAbandoned` is still what the routes rely on.
 */

export {
  BusyElsewhereError,
  CROSS_DEVICE_BUSY_WINDOW_MS,
  uploadSessions,
  type OpenOrResumeArgs,
  type OpenOrResumeResult,
} from '../db/sqlite/repos/upload-sessions.repo.ts';
