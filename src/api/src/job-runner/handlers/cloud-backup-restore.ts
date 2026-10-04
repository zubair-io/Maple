import type { JobHandler } from './index.ts';
import { backupEngine } from '../../cloud-backup/runtime.ts';
import { recoverBackup } from '../../cloud-backup/restore.ts';

export const cloudBackupRestoreHandler: JobHandler = {
  async run(payload, ctx) {
    if (
      typeof payload['destinationId'] !== 'string' ||
      typeof payload['targetPath'] !== 'string' ||
      typeof payload['includeTrash'] !== 'boolean'
    )
      throw new Error('Invalid recovery request');
    const destination = await backupEngine.repo.destination(payload['destinationId']);
    if (
      !destination ||
      destination.kind !== 'google-drive' ||
      !destination.rootId ||
      !destination.accountId
    )
      throw new Error('Recovery destination unavailable');
    return recoverBackup(
      await backupEngine.provider(destination),
      {
        targetPath: payload['targetPath'],
        includeTrash: payload['includeTrash'],
        ...(typeof payload['entryId'] === 'string' && typeof payload['sequence'] === 'number'
          ? { entryId: payload['entryId'], sequence: payload['sequence'] }
          : {}),
      },
      ctx,
      {
        destinationId: destination.id,
        rootId: destination.rootId,
        accountId: destination.accountId,
      },
    );
  },
};
