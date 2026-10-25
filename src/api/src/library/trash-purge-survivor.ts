/**
 * The purge branch for a trashed photo that still has another copy (#5403).
 * Both purge surfaces try this first: when it keeps the photo, only the
 * trashed copy, its sidecars and its own backups are erased, and the photo
 * returns to the library through its surviving copy with every other backup
 * intact.
 *
 * Apple companions are recorded relative to the library of the photo's
 * canonical location. They stay with the survivor unless the trashed copy was
 * canonical and the survivor is in another library: then they sit beside the
 * trashed copy's original folder, would resolve against the wrong library
 * once the survivor becomes canonical, and are erased with the trashed copy.
 * They never move between libraries.
 *
 * The files to unlink are recorded as obligations in the same transaction
 * that takes the photo out of Trash, then drained (`local-purge-drain.ts`),
 * so a failed unlink or a crash in between is retried rather than orphaned.
 */

import * as path from 'node:path';
import { appleCompanionPaths } from '../db/apple-companions.ts';
import type { ObjectId } from '../db/object-id.ts';
import { recordAndPublishAssetChange } from '../db/repos/changes.repo.ts';
import { keepSurvivingCopy } from '../db/repos/assets.trash-survivor.ts';
import type { LocalPurgeTarget } from '../db/repos/local-purge.repo.ts';
import { inventoryFolderPurges } from '../cloud-backup/folder-purge-inventory.ts';
import { BackupRepository } from '../cloud-backup/repository.ts';
import { capturedTrashPurge } from '../cloud-backup/trash-purge-admission.ts';
import { errnoCode } from '../fs/relocate-publish.ts';
import { listPairedSidecarsStrict } from '../fs/xmp-conflict.ts';
import { drainLocalPurges } from './local-purge-drain.ts';
import type { CopyAddress, TrashedCopy } from './trashed-copy.ts';

export type SurvivorPurgeOutcome =
  | { kind: 'kept'; survivor: CopyAddress; pendingCleanup: number }
  | { kind: 'changed' }
  | { kind: 'retry'; error: unknown }
  | { kind: 'full-purge' };

type PurgeInfo = Parameters<typeof capturedTrashPurge>[0];

function companionsLeaveWithTrashedCopy(
  info: PurgeInfo,
  copy: TrashedCopy,
  survivor: CopyAddress,
): boolean {
  return (
    copy.isPrimary &&
    !survivor.libraryId.equals(copy.location.library_id) &&
    appleCompanionPaths(info).length > 0
  );
}

const posixRelative = (root: string, target: string): string =>
  path.relative(root, target).split(path.sep).join('/');

/** Everything the purge owes the disk: the trashed copy, its sidecars, and
 * the companions when they leave with it. Recorded before any unlink. */
async function cleanupTargets(
  info: PurgeInfo,
  copy: TrashedCopy,
  dropCompanions: boolean,
): Promise<LocalPurgeTarget[]> {
  const ownerRelPath = posixRelative(copy.libraryRoot, copy.absPath);
  const sidecars = await listPairedSidecarsStrict(copy.absPath).catch((error: unknown) => {
    if (errnoCode(error) === 'ENOENT') return [];
    throw error;
  });
  const trashFiles = [copy.absPath, ...sidecars].map((target) => ({
    relPath: posixRelative(copy.libraryRoot, target),
    ownerRelPath,
    kind: 'trash' as const,
  }));
  const companions = dropCompanions
    ? appleCompanionPaths(info).map((relPath) => ({
        relPath,
        ownerRelPath: relPath,
        kind: 'companion' as const,
      }))
    : [];
  return [...trashFiles, ...companions];
}

export async function purgeKeepingSurvivor(
  id: ObjectId,
  info: PurgeInfo,
  copy: TrashedCopy,
): Promise<SurvivorPurgeOutcome> {
  const survivor = copy.survivor;
  if (survivor === null) return { kind: 'full-purge' };
  const dropCompanions = companionsLeaveWithTrashedCopy(info, copy, survivor);
  const trashed = {
    libraryId: copy.location.library_id,
    path: copy.location.path,
    filename: copy.location.filename,
  };
  const prepared = await Promise.all([
    inventoryFolderPurges(id.toHexString(), new BackupRepository(), {
      libraryId: trashed.libraryId.toHexString(),
      relativePath: trashed.path === '' ? trashed.filename : `${trashed.path}/${trashed.filename}`,
      withCompanions: dropCompanions,
    }),
    cleanupTargets(info, copy, dropCompanions),
  ]).catch((error: unknown) => ({ error }));
  if ('error' in prepared) return { kind: 'retry', error: prepared.error };

  const outcome = await keepSurvivingCopy({
    id,
    trashed,
    expected: capturedTrashPurge(info),
    dropCompanions,
    cleanup: prepared[1],
  });
  if (outcome === 'purge-in-flight') return { kind: 'full-purge' };
  if (outcome === 'changed') return { kind: 'changed' };
  const { pending } = await drainLocalPurges({ assetId: id.toHexString() });
  await recordAndPublishAssetChange({
    kind: 'restore',
    asset_id: id,
    folder_id: survivor.libraryId,
    abs_path: survivor.absPath,
  });
  return { kind: 'kept', survivor, pendingCleanup: pending };
}
