/**
 * `backup_sessions` — one row per (library, device) summarising cumulative
 * PhotoKit backup progress, so a device can render "X% done from this device"
 * without scanning the assets table.
 *
 * The body lives in `repos/backup-sessions.repo.ts`; this file is the import
 * surface its callers name. See `assets.repo.ts` for why the re-export is
 * named rather than a star.
 *
 * Both methods gained an optional `dbOverride` tail parameter, which no
 * production caller passes. `findOne` now returns a `BackupSessionDoc | null`
 * rather than the driver's `WithId<BackupSessionDoc> | null`; the fields
 * callers read are the same.
 *
 * One storage difference worth knowing: a row created without a `totalCount`
 * gets `0` rather than no field at all, because the column is
 * `NOT NULL DEFAULT 0`. Every reader already treats a missing total as
 * "unknown — show the counters", so the two are equivalent at the call sites.
 */

export { backupSessionsRepo } from './repos/backup-sessions.repo.ts';
