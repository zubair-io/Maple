import {
  defineStage,
  runStage,
  type ImageDoc,
  type StageContext,
  type StageResult,
} from '../run-stage.ts';
import { backupEngine } from '../../cloud-backup/runtime.ts';

async function cloudBackupHandler(image: ImageDoc, ctx: StageContext): Promise<StageResult> {
  const success = await backupEngine.backupAsset(image._id.toHexString(), ctx.signal);
  return success
    ? { wrote: true }
    : {
        defer: {
          reason: 'Backup destination pending or requires reconnect',
          retryAt: new Date(Date.now() + 60_000),
        },
      };
}
const cloudBackupStage = defineStage({
  name: 'cloud-backup',
  targetVersion: 1,
  dependsOn: [],
  defaults: {
    concurrency: 1,
    maxAttempts: 5,
    paused: false,
    last_seen_target_version: 0,
    pausedOnFirstBoot: true,
  },
  // Include readable damaged originals and indexed Trash. Missing locations
  // and reaped rows are not evidence for remote deletion or backup success.
  claimResidual: {
    sql: `EXISTS (SELECT 1 FROM asset_locations l JOIN backup_destinations d
    ON d.library_id=l.library_id JOIN assets a ON a.id=l.asset_id WHERE l.asset_id=stage_state.asset_id
    AND d.kind='google-drive' AND d.enabled=1 AND l.deleted_at IS NULL AND l.missing_since IS NULL
    AND a.deleted_reason IS NULL)`,
    params: [],
  },
  handler: cloudBackupHandler,
});
export default cloudBackupStage;
export async function startCloudBackupStage() {
  return runStage(cloudBackupStage);
}
