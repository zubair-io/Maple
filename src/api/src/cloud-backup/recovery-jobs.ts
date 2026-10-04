import { sqliteDb, type SqliteDb } from '../db/repos/db-handle.ts';

/** Keep the same job identity, pinned checkpoint and filesystem ownership journal. */
export async function resumeRecoveryJob(
  destinationId: string,
  jobId: string,
  override?: SqliteDb,
): Promise<boolean> {
  const result = await sqliteDb(override).write(
    `UPDATE jobs SET status='queued',cancel_requested=0,
    locked_by=NULL,lease_expires_at=NULL,error=NULL,result=NULL,updated_at=?
    WHERE id=? AND kind='cloud_backup_restore' AND json_extract(params,'$.destinationId')=?
    AND status IN ('failed','cancelled')`,
    [new Date().toISOString(), jobId, destinationId],
  );
  return result.changes === 1;
}
