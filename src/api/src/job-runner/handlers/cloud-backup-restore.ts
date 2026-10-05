import type { JobHandler } from './index.ts';
import { backupEngine } from '../../cloud-backup/runtime.ts';
import { recoverBackup, type RecoveryRequest } from '../../cloud-backup/restore.ts';
import type { BackupDestination } from '../../cloud-backup/repository.ts';

function recoverySelection(
  payload: Record<string, unknown>,
): Pick<RecoveryRequest, 'entryId' | 'sequence'> {
  const entryId = payload['entryId'];
  const sequence = payload['sequence'];
  if (entryId === undefined && sequence === undefined) return {};
  if (typeof entryId !== 'string' || !entryId)
    throw new Error('Invalid recovery version selection');
  if (typeof sequence !== 'number') throw new Error('Invalid recovery version selection');
  return { entryId, sequence };
}

function recoveryPayload(payload: Record<string, unknown>): {
  destinationId: string;
  request: RecoveryRequest;
} {
  if (
    typeof payload['destinationId'] !== 'string' ||
    typeof payload['targetPath'] !== 'string' ||
    typeof payload['includeTrash'] !== 'boolean'
  )
    throw new Error('Invalid recovery request');
  return {
    destinationId: payload['destinationId'],
    request: {
      targetPath: payload['targetPath'],
      includeTrash: payload['includeTrash'],
      ...recoverySelection(payload),
    },
  };
}
function requireRecoveryDestination(
  destination: BackupDestination | null,
): asserts destination is BackupDestination & { rootId: string; accountId: string } {
  if (
    !destination ||
    destination.kind !== 'google-drive' ||
    !destination.rootId ||
    !destination.accountId
  )
    throw new Error('Recovery destination unavailable');
}
export const cloudBackupRestoreHandler: JobHandler = {
  async run(payload, ctx) {
    const { destinationId, request } = recoveryPayload(payload);
    const destination = await backupEngine.repo.destination(destinationId);
    requireRecoveryDestination(destination);
    return recoverBackup(await backupEngine.provider(destination), request, ctx, {
      destinationId: destination.id,
      rootId: destination.rootId,
      accountId: destination.accountId,
    });
  },
};
